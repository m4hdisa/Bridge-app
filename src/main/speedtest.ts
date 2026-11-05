// Measures a server's real speed against Cloudflare's speed test, the way a browser would:
// several connections at once, ignoring the first moments while they speed up. It can reach
// the server two ways (see SpeedPath), and the difference shows what the VPN adapter costs.
import { randomBytes } from 'node:crypto'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { SPEED_TEST_PORTS } from './config'
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
export function socksDialer(port: number, host = HOST, targetPort = 443): Dialer {
  return async () => {
    const s = await opened(tcpConnect({ host: '127.0.0.1', port }))
    s.write(Buffer.from([5, 1, 0]))
    if ((await readExactly(s, 2))[1] !== 0) throw new Error('SOCKS refused')
    const name = Buffer.from(host)
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 255])]))
    const head = await readExactly(s, 4)
    if (head[1] !== 0) throw new Error(`The VPN server could not reach the test server (SOCKS ${head[1]})`)
    await readExactly(s, (head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readExactly(s, 1))[0]) + 2)
    return s
  }
}

let nextPort = SPEED_TEST_PORTS.first + Math.floor(Math.random() * (SPEED_TEST_PORTS.last - SPEED_TEST_PORTS.first))

/**
 * Like an app, through the VPN adapter: sing-box sends connections from these source ports to the
 * VPN. `findAddress` must not depend on Windows' DNS, which in FakeIP mode (or from another tool)
 * answers with an address that means nothing outside that tool.
 */
export function adapterDialer(findAddress: (host: string) => Promise<string | undefined>): Dialer {
  let address: Promise<string | undefined> | undefined
  return async () => {
    // Several connections start at once; they share one lookup.
    address ??= findAddress(HOST)
    const ip = await address
    if (!ip) throw new Error('Could not find the test server\'s address')
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

// A quick reading, enough to rank WARP configs against each other without burning a data plan.
const QUICK_DOWN_BYTES = 8_000_000
const QUICK_UP_BYTES = 3_000_000
const QUICK_DOWN_MS = 3000
const QUICK_UP_MS = 8000
const QUICK_WARMUP_MS = 500
/** Cloudflare answers HTTP 429 to WARP's shared exit addresses when they have asked too much; these others don't. */
const QUICK_SOURCES = [
  { host: HOST, path: `/__down?bytes=${QUICK_DOWN_BYTES}` },
  { host: 'cachefly.cachefly.net', path: '/10mb.test' },
  { host: 'proof.ovh.net', path: '/files/10Mb.dat' }
]

/** One TLS connection through the local SOCKS port, which ends when the server closes it or at `deadlineMs`. */
function quickSocket(port: number, host: string, start: (s: TLSSocket) => void, onData: (d: Buffer) => void, deadlineMs: number): Promise<void> {
  return socksDialer(port, host)().then(
    (raw) =>
      new Promise<void>((resolve) => {
        const s = tlsConnect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'] })
        const end = () => {
          clearTimeout(timer)
          s.destroy()
          raw.destroy()
          resolve()
        }
        const timer = setTimeout(end, deadlineMs)
        s.once('secureConnect', () => start(s))
        s.on('data', onData)
        s.once('error', end)
        s.once('close', end)
      })
  )
}

/** Download speed from one source: the bytes after a short warm-up. Undefined if it refuses or sends nothing. */
async function quickGet(port: number, host: string, path: string, deadlineMs = QUICK_DOWN_MS): Promise<number | undefined> {
  let head: Buffer | undefined = Buffer.alloc(0)
  let refused = false
  let bytes = 0
  let firstAt = 0
  let mark: { at: number; bytes: number } | undefined
  let lastAt = 0
  await quickSocket(
    port,
    host,
    (s) => s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Bridge\r\nAccept: */*\r\nConnection: close\r\n\r\n`),
    (d) => {
      let body = d.length
      if (head) {
        head = Buffer.concat([head, d])
        const end = head.indexOf('\r\n\r\n')
        if (end < 0) return
        const code = Number(head.subarray(0, end).toString().split(' ')[1])
        refused = code < 200 || code >= 300
        body = head.length - end - 4
        head = undefined
      }
      if (refused) return
      lastAt = performance.now()
      firstAt ||= lastAt
      bytes += body
      if (!mark && lastAt - firstAt >= QUICK_WARMUP_MS) mark = { at: lastAt, bytes }
    },
    deadlineMs
  )
  if (refused || !bytes || lastAt <= firstAt) return undefined
  // A transfer over before the warm-up ended leaves only the whole of it to go on.
  const from = mark && lastAt > mark.at ? mark : { at: firstAt, bytes: 0 }
  return ((bytes - from.bytes) * 8) / (lastAt - from.at) / 1000
}

/**
 * Upload speed: from the first byte sent until the server says it has them all. Counting what was
 * handed to the connection would be wrong this quickly, because the local tunnel buffers it.
 */
async function quickPost(port: number): Promise<number | undefined> {
  let startAt = 0
  let doneAt = 0
  await quickSocket(
    port,
    HOST,
    (s) => {
      s.write(`POST /__up HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: Bridge\r\nContent-Type: application/octet-stream\r\nContent-Length: ${QUICK_UP_BYTES}\r\nConnection: close\r\n\r\n`)
      startAt = performance.now()
      let left = QUICK_UP_BYTES
      const pump = () => {
        while (left > 0 && !s.destroyed) {
          const chunk = left >= UP_CHUNK.length ? UP_CHUNK : UP_CHUNK.subarray(0, left)
          left -= chunk.length
          if (!s.write(chunk)) return void s.once('drain', pump)
        }
      }
      pump()
    },
    (d) => {
      if (!doneAt && /^HTTP\/1\.1 2/.test(d.toString('latin1', 0, 12))) doneAt = performance.now()
    },
    QUICK_UP_MS
  )
  return doneAt > startAt ? (QUICK_UP_BYTES * 8) / (doneAt - startAt) / 1000 : undefined
}

/** A quick reading through one local SOCKS port. A direction that fails just stays unknown. */
export async function quickSpeed(port: number): Promise<{ downMbps?: number; upMbps?: number }> {
  let down: number | undefined
  for (const { host, path } of QUICK_SOURCES) {
    down = await quickGet(port, host, path).catch(() => undefined)
    if (down) break
  }
  const up = await quickPost(port).catch(() => undefined)
  return { downMbps: down && Math.round(down), upMbps: up && Math.round(up) }
}

/** Download only, for trying many servers, in Mbps. A server that goes quiet just gives no reading. */
export async function quickDown(port: number, bytes: number, deadlineMs: number): Promise<number | undefined> {
  const from = (host: string, path: string, ms: number) => withDeadline(quickGet(port, host, path, ms), ms + 5000).catch(() => undefined)
  const down = (await from(HOST, `/__down?bytes=${bytes}`, deadlineMs)) ?? (await from(QUICK_SOURCES[1].host, QUICK_SOURCES[1].path, Math.min(deadlineMs, 1500)))
  return down && Math.round(down * 10) / 10
}

/**
 * The country traffic leaves from, asked over HTTPS with the certificate checked. Undefined when
 * neither source answers, so also when the server tampers with HTTPS or doesn't really carry traffic.
 */
export async function quickExit(port: number): Promise<string | undefined> {
  const ask = async (host: string, path: string, read: (body: string) => string | undefined) => {
    let text = ''
    await quickSocket(port, host, (s) => s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Bridge\r\nAccept: */*\r\nConnection: close\r\n\r\n`), (d) => (text += d.toString('latin1')), 6000)
    const code = read(text)
    return code && /^[A-Za-z]{2}$/.test(code) && code.toUpperCase() !== 'XX' ? code.toUpperCase() : undefined
  }
  const trace = () => ask('www.cloudflare.com', '/cdn-cgi/trace', (b) => b.match(/^loc=(\w+)/m)?.[1])
  const country = () => ask('api.country.is', '/', (b) => b.match(/"country"\s*:\s*"(\w+)"/)?.[1])
  return (await withDeadline(trace()).catch(() => undefined)) ?? (await withDeadline(country()).catch(() => undefined))
}

/** A server that accepts the local connection and then says nothing must not hold up the test. */
function withDeadline<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(resolve, reject).finally(() => clearTimeout(timer))
  })
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
