// Runs sing-box as a child process and talks to it through its Clash API.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildConfig, buildHelperConfig, buildTestConfig, processPathRegex, withServerIp, writeAppRuleSets, type ClashApi } from './config'
import { connect } from 'node:net'
import { pickDirectDns, ServerResolver } from './resolve'
import { buildXrayConfig, xrayServer, xrayWithServerIp, type XrayOutbound } from './xray'
import { GOOL_RETRY_MS, isWarp, parseWarpLine, prefersForeignExit, WARP_IDENTITY_FILE, WARP_NO_IPV6, WARP_REGISTER_TRIES, WARP_STATE_FILE, waitForGool, warpArgs, warpExitCountry, warpGateway, warpLabel, warpMethods, warpReady, warpRegisterArgs, type WarpState } from './warp'
import { clearSystemProxy, flushDns, freePort, networkInfo, setSystemProxy } from './system'
import { usesTun } from '../shared/types'
import type { AppRoute, AppRule, AppTraffic, CoreStatus, HealthCheck, LogLine, ServerProfile, Settings, TrafficStats, WarpFound, WarpMethod } from '../shared/types'

export interface CorePaths {
  singBox: string
  rulesDir: string
  /** Folder for generated configs, cache and working files. */
  dataDir: string
  /** Set to false to never touch the Windows proxy setting (used by tests). Default true. */
  manageSystemProxy?: boolean
  /** xray.exe, for servers only Xray can run. */
  xray?: string
  /** aether.exe, for the built-in free WARP server. */
  aether?: string
}

function socksOutbound(port: number): ServerProfile['outbound'] {
  return { type: 'socks', server: '127.0.0.1', server_port: port, version: '5' } as unknown as ServerProfile['outbound']
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

async function killProcess(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.removeAllListeners('exit')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill()
  })
}

interface ClashConnection {
  id: string
  upload: number
  download: number
  chains?: string[]
  metadata: { processPath?: string }
}

/** Thrown when the user disconnects while Bridge is still connecting. */
class Cancelled extends Error {
  constructor() {
    super('Connecting was cancelled')
  }
}

const MAX_LOGS = 1000
/** How long one WARP method may take to find a gateway and prove the tunnel works. */
const WARP_ATTEMPT_MS = 75_000
/** How long a saved config's gateway gets to answer before Bridge scans for another. */
const WARP_PEER_MS = 25_000
/** Once another method works, how long Auto still waits for Gool (whose exit is outside Iran). */
const WARP_PREFER_WAIT_MS = 30_000

interface WarpWinner {
  method: WarpMethod
  port: number
  child: ChildProcess
  /** Exit country Aether reported for the tunnel, e.g. "DE". */
  exit?: string
  /** The Cloudflare gateway the tunnel runs on, "ip:port". */
  peer?: string
  readyMs: number
}
const HEALTH_INTERVAL_MS = 20000
/** How long to give sing-box to notice a changed rule-set file before resetting connections. */
const RULE_RELOAD_DELAY_MS = 1500

async function clashDelete(api: ClashApi, path: string): Promise<void> {
  await fetch(`http://127.0.0.1:${api.port}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${api.secret}` },
    signal: AbortSignal.timeout(3000)
  })
}

async function clashGet<T>(api: ClashApi, path: string, timeoutMs = 3000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
    headers: { Authorization: `Bearer ${api.secret}` },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`Clash API ${path}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** Starts a sing-box process and resolves once its Clash API answers. */
async function launch(singBox: string, configFile: string, workDir: string, api: ClashApi, onLine: (line: string, isErr: boolean) => void): Promise<ChildProcess> {
  const child = spawn(singBox, ['run', '-c', configFile, '-D', workDir], { windowsHide: true })
  const feed = (isErr: boolean) => {
    let buf = ''
    return (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const l of lines) if (l.trim()) onLine(l, isErr)
    }
  }
  child.stdout?.on('data', feed(false))
  child.stderr?.on('data', feed(true))

  let exited = false
  child.once('exit', () => (exited = true))
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (exited) throw new Error('sing-box exited during startup (see Logs)')
    try {
      await clashGet(api, '/version', 1000)
      return child
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  child.kill()
  throw new Error('sing-box did not become ready within 15 seconds')
}

export class Core extends EventEmitter {
  status: CoreStatus = { state: 'stopped' }
  logs: LogLine[] = []

  private child?: ChildProcess
  private xrayChild?: ChildProcess
  /** aether.exe processes: several while WARP methods race, one once connected. */
  private warpChildren = new Set<ChildProcess>()
  /**
   * One of the user's own servers, for creating the WARP account through it when Cloudflare's
   * WARP service is blocked directly. Set by the app shell.
   */
  warpHelper?: () => ServerProfile | undefined
  /** Called when a saved WARP config's gateway stopped answering and the scan found another. */
  onWarpPeer?: (serverId: string, peer: string) => void
  /** True while "Find configs" runs; connecting waits for it. */
  private scanningWarp = false
  private api?: ClashApi
  private proxyPort?: number
  /** SOCKS port that always exits through the VPN (see BuildOptions.probePort); set while running. */
  probePort?: number
  private statsTimer?: NodeJS.Timeout
  private healthTimer?: NodeJS.Timeout
  private settings?: Settings
  private lastTotals = { up: 0, down: 0, at: 0 }
  private seenConns = new Map<string, { path: string; up: number; down: number }>()
  private appTotals = new Map<string, AppTraffic>()

  private resolver: ServerResolver

  constructor(private paths: CorePaths) {
    super()
    mkdirSync(paths.dataDir, { recursive: true })
    this.resolver = new ServerResolver(join(paths.dataDir, 'server-addresses.json'), (text, level) => this.log(text, level))
  }

  /**
   * Returns the server with its hostname replaced by a safely resolved IP (see resolve.ts).
   * Must run before TUN starts, so the lookups use the real network.
   */
  private async pinAddress(server: ServerProfile, quiet = false): Promise<ServerProfile> {
    const host = server.outbound.server
    if (typeof host !== 'string') return server
    const r = await this.resolver.resolve(host)
    if (!r) return server
    if (!quiet && r.ip !== host) this.log(`Server ${host} -> ${r.ip} (${r.source})`)
    return { ...server, outbound: withServerIp(server.outbound, r.ip) }
  }

  /** Same as pinAddress, for a server's Xray outbound. */
  private async pinXray(outbound: XrayOutbound, quiet = false): Promise<XrayOutbound> {
    const { host } = xrayServer(outbound)
    const r = host ? await this.resolver.resolve(host) : undefined
    if (!r) return outbound
    if (!quiet && r.ip !== host) this.log(`Server ${host} -> ${r.ip} (${r.source}, Xray)`)
    return xrayWithServerIp(outbound, r.ip)
  }

  private xrayLine = (line: string) => {
    const level: LogLine['level'] = /\[(Error)\]|Failed/.test(line) ? 'error' : /\[Warning\]/.test(line) ? 'warn' : 'info'
    this.log(`[xray] ${line}`, level)
  }

  /** Starts xray.exe with one local SOCKS inbound per entry; resolves once the first port accepts connections. */
  private async launchXray(entries: { port: number; outbound: XrayOutbound }[], name: string, bindInterface?: string): Promise<ChildProcess> {
    const exe = this.paths.xray
    if (!exe || !existsSync(exe)) throw new Error('Xray core not found; this server needs it (reinstall Bridge)')
    const file = join(this.paths.dataDir, `${name}.json`)
    writeFileSync(file, JSON.stringify(buildXrayConfig(entries, 'warning', bindInterface), null, 2))
    const child = spawn(exe, ['run', '-c', file], { windowsHide: true })
    const feed = (chunk: Buffer) => chunk.toString().split(/\r?\n/).filter((l) => l.trim()).forEach(this.xrayLine)
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    let exited = false
    child.once('exit', () => (exited = true))
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (exited) throw new Error('Xray exited during startup (see Logs)')
      if (await portOpen(entries[0].port)) return child
      await new Promise((r) => setTimeout(r, 150))
    }
    child.kill()
    throw new Error('Xray did not become ready within 10 seconds')
  }

  /**
   * For servers run by Xray, starts xray.exe and returns the server as sing-box should see it:
   * a SOCKS hop into Xray. Other servers are returned unchanged.
   */
  private async viaXray(server: ServerProfile, bindInterface?: string): Promise<ServerProfile> {
    if (server.engine !== 'xray') return server
    if (!server.xray) throw new Error('This server has no Xray settings; update its subscription or import it again')
    const port = await freePort()
    this.xrayChild = await this.launchXray([{ port, outbound: await this.pinXray(server.xray) }], 'xray-config', bindInterface)
    this.xrayChild.once('exit', (code) => {
      if (this.status.state !== 'running') return
      this.log(`Xray stopped unexpectedly (exit code ${code})`, 'error')
      void this.stop().then(() => this.setStatus({ state: 'stopped', error: 'Xray core stopped unexpectedly, see Logs' }))
    })
    this.log(`Using Xray core for ${server.name} (local SOCKS ${port}${bindInterface ? `, bound to "${bindInterface}"` : ''})`)
    return { ...server, outbound: socksOutbound(port) }
  }

  /** Counts start() calls, so a slow start that was cancelled can't mistake a newer one for itself. */
  private startGen = 0

  /** Throws Cancelled when the user disconnected (or connected again) while this start was still running. */
  private checkCancelled(gen: number): void {
    if (this.status.state !== 'starting' || gen !== this.startGen) throw new Cancelled()
  }

  private get warpDir(): string {
    return join(this.paths.dataDir, 'warp')
  }

  /** Starts aether.exe, logging its output under `tag`; `onLine` sees each message. */
  private spawnAether(args: string[], tag: string, onLine?: (text: string) => void): ChildProcess {
    const child = spawn(this.paths.aether!, args, { windowsHide: true, cwd: this.warpDir })
    child.stdin?.end()
    this.warpChildren.add(child)
    child.once('exit', () => this.warpChildren.delete(child))
    const feed = (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) {
        if (!l.trim()) continue
        const { level, text } = parseWarpLine(l)
        this.log(`[${tag}] ${text}`, level)
        onLine?.(text)
      }
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    return child
  }

  /**
   * Starts one WARP attempt; resolves once Aether serves a working tunnel on `port`. `peer` is a
   * saved gateway to use without scanning; `fresh` ignores the last working gateway.
   */
  private launchWarp(method: WarpMethod, port: number, opts: { peer?: string; timeoutMs?: number; fresh?: boolean } = {}): Promise<WarpWinner> {
    const timeoutMs = opts.timeoutMs ?? WARP_ATTEMPT_MS
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      let won: WarpWinner | undefined
      let exit: string | undefined
      let gateway: string | undefined
      const child = this.spawnAether(warpArgs(method, port, join(this.warpDir, 'aether.toml'), opts.peer, opts.fresh), `warp ${method}`, (text) => {
        // Only Gool checks its exit before serving; the others print it just after.
        if (won) return void (won.exit ??= warpExitCountry(text))
        exit = warpExitCountry(text) ?? exit
        // The first edge is Gool's outer hop, the one a saved config has to name.
        gateway ??= warpGateway(text)
        if (WARP_NO_IPV6.test(text)) {
          clearTimeout(timer)
          child.kill()
          return reject(new Error(`${warpLabel(method)}: this network has no IPv6`))
        }
        if (!warpReady(text, port)) return
        clearTimeout(timer)
        resolve((won = { method, port, child, exit, peer: gateway, readyMs: Date.now() - t0 }))
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`${warpLabel(method)}: no working gateway within ${timeoutMs / 1000} s`))
      }, timeoutMs)
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (!won) reject(new Error(`${warpLabel(method)}: stopped (exit code ${code})`))
      })
    })
  }

  /** Runs one aether.exe to the end (or until `timeoutMs`), for creating the WARP account. */
  private runAether(args: string[], timeoutMs: number): Promise<void> {
    const child = this.spawnAether(args, 'warp')
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Starts a plain local SOCKS proxy into one of the user's own servers (see warpHelper) and
   * returns its port and process, or undefined when there is no server to use or it doesn't start.
   */
  private async startWarpHelper(): Promise<{ port: number; child: ChildProcess } | undefined> {
    const server = this.warpHelper?.()
    if (!server) return undefined
    try {
      const port = await freePort()
      let child: ChildProcess
      if (server.engine === 'xray' && server.xray) {
        child = await this.launchXray([{ port, outbound: await this.pinXray(server.xray as XrayOutbound, true) }], 'warp-helper')
      } else {
        const api: ClashApi = { port: await freePort(), secret: randomUUID() }
        const file = join(this.paths.dataDir, 'warp-helper.json')
        writeFileSync(file, JSON.stringify(buildHelperConfig(await this.pinAddress(server, true), port, api), null, 2))
        child = await launch(this.paths.singBox, file, this.paths.dataDir, api, (line, isErr) => isErr && /ERROR|FATAL/.test(line) && this.coreLine(line, true))
      }
      // Tracked with the aether processes, so a cancelled connect stops it too.
      this.warpChildren.add(child)
      child.once('exit', () => this.warpChildren.delete(child))
      this.log(`Free WARP: using "${server.name}" to reach Cloudflare's WARP service`)
      return { port, child }
    } catch (e) {
      this.log(`Free WARP: could not start "${server.name}" to create the account (${e instanceof Error ? e.message : e})`, 'warn')
      return undefined
    }
  }

  /** Creates the WARP account, trying each way in WARP_REGISTER_TRIES until one works. */
  private async registerWarp(checkCancelled: () => void): Promise<void> {
    const config = join(this.warpDir, 'aether.toml')
    const done = () => existsSync(join(this.warpDir, WARP_IDENTITY_FILE))
    this.log('Free WARP: creating a WARP account (first use only, can take a few minutes)')
    for (const t of WARP_REGISTER_TRIES) {
      const helper = t.via ? await this.startWarpHelper() : undefined
      checkCancelled()
      if (t.via && !helper) continue
      this.log(`Free WARP: creating the account ${t.label}`)
      await this.runAether(warpRegisterArgs(config, t.args, helper?.port), t.timeoutMs)
      if (helper) {
        this.warpChildren.delete(helper.child)
        await killProcess(helper.child)
      }
      checkCancelled()
      if (done()) return this.log('Free WARP: account created')
    }
    const via = this.warpHelper?.() ? '' : ' Adding one of your own servers lets Bridge create it through that server.'
    throw new Error(`Free WARP: could not create a WARP account, because Cloudflare's WARP service is blocked on this network right now (see Logs).${via}`)
  }

  /**
   * For the free WARP server, starts aether.exe and returns the server as sing-box should see
   * it: a SOCKS hop into Aether. With method "auto", the MASQUE methods all run at once (each on
   * its own port) and the first one that carries real traffic wins; the others are stopped.
   */
  private async viaWarp(server: ServerProfile, gen: number): Promise<ServerProfile> {
    const exe = this.paths.aether
    if (!exe || !existsSync(exe)) throw new Error('WARP core (aether.exe) not found; reinstall Bridge')
    mkdirSync(this.warpDir, { recursive: true })
    // One WARP account for every attempt, made once and kept: Cloudflare limits new sign-ups.
    if (!existsSync(join(this.warpDir, WARP_IDENTITY_FILE))) await this.registerWarp(() => this.checkCancelled(gen))
    const methods = warpMethods(server.warp)
    const peer = server.warp?.peer
    let winner: WarpWinner | undefined
    if (peer && methods.length === 1) {
      this.log(`Free WARP: connecting with ${warpLabel(methods[0])} on the saved gateway ${peer}`)
      winner = await this.launchWarp(methods[0], await freePort(), { peer, timeoutMs: WARP_PEER_MS }).catch((e) => {
        this.checkCancelled(gen)
        this.log(`Free WARP: the saved gateway didn't answer (${e instanceof Error ? e.message : e}); scanning for another`, 'warn')
        return undefined
      })
      this.checkCancelled(gen)
    }
    if (!winner) winner = await this.raceWarpMethods(methods, gen)
    if (peer && winner.peer && winner.peer !== peer) this.onWarpPeer?.(server.id, winner.peer)
    // Stop the attempts that lost the race.
    const won = winner
    const losers = [...this.warpChildren].filter((c) => c !== won.child)
    for (const c of losers) this.warpChildren.delete(c)
    await Promise.all(losers.map((c) => killProcess(c)))
    this.checkCancelled(gen)
    won.child.once('exit', (code) => {
      if (this.status.state !== 'running') return
      this.log(`WARP core stopped unexpectedly (exit code ${code})`, 'error')
      void this.stop().then(() => this.setStatus({ state: 'stopped', error: 'WARP core stopped unexpectedly, see Logs' }))
    })
    this.log(`Free WARP connected with ${warpLabel(won.method)}${won.exit ? `, exit ${won.exit}` : ''}${won.peer ? ` via ${won.peer}` : ''} (local SOCKS ${won.port})`)
    if (won.exit === 'IR') {
      this.log(
        "Free WARP: Cloudflare registers this exit address in Iran. Filtering is still bypassed (the traffic leaves abroad), but sites that block Iranian users may refuse. Gool, which gets a foreign address, didn't get through this time.",
        'warn'
      )
    }
    return { ...server, outbound: socksOutbound(won.port) }
  }

  /** Races `methods` (each on its own port) and returns the winner; see raceWarp. */
  private async raceWarpMethods(methods: WarpMethod[], gen: number): Promise<WarpWinner> {
    this.log(`Free WARP: looking for a way through (${methods.map(warpLabel).join(', ')})`)
    const attempts = await Promise.all(methods.map(async (method) => ({ method, port: await freePort() })))
    const state = this.readWarpState()
    const triesGool = methods.length > 1 && methods.some(prefersForeignExit)
    const wait = triesGool && waitForGool(state)
    if (triesGool && !wait) this.log(`Free WARP: Gool didn't get through recently, so Bridge takes the first way that works (Gool gets waited for again after ${GOOL_RETRY_MS / 3_600_000} h)`)
    let winner: WarpWinner
    try {
      winner = await this.raceWarp(attempts, wait)
    } catch (e) {
      this.checkCancelled(gen)
      const reasons = e instanceof AggregateError ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))) : [String(e)]
      throw new Error(`Free WARP could not connect on this network. ${reasons.join('; ')}`)
    }
    if (triesGool && prefersForeignExit(winner.method)) this.writeWarpState({ ...state, goolMissedAt: undefined })
    else if (wait) this.writeWarpState({ ...state, goolMissedAt: Date.now() })
    return winner
  }

  /**
   * "Find configs": runs every Auto method at once on the real network (Bridge must be
   * disconnected) and returns each one that carries traffic, with the gateway it used. Each
   * method is stopped as soon as it has proved itself.
   */
  async findWarpConfigs(): Promise<WarpFound[]> {
    if (this.status.state !== 'stopped') throw new Error('Disconnect first: configs are tested on your own network, not through the VPN')
    if (this.scanningWarp) throw new Error('Already finding WARP configs')
    const exe = this.paths.aether
    if (!exe || !existsSync(exe)) throw new Error('WARP core (aether.exe) not found; reinstall Bridge')
    this.scanningWarp = true
    try {
      mkdirSync(this.warpDir, { recursive: true })
      const stopped = () => {
        if (this.status.state !== 'stopped') throw new Cancelled()
      }
      if (!existsSync(join(this.warpDir, WARP_IDENTITY_FILE))) await this.registerWarp(stopped)
      const methods = warpMethods({ method: 'auto' })
      this.log(`Free WARP: finding configs (${methods.map(warpLabel).join(', ')})`)
      const results = await Promise.allSettled(
        methods.map(async (method) => {
          const w = await this.launchWarp(method, await freePort(), { fresh: true })
          // Give the exit-country line, printed just after the tunnel is up, a moment.
          for (let i = 0; i < 25 && !w.exit; i++) await new Promise((r) => setTimeout(r, 200))
          this.warpChildren.delete(w.child)
          await killProcess(w.child)
          if (!w.peer) throw new Error(`${warpLabel(method)}: no gateway in the log`)
          this.log(`Free WARP: ${warpLabel(method)} works on ${w.peer}${w.exit ? `, exit ${w.exit}` : ''} (${(w.readyMs / 1000).toFixed(1)} s)`)
          return { method, peer: w.peer, exit: w.exit, readyMs: w.readyMs } satisfies WarpFound
        })
      )
      const found = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      for (const r of results) if (r.status === 'rejected') this.log(`Free WARP: ${r.reason instanceof Error ? r.reason.message : r.reason}`)
      this.log(`Free WARP: ${found.length} config${found.length === 1 ? '' : 's'} found`)
      return found
    } finally {
      this.scanningWarp = false
    }
  }

  private readWarpState(): WarpState {
    try {
      return JSON.parse(readFileSync(join(this.warpDir, WARP_STATE_FILE), 'utf8')) as WarpState
    } catch {
      return {}
    }
  }

  private writeWarpState(state: WarpState): void {
    try {
      writeFileSync(join(this.warpDir, WARP_STATE_FILE), JSON.stringify(state))
    } catch {
      // Only a speed-up for the next connect; not worth failing over.
    }
  }

  /**
   * Runs the WARP attempts at the same time. Gool wins outright; when another method works first,
   * Gool still gets WARP_PREFER_WAIT_MS to finish (if `waitForGool`), and the other one is used if it doesn't.
   */
  private raceWarp(attempts: { method: WarpMethod; port: number }[], waitForGool = true): Promise<WarpWinner> {
    return new Promise((resolve, reject) => {
      const preferred = new Set(waitForGool ? attempts.filter((a) => prefersForeignExit(a.method)).map((a) => a.method) : [])
      const errors: unknown[] = []
      let settled = 0
      let fallback: WarpWinner | undefined
      let wait: NodeJS.Timeout | undefined
      let done = false
      const finish = (w: WarpWinner) => {
        if (done) return
        done = true
        clearTimeout(wait)
        resolve(w)
      }
      for (const a of attempts) {
        this.launchWarp(a.method, a.port).then(
          (w) => {
            settled++
            preferred.delete(a.method)
            if (prefersForeignExit(a.method)) return finish(w)
            if (fallback) return
            fallback = w
            if (!preferred.size) return finish(w)
            this.log(`Free WARP: ${warpLabel(a.method)} works; waiting up to ${WARP_PREFER_WAIT_MS / 1000} s for Gool, which exits outside Iran`)
            wait = setTimeout(() => finish(w), WARP_PREFER_WAIT_MS)
          },
          (e) => {
            settled++
            preferred.delete(a.method)
            errors.push(e)
            if (fallback && !preferred.size) return finish(fallback)
            if (settled === attempts.length && !fallback && !done) {
              done = true
              reject(new AggregateError(errors))
            }
          }
        )
      }
    })
  }

  log(text: string, level: LogLine['level'] = 'info'): void {
    const line: LogLine = { time: Date.now(), level, text }
    this.logs.push(line)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
    this.emit('log', line)
  }

  private setStatus(s: CoreStatus): void {
    this.status = s
    this.emit('status', s)
  }

  /** Warned this session that an app got a censored DNS answer (see coreLine). */
  private censoredDnsWarned = false

  private coreLine = (line: string, isErr: boolean) => {
    const level: LogLine['level'] = /\b(ERROR|FATAL)\b/.test(line) ? 'error' : /\bWARN\b/.test(line) ? 'warn' : isErr ? 'warn' : 'info'
    // sing-box prints ANSI colors; strip them for the UI.
    const text = line.replace(/\x1b\[[0-9;]*m/g, '')
    this.log(text, level)
    // 10.10.34.x is Iran's block page. Bridge's own DNS never answers with it, so an app
    // connecting there took the answer from the ISP's DNS (Windows asks every adapter's DNS
    // server, and without Strict mode the ISP's reply can win). Such an app can't reach the
    // site even on VPN, because the address itself is wrong.
    if (!this.censoredDnsWarned && /inbound connection (from \S+ )?to 10\.10\.34\.\d+:/.test(text)) {
      this.censoredDnsWarned = true
      this.log('An app got a censored DNS answer from your ISP (10.10.34.x) instead of Bridge, so a blocked site may not open even on VPN. If that happens, turn on Strict mode in Settings.', 'warn')
    }
  }

  async start(server: ServerProfile, settings: Settings, appRules: AppRule[]): Promise<void> {
    if (this.scanningWarp) throw new Error('Bridge is still finding WARP configs; connect when it is done')
    if (this.status.state !== 'stopped') await this.stop()
    if (!existsSync(this.paths.singBox)) throw new Error(`sing-box not found at ${this.paths.singBox}`)
    this.setStatus({ state: 'starting', mode: settings.mode, serverId: server.id })
    this.settings = settings
    this.censoredDnsWarned = false
    const gen = ++this.startGen
    try {
      const api: ClashApi = { port: await freePort(), secret: randomUUID() }
      const probePort = await freePort()
      // Direct traffic must resolve with the real network's DNS; read it before TUN takes over.
      const log = (text: string, level?: 'info' | 'warn') => this.log(text, level)
      const usesXray = server.engine === 'xray'
      const usesWarp = isWarp(server)
      const tun = usesTun(settings.mode)
      const net: Awaited<ReturnType<typeof networkInfo>> = tun ? await networkInfo() : { dnsServers: [], otherTunnels: [], defaultRoutes: [], bindPhysical: false }
      if (net.defaultRoutes.length) this.log(`Default routes before connecting: ${net.defaultRoutes.join(', ')}`)
      const [localDns, pinned] = await Promise.all([
        tun ? pickDirectDns(net.dnsServers, log) : Promise.resolve(undefined),
        // In TUN modes Xray goes straight out of the real adapter instead of looping through TUN.
        usesWarp ? this.viaWarp(server, gen) : usesXray ? this.viaXray(server, tun ? net.interfaceAlias : undefined) : this.pinAddress(server)
      ])
      this.checkCancelled(gen)
      if (localDns) this.log(`Direct apps resolve names with ${localDns.type === 'https' ? 'DNS-over-HTTPS' : 'DNS'} ${localDns.server}`)
      else if (tun) this.log('No working DNS server found for direct apps; using the system resolver', 'warn')
      // With other tunnels up, pin Bridge's own traffic to the real adapter so it never
      // leaves through (or fights with) another tool's tunnel.
      const defaultInterface = net.bindPhysical ? net.interfaceAlias : undefined
      if (net.otherTunnels.length) this.log(`Other tunnels are active: ${net.otherTunnels.join(', ')}. They may conflict with Bridge.`, 'warn')
      if (defaultInterface) this.log(`Bridge traffic is bound to "${defaultInterface}" to stay out of other tunnels`)
      if (net.otherInterface) this.log(`Apps set to "Other VPN" go through "${net.otherInterface}"`)
      else if (appRules.some((r) => r.enabled && r.action === 'other')) this.log('No other VPN adapter found; apps set to "Other VPN" go direct', 'warn')
      const config = buildConfig({
        server: pinned,
        settings,
        appRules,
        clashApi: api,
        rulesDir: existsSync(join(this.paths.rulesDir, 'geosite-ir.srs')) ? this.paths.rulesDir : undefined,
        cacheFile: join(this.paths.dataDir, 'cache.db'),
        appRulesDir: this.appRulesDir,
        localDns,
        // xray.exe's traffic (a safety net; it is bound to the real adapter) and aether.exe's
        // (which can't be bound on Windows, so it does reach TUN) must not loop back into the VPN.
        bypassProcesses: usesXray && this.paths.xray ? [this.paths.xray] : usesWarp && this.paths.aether ? [this.paths.aether] : undefined,
        defaultInterface,
        otherInterface: net.otherInterface,
        probePort
      })
      const configFile = join(this.paths.dataDir, 'config.json')
      writeFileSync(configFile, JSON.stringify(config, null, 2))
      this.log(`Starting sing-box: ${server.name} (${settings.mode})`)

      const child = await launch(this.paths.singBox, configFile, this.paths.dataDir, api, this.coreLine)
      // Disconnected while sing-box was starting: stop() couldn't see this process yet.
      if (this.status.state !== 'starting' || gen !== this.startGen) {
        await killProcess(child)
        if (usesTun(settings.mode)) await flushDns()
        throw new Cancelled()
      }
      this.child = child
      this.api = api
      this.probePort = probePort
      this.child.once('exit', (code) => this.onUnexpectedExit(code))

      if (settings.mode === 'system-proxy' && this.paths.manageSystemProxy !== false) {
        await setSystemProxy(settings.mixedPort)
        this.proxyPort = settings.mixedPort
      }
      this.resetStats()
      this.statsTimer = setInterval(() => void this.pollStats(), 1000)
      this.setStatus({
        state: 'running',
        mode: settings.mode,
        serverId: server.id,
        startedAt: Date.now(),
        otherTunnels: net.otherTunnels.length ? net.otherTunnels : undefined,
        proxyPort: settings.mixedPort
      })
      void this.checkHealth()
      this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS)
    } catch (e) {
      if (e instanceof Cancelled) {
        // Disconnected while connecting: stop() already cleaned up and reported it. If a newer
        // start() is running, everything that is up now belongs to it, so touch nothing.
        if (gen === this.startGen) {
          await this.cleanup()
          this.setStatus({ state: 'stopped' })
        }
        return
      }
      await this.cleanup()
      const msg = e instanceof Error ? e.message : String(e)
      this.log(msg, 'error')
      this.setStatus({ state: 'stopped', error: msg })
      throw e
    }
  }

  /** Runs a real request through one outbound ("proxy" = VPN server, "direct" = normal internet). */
  private async probe(api: ClashApi, outbound: string, testUrl: string): Promise<HealthCheck> {
    const checkedAt = Date.now()
    try {
      const r = await clashGet<{ delay: number }>(api, `/proxies/${outbound}/delay?timeout=5000&url=${encodeURIComponent(testUrl)}`, 7000)
      return { ok: true, latency: r.delay, checkedAt }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: /timeout|504|408/i.test(msg) ? 'No response (timeout)' : msg.replace(/^Clash API [^:]+: /, ''), checkedAt }
    }
  }

  /** Checks the VPN server and the normal internet, and reports the result in status.health. */
  async checkHealth(): Promise<void> {
    const api = this.api
    if (!api || this.status.state !== 'running') return
    const testUrl = this.settings?.testUrl || 'https://www.gstatic.com/generate_204'
    const [server, internet] = await Promise.all([this.probe(api, 'proxy', testUrl), this.probe(api, 'direct', testUrl)])
    if (this.api !== api || this.status.state !== 'running') return
    const prev = this.status.health?.server
    if (prev && prev.ok !== server.ok) {
      this.log(server.ok ? `VPN server is responding again (${server.latency} ms)` : `VPN server is not responding: ${server.error}`, server.ok ? 'info' : 'warn')
    }
    this.setStatus({ ...this.status, health: { server, internet } })
  }

  private get appRulesDir(): string {
    return join(this.paths.dataDir, 'app-rules')
  }

  /**
   * Applies app rule changes to the running core without restarting it: sing-box
   * reloads the rule-set files on its own. Open connections of the affected apps
   * are then closed so those apps reconnect through their new route; nothing else
   * on the system is interrupted.
   */
  async updateAppRules(rules: AppRule[], affectedPaths: string[]): Promise<void> {
    writeAppRuleSets(this.appRulesDir, rules)
    const api = this.api
    if (this.status.state !== 'running' || !api || !affectedPaths.length) return
    await new Promise((r) => setTimeout(r, RULE_RELOAD_DELAY_MS))
    // Same matching as the rules themselves (version folders match any version).
    const affected = affectedPaths.map((p) => new RegExp(processPathRegex(p).replace('(?i)', ''), 'i'))
    try {
      const snap = await clashGet<{ connections: ClashConnection[] | null }>(api, '/connections')
      const targets = (snap.connections || []).filter((c) => affected.some((re) => re.test(c.metadata.processPath || '')))
      await Promise.all(targets.map((c) => clashDelete(api, `/connections/${encodeURIComponent(c.id)}`)))
      if (targets.length) this.log(`App rules updated, reconnecting ${targets.length} connection(s)`)
    } catch (e) {
      this.log(`Could not reset app connections: ${e instanceof Error ? e.message : e}`, 'warn')
    }
  }

  async stop(): Promise<void> {
    if (this.status.state === 'stopped') return
    this.setStatus({ ...this.status, state: 'stopping' })
    await this.cleanup()
    this.log('Disconnected')
    this.setStatus({ state: 'stopped' })
  }

  /** Adds the VPN's exit location to the status (looked up by the app shell). */
  setExit(exit: CoreStatus['exit']): void {
    if (this.status.state === 'running') this.setStatus({ ...this.status, exit })
  }

  private async cleanup(): Promise<void> {
    this.probePort = undefined
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.statsTimer = this.healthTimer = undefined
    const usedTun = !!this.child && !!this.settings && usesTun(this.settings.mode)
    if (this.proxyPort !== undefined) {
      await clearSystemProxy(this.proxyPort).catch((e) => this.log(`Could not clear system proxy: ${e}`, 'warn'))
      this.proxyPort = undefined
    }
    const xrayChild = this.xrayChild
    this.xrayChild = undefined
    await killProcess(xrayChild)
    const warpChildren = [...this.warpChildren]
    this.warpChildren.clear()
    await Promise.all(warpChildren.map((c) => killProcess(c)))
    const child = this.child
    this.child = undefined
    this.api = undefined
    if (child && child.exitCode === null) {
      child.removeAllListeners('exit')
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
      })
    }
    // Windows may have cached fake IPs (198.18.x.x) from the TUN DNS; drop them.
    if (usedTun) await flushDns()
  }

  private onUnexpectedExit(code: number | null): void {
    this.log(`sing-box stopped unexpectedly (exit code ${code})`, 'error')
    this.child = undefined
    if (this.settings && usesTun(this.settings.mode)) void flushDns()
    void this.cleanup().then(() => this.setStatus({ state: 'stopped', error: 'Core stopped unexpectedly, see Logs' }))
  }

  private resetStats(): void {
    this.lastTotals = { up: 0, down: 0, at: Date.now() }
    this.seenConns.clear()
    this.appTotals.clear()
  }

  private async pollStats(): Promise<void> {
    const api = this.api
    if (!api) return
    try {
      const snap = await clashGet<{ uploadTotal: number; downloadTotal: number; connections: ClashConnection[] | null }>(api, '/connections')
      const now = Date.now()
      const secs = Math.max((now - this.lastTotals.at) / 1000, 0.001)
      const upSpeed = Math.max(0, (snap.uploadTotal - this.lastTotals.up) / secs)
      const downSpeed = Math.max(0, (snap.downloadTotal - this.lastTotals.down) / secs)
      this.lastTotals = { up: snap.uploadTotal, down: snap.downloadTotal, at: now }

      const live = new Map<string, number>()
      const routes = new Map<string, Set<string>>()
      for (const c of snap.connections || []) {
        const path = c.metadata.processPath || ''
        const outbound = c.chains?.[0]
        if (outbound) routes.set(path, (routes.get(path) || new Set()).add(outbound))
        const prev = this.seenConns.get(c.id) || { path, up: 0, down: 0 }
        let app = this.appTotals.get(path)
        if (!app) {
          app = { path, name: path ? path.split('\\').pop()! : 'Other / system', upload: 0, download: 0, connections: 0 }
          this.appTotals.set(path, app)
        }
        app.upload += Math.max(0, c.upload - prev.up)
        app.download += Math.max(0, c.download - prev.down)
        this.seenConns.set(c.id, { path, up: c.upload, down: c.download })
        live.set(path, (live.get(path) || 0) + 1)
      }
      const liveIds = new Set((snap.connections || []).map((c) => c.id))
      for (const id of this.seenConns.keys()) if (!liveIds.has(id)) this.seenConns.delete(id)
      for (const app of this.appTotals.values()) {
        app.connections = live.get(app.path) || 0
        // Keep the last known route when the app has no open connections right now.
        const r = routes.get(app.path)
        if (r) app.route = (r.size > 1 ? 'mixed' : r.has('proxy') ? 'vpn' : 'direct') as AppRoute
      }

      const stats: TrafficStats = {
        upSpeed,
        downSpeed,
        upTotal: snap.uploadTotal,
        downTotal: snap.downloadTotal,
        apps: [...this.appTotals.values()].sort((a, b) => b.upload + b.download - (a.upload + a.download))
      }
      this.emit('stats', stats)
    } catch {
      // The core may be restarting; the next poll will catch up.
    }
  }

  /**
   * Real latency test: starts a separate sing-box with every server as an outbound
   * and asks each one to fetch the test URL. Returns ms per server id, -1 on failure.
   */
  async testLatency(servers: ServerProfile[], testUrl: string): Promise<Map<string, number>> {
    const results = new Map<string, number>()
    // The free WARP server has no fixed address to ping; finding one is part of connecting.
    servers = servers.filter((s) => !isWarp(s))
    if (!servers.length) return results
    const configFile = join(this.paths.dataDir, 'latency-test.json')
    const workDir = join(this.paths.dataDir, 'latency-test')
    mkdirSync(workDir, { recursive: true })

    // If sing-box refuses one server ("initialize outbound[N]: ..."), mark it failed and retry without it.
    // Resolve each distinct server host once, safely, like a real connection does.
    const lookups = new Map<string, Promise<ServerProfile>>()
    const isXray = (s: ServerProfile) => s.engine === 'xray'
    for (const s of servers) if (isXray(s) && !s.xray) results.set(s.id, -1)
    let testable = await Promise.all(
      servers
        .filter((s) => !isXray(s) || s.xray)
        .map((s) => {
          if (isXray(s)) return s
          const key = String(s.outbound.server)
          if (!lookups.has(key)) lookups.set(key, this.pinAddress(s, true))
          return lookups.get(key)!.then((p) => ({ ...s, outbound: withServerIp(s.outbound, String(p.outbound.server)) }))
        })
    )

    // Servers run by Xray are tested through one extra xray.exe with a SOCKS port per server.
    let xrayTest: ChildProcess | undefined
    const xrayEntries: { id: string; port: number; outbound: XrayOutbound }[] = []
    for (const s of testable.filter(isXray)) xrayEntries.push({ id: s.id, port: await freePort(), outbound: await this.pinXray(s.xray as XrayOutbound, true) })
    if (xrayEntries.length) {
      try {
        xrayTest = await this.launchXray(xrayEntries, 'xray-latency-test')
        const ports = new Map(xrayEntries.map((e) => [e.id, e.port]))
        testable = testable.map((s) => (ports.has(s.id) ? { ...s, outbound: socksOutbound(ports.get(s.id)!) } : s))
      } catch (e) {
        this.log(`Latency test: Xray servers skipped (${e instanceof Error ? e.message : e})`, 'warn')
        for (const s of testable.filter(isXray)) results.set(s.id, -1)
        testable = testable.filter((s) => !isXray(s))
      }
    }

    let child: ChildProcess | undefined
    let api: ClashApi = { port: 0, secret: '' }
    while (!child && testable.length) {
      api = { port: await freePort(), secret: randomUUID() }
      writeFileSync(configFile, JSON.stringify(buildTestConfig(testable, api), null, 2))
      let fatal = ''
      try {
        child = await launch(this.paths.singBox, configFile, workDir, api, (line, isErr) => {
          if (/FATAL/.test(line)) fatal = line
          if (isErr && /ERROR|FATAL/.test(line)) this.coreLine(line, true)
        })
      } catch (e) {
        // outbound[0] is "direct", so server i is outbound[i + 1].
        const index = Number(fatal.match(/outbound\[(\d+)\]/)?.[1]) - 1
        const bad = testable[index]
        if (!bad) throw e
        this.log(`Latency test: skipping "${bad.name}" (${fatal.replace(/^.*?outbound\[\d+\]:\s*/, '')})`, 'warn')
        results.set(bad.id, -1)
        testable = testable.filter((s) => s !== bad)
      }
    }
    if (!child) {
      await killProcess(xrayTest)
      return results
    }

    try {
      const queue = [...testable]
      const worker = async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try {
            const r = await clashGet<{ delay: number }>(
              api,
              `/proxies/${encodeURIComponent(s.id)}/delay?timeout=6000&url=${encodeURIComponent(testUrl)}`,
              8000
            )
            results.set(s.id, r.delay)
          } catch {
            results.set(s.id, -1)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, testable.length) }, worker))
    } finally {
      await killProcess(child)
      await killProcess(xrayTest)
    }
    return results
  }
}
