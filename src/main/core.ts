// Runs sing-box as a child process and talks to it through its Clash API.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildConfig, buildTestConfig, withServerIp, writeAppRuleSets, type ClashApi } from './config'
import { ServerResolver } from './resolve'
import { clearSystemProxy, flushDns, freePort, physicalDnsServer, setSystemProxy } from './system'
import type { AppRoute, AppRule, AppTraffic, CoreStatus, HealthCheck, LogLine, ServerProfile, Settings, TrafficStats } from '../shared/types'

export interface CorePaths {
  singBox: string
  rulesDir: string
  /** Folder for generated configs, cache and working files. */
  dataDir: string
  /** Set to false to never touch the Windows proxy setting (used by tests). Default true. */
  manageSystemProxy?: boolean
}

interface ClashConnection {
  id: string
  upload: number
  download: number
  chains?: string[]
  metadata: { processPath?: string }
}

const MAX_LOGS = 1000
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
  private api?: ClashApi
  private proxyPort?: number
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

  private coreLine = (line: string, isErr: boolean) => {
    const level: LogLine['level'] = /\b(ERROR|FATAL)\b/.test(line) ? 'error' : /\bWARN\b/.test(line) ? 'warn' : isErr ? 'warn' : 'info'
    // sing-box prints ANSI colors; strip them for the UI.
    this.log(line.replace(/\x1b\[[0-9;]*m/g, ''), level)
  }

  async start(server: ServerProfile, settings: Settings, appRules: AppRule[]): Promise<void> {
    if (this.status.state !== 'stopped') await this.stop()
    if (!existsSync(this.paths.singBox)) throw new Error(`sing-box not found at ${this.paths.singBox}`)
    this.setStatus({ state: 'starting', mode: settings.mode, serverId: server.id })
    this.settings = settings
    try {
      const api: ClashApi = { port: await freePort(), secret: randomUUID() }
      // Direct traffic must resolve with the real network's DNS; read it before TUN takes over.
      const [localDns, pinned] = await Promise.all([
        settings.mode !== 'system-proxy' ? physicalDnsServer() : Promise.resolve(undefined),
        this.pinAddress(server)
      ])
      if (localDns) this.log(`Using network DNS ${localDns} for direct traffic`)
      const config = buildConfig({
        server: pinned,
        settings,
        appRules,
        clashApi: api,
        rulesDir: existsSync(join(this.paths.rulesDir, 'geosite-ir.srs')) ? this.paths.rulesDir : undefined,
        cacheFile: join(this.paths.dataDir, 'cache.db'),
        appRulesDir: this.appRulesDir,
        localDns
      })
      const configFile = join(this.paths.dataDir, 'config.json')
      writeFileSync(configFile, JSON.stringify(config, null, 2))
      this.log(`Starting sing-box: ${server.name} (${settings.mode})`)

      this.child = await launch(this.paths.singBox, configFile, this.paths.dataDir, api, this.coreLine)
      this.api = api
      this.child.once('exit', (code) => this.onUnexpectedExit(code))

      if (settings.mode === 'system-proxy' && this.paths.manageSystemProxy !== false) {
        await setSystemProxy(settings.mixedPort)
        this.proxyPort = settings.mixedPort
      }
      this.resetStats()
      this.statsTimer = setInterval(() => void this.pollStats(), 1000)
      this.setStatus({ state: 'running', mode: settings.mode, serverId: server.id, startedAt: Date.now() })
      void this.checkHealth()
      this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(msg, 'error')
      await this.cleanup()
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
    const affected = new Set(affectedPaths.map((p) => p.toLowerCase()))
    try {
      const snap = await clashGet<{ connections: ClashConnection[] | null }>(api, '/connections')
      const targets = (snap.connections || []).filter((c) => affected.has((c.metadata.processPath || '').toLowerCase()))
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

  private async cleanup(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.statsTimer = this.healthTimer = undefined
    const usedTun = !!this.child && this.settings?.mode !== 'system-proxy'
    if (this.proxyPort !== undefined) {
      await clearSystemProxy(this.proxyPort).catch((e) => this.log(`Could not clear system proxy: ${e}`, 'warn'))
      this.proxyPort = undefined
    }
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
    if (this.settings?.mode !== 'system-proxy') void flushDns()
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
    if (!servers.length) return results
    const configFile = join(this.paths.dataDir, 'latency-test.json')
    const workDir = join(this.paths.dataDir, 'latency-test')
    mkdirSync(workDir, { recursive: true })

    // If sing-box refuses one server ("initialize outbound[N]: ..."), mark it failed and retry without it.
    // Resolve each distinct server host once, safely, like a real connection does.
    const lookups = new Map<string, Promise<ServerProfile>>()
    let testable = await Promise.all(
      servers.map((s) => {
        const key = String(s.outbound.server)
        if (!lookups.has(key)) lookups.set(key, this.pinAddress(s, true))
        return lookups.get(key)!.then((p) => ({ ...s, outbound: withServerIp(s.outbound, String(p.outbound.server)) }))
      })
    )
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
    if (!child) return results

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
      const running = child
      if (running.exitCode === null) {
        await new Promise<void>((resolve) => {
          running.once('exit', () => resolve())
          running.kill()
        })
      }
    }
    return results
  }
}
