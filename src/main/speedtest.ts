// Measures a server's real speed against Cloudflare's speed test, the way a browser would:
// several connections at once, ignoring the first moments while they speed up. It can reach
// the server two ways (see SpeedPath), and the difference shows what the VPN adapter costs.
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { SPEED_TEST_PORTS } from './config'
import { isBogusAddress } from './resolve'
import type { SpeedResult } from '../shared/types'

const HOST = 'speed.cloudflare.com'
const DIAL_TIMEOUT_MS = 15_000
/** How long the first byte may take before the server counts as not answering. */
const FIRST_BYTE_MS = 20_000

export interface Measure {
  streams: number
  /** How long to measure after the first byte arrives, warm-up included. */
  durationMs: number
  /** The first moments, while the connections speed up, don't count. */
  warmupMs: number
  /** Stops early once this much data was used, so a very fast link doesn't burn a data plan. */
  maxBytes: number
}

export const DOWNLOAD: Measure = { streams: 4, durationMs: 6000, warmupMs: 1500, maxBytes: 150_000_000 }
export const UPLOAD: Measure = { streams: 2, durationMs: 4000, warmupMs: 1000, maxBytes: 30_000_000 }
const DOWN_REQUEST_BYTES = 50_000_000
const UP_REQUEST_BYTES = 10_000_000
const UP_CHUNK = randomBytes(64 * 1024)

/** Opens a TCP connection that reaches the test server on port 443. */
export type Dialer = () => Promise<Socket>

function opened(s: Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => s.destroy(new Error('Connecting timed out')), DIAL_TIMEOUT_MS)
    s.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    s.once('connect', () => {
      clearTimeout(timer)
      s.removeAllListeners('error')
      // A later error also closes the socket, which is what the users of it watch for.
      s.on('error', () => undefined)
      resolve(s)
    })
  })
}

function readExactly(s: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tryRead = () => {
      const chunk = s.read(n) as Buffer | null
      if (!chunk) return
      s.off('readable', tryRead)
      s.off('error', reject)
      s.off('close', onClose)
      resolve(chunk)
    }
    const onClose = () => reject(new Error('The local SOCKS connection closed'))
    s.on('readable', tryRead)
    s.once('error', reject)
    s.once('close', onClose)
    tryRead()
  })
}

/** Into sing-box through its SOCKS port. The name goes along, so the VPN server looks it up. */
export function socksDialer(port: number, host = HOST): Dialer {
  return async () => {
    const s = await opened(tcpConnect({ host: '127.0.0.1', port }))
    s.write(Buffer.from([5, 1, 0]))
    if ((await readExactly(s, 2))[1] !== 0) throw new Error('SOCKS refused')
    const name = Buffer.from(host)
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([1, 187])]))
    const head = await readExactly(s, 4)
    if (head[1] !== 0) throw new Error(`The VPN server could not reach the test server (SOCKS ${head[1]})`)
    await readExactly(s, (head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readExactly(s, 1))[0]) + 2)
    return s
  }
}

let nextPort = SPEED_TEST_PORTS.first + Math.floor(Math.random() * (SPEED_TEST_PORTS.last - SPEED_TEST_PORTS.first))

/** Like an app, through the VPN adapter: sing-box sends connections from these source ports to the VPN. */
export function adapterDialer(): Dialer {
  let ip: string | undefined
  return async () => {
    if (!ip) {
      const found = await lookup(HOST, { family: 4 })
      if (isBogusAddress(found.address)) throw new Error(`Windows got a censored address for ${HOST} (${found.address})`)
      ip = found.address
    }
    for (let tries = 0; ; tries++) {
      nextPort = nextPort >= SPEED_TEST_PORTS.last ? SPEED_TEST_PORTS.first : nextPort + 1
      try {
        return await opened(tcpConnect({ host: ip, port: 443, localPort: nextPort, family: 4 }))
      } catch (e) {
        // That port may still be held by the previous run's connection for a moment.
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || tries >= 20) throw e
      }
    }
  }
}

/** Download: bytes received. Upload: bytes handed over. Resolves when the connection ends. */
function transfer(dial: Dialer, upload: boolean, count: (n: number) => void, stopped: () => boolean, track: (s: Socket) => void): Promise<void> {
  return dial().then(
    (raw) =>
      new Promise<void>((resolve, reject) => {
        const s = tlsConnect({ socket: raw, servername: HOST, ALPNProtocols: ['http/1.1'] })
        track(s)
        const request = upload
          ? `POST /__up HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: Bridge\r\nContent-Type: application/octet-stream\r\nContent-Length: ${UP_REQUEST_BYTES}\r\nConnection: close\r\n\r\n`
          : `GET /__down?bytes=${DOWN_REQUEST_BYTES} HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: Bridge\r\nAccept: */*\r\nConnection: close\r\n\r\n`
        let head: Buffer | undefined = Buffer.alloc(0)
        const finish = (e?: Error) => {
          s.destroy()
          raw.destroy()
          if (e && !stopped()) reject(e)
          else resolve()
        }
        s.once('secureConnect', () => {
          s.write(request)
          if (!upload) return
          let left = UP_REQUEST_BYTES
          const pump = () => {
            if (stopped() || left <= 0 || s.destroyed) return
            const chunk = left >= UP_CHUNK.length ? UP_CHUNK : UP_CHUNK.subarray(0, left)
            left -= chunk.length
            s.write(chunk, () => {
              count(chunk.length)
              pump()
            })
          }
          pump()
        })
        s.on('data', (d: Buffer) => {
          if (!head) {
            if (!upload) count(d.length)
            return
          }
          head = Buffer.concat([head, d])
          const end = head.indexOf('\r\n\r\n')
          if (end < 0) return
          const code = Number(head.subarray(0, end).toString().split(' ')[1])
          if (code < 200 || code >= 300) return finish(new Error(`The test server answered HTTP ${code}`))
          if (!upload) count(head.length - end - 4)
          head = undefined
        })
        s.once('error', finish)
        s.once('close', () => finish())
      })
  )
}

export interface MeasureHooks {
  onMbps?: (mbps: number) => void
  /** Runs a moment after the first byte; a returned message stops the test as failed. */
  verify?: () => Promise<string | undefined>
  signal?: AbortSignal
}

export interface Measured {
  mbps: number
  usedBytes: number
}

/** Average speed from a counter's samples, skipping the warm-up. */
export function averageMbps(samples: { at: number; bytes: number }[], warmupMs: number): number {
  const last = samples.at(-1)
  if (!last) return 0
  const first = samples[0]
  // Prefer a start after the warm-up; a cap reached earlier leaves only the whole run to go on.
  const start = samples.find((s) => s.at - first.at >= warmupMs && s !== last) ?? first
  const ms = last.at - start.at
  return ms > 0 ? ((last.bytes - start.bytes) * 8) / ms / 1000 : 0
}

export async function measure(dial: Dialer, upload: boolean, m: Measure, hooks: MeasureHooks = {}): Promise<Measured> {
  let bytes = 0
  let firstAt = 0
  let stop = false
  let workerError: Error | undefined
  let problem: string | undefined
  const sockets = new Set<Socket>()
  const samples: { at: number; bytes: number }[] = []
  const halt = () => {
    stop = true
    for (const s of sockets) s.destroy()
  }
  hooks.signal?.addEventListener('abort', halt)

  const count = (n: number) => {
    if (n <= 0) return
    bytes += n
    if (firstAt) return
    firstAt = performance.now()
    samples.push({ at: firstAt, bytes })
    if (hooks.verify) {
      setTimeout(() => {
        void hooks.verify?.().then((found) => {
          if (found && !stop) {
            problem = found
            halt()
          }
        })
      }, 1000)
    }
  }
  const startedAt = performance.now()
  let lastTick = { at: startedAt, bytes: 0 }
  const ticker = setInterval(() => {
    const at = performance.now()
    if (firstAt) samples.push({ at, bytes })
    if (at > lastTick.at) hooks.onMbps?.(((bytes - lastTick.bytes) * 8) / (at - lastTick.at) / 1000)
    lastTick = { at, bytes }
    const timedOut = firstAt ? at - firstAt >= m.durationMs : at - startedAt >= FIRST_BYTE_MS
    if (timedOut || bytes >= m.maxBytes) halt()
  }, 250)

  const worker = async () => {
    let failures = 0
    while (!stop) {
      const before = bytes
      try {
        await transfer(dial, upload, count, () => stop, (s) => {
          sockets.add(s)
          s.once('close', () => sockets.delete(s))
          if (stop) s.destroy()
        })
      } catch (e) {
        workerError ??= e instanceof Error ? e : new Error(String(e))
        if (++failures >= 3) return
        await new Promise((r) => setTimeout(r, 300))
      }
      if (bytes > before) failures = 0
    }
  }
  await Promise.all(Array.from({ length: m.streams }, worker))
  clearInterval(ticker)
  hooks.signal?.removeEventListener('abort', halt)
  stop = true

  if (firstAt) samples.push({ at: performance.now(), bytes })
  if (hooks.signal?.aborted) throw new Error('Stopped')
  if (problem) throw new Error(problem)
  // A connection that dropped while others carried on doesn't fail the test.
  if (!firstAt) throw workerError ?? new Error('The test server did not answer')
  return { mbps: averageMbps(samples, m.warmupMs), usedBytes: bytes }
}

export type PathProgress = (phase: 'download' | 'upload', mbps: number) => void

/** Download, then upload. An upload that fails doesn't lose the download's number. */
export async function runPath(dial: Dialer, onProgress: PathProgress, verify?: MeasureHooks['verify'], signal?: AbortSignal): Promise<SpeedResult> {
  const result: SpeedResult = { usedBytes: 0 }
  try {
    const down = await measure(dial, false, DOWNLOAD, { onMbps: (v) => onProgress('download', v), verify, signal })
    result.downMbps = down.mbps
    result.usedBytes += down.usedBytes
  } catch (e) {
    if (signal?.aborted) throw e
    result.error = e instanceof Error ? e.message : String(e)
    return result
  }
  try {
    const up = await measure(dial, true, UPLOAD, { onMbps: (v) => onProgress('upload', v), signal })
    result.upMbps = up.mbps
    result.usedBytes += up.usedBytes
  } catch (e) {
    if (signal?.aborted) throw e
    result.error = e instanceof Error ? e.message : String(e)
  }
  return result
}
