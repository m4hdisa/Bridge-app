import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Core } from './core'
import { DiscordPresence, type DiscordActivity } from './discord'
import { fetcherVia, fetchTextVia, lookupExit } from './geo'
import { describeLink, extractLinks, parseLink } from './parser'
import { choosePublicCandidates, fetchPublicLinks, PUBLIC_KEEP, publicKey } from './publicconfigs'
import { installPerAppDriver, perAppDriverReady, restoreDns, stopPerApp } from './perapp'
import { Store } from './store'
import { fetchSubscription, SubscriptionAnswer, type SubscriptionResult } from './subscription'
import { clearSystemProxy, flushDns, isAdmin, listProcesses, relaunchAsAdmin, stopLeftoverEngines } from './system'
import { checkForUpdate, downloadInstaller, runInstaller } from './updater'
import { isWarp, isWarpConfig, newWarpConfig, newWarpServer } from './warp'
import { AUTO_SERVER, usesTun } from '../shared/types'
import type { AppRule, AppState, CoreStatus, Engine, ImportResult, LogLine, RunningProcess, ServerProfile, Settings, SkippedConfig, SpeedTestStatus, Subscription, UpdateStatus, WarpOptions } from '../shared/types'

if (!app.requestSingleInstanceLock()) app.quit()

const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
const dataDir = app.getPath('userData')
const store = new Store(join(dataDir, 'state.json'))
const core = new Core({
  singBox: join(resourcesDir, 'core', 'sing-box.exe'),
  xray: join(resourcesDir, 'xray', 'xray.exe'),
  aether: join(resourcesDir, 'aether', 'aether.exe'),
  psiphon: join(resourcesDir, 'aether', 'pt', 'psiphon-tunnel-core.exe'),
  rulesDir: join(resourcesDir, 'rules'),
  dataDir: join(dataDir, 'core')
})

let win: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Servers being pinged right now, so their latency shows a loading animation. */
const pinging = new Set<string>()
let publicStatus: AppState['publicStatus']
let speedTest: SpeedTestStatus = { running: false }
let speedAbort: AbortController | undefined
function setSpeedTest(s: SpeedTestStatus): void {
  speedTest = s
  send('speedTest', s)
}

function pushState(): void {
  send('state', { ...store.state, pinging: [...pinging], publicStatus })
  updateTray()
}

/** Tests these servers' latency, saves the results, and shows them as pinging meanwhile. */
async function ping(targets: ServerProfile[]): Promise<void> {
  const ids = targets.filter((s) => !isWarp(s)).map((s) => s.id)
  for (const id of ids) pinging.add(id)
  pushState()
  try {
    const results = await core.testLatency(targets, store.state.settings.testUrl)
    store.update((s) => {
      for (const server of s.servers) if (results.has(server.id)) server.latency = results.get(server.id)
    })
  } finally {
    for (const id of ids) pinging.delete(id)
    pushState()
  }
}

// Look up the VPN's exit location once per connection (keyed by its start time).
let exitLookedUpFor: number | undefined
const discord = new DiscordPresence((text, level) => core.log(text, level))

/** The app icon, from the public repo, so the activity shows it without uploading it to Discord. */
const DISCORD_ICON = 'https://raw.githubusercontent.com/m4hdisa/Bridge-app/main/resources/icon.png'
/** Cloudflare's own icon, shown small over the Bridge icon while on WARP. */
const CLOUDFLARE_ICON = 'https://www.cloudflare.com/img/favicon/apple-touch-icon.png'

/**
 * What Discord shows while connecting or connected: the server Bridge is on, the mode, where
 * traffic exits (with that country's flag, small, over the Bridge icon) and for how long.
 * The exit's IP address is never shown.
 */
function discordActivity(): DiscordActivity | null {
  const s = core.status
  if (s.state !== 'running' && s.state !== 'starting') return null
  const server = store.state.servers.find((x) => x.id === s.serverId)
  const name = server ? (isWarp(server) ? 'Free WARP (Cloudflare)' : server.name) : 'a VPN server'
  const mode = { 'per-app': 'Per-App', tun: 'Full VPN', 'system-proxy': 'System Proxy', 'proxy-only': 'Proxy only' }[s.mode ?? 'per-app'] ?? 'VPN'
  const exit = s.exit
  const warp = !!server && isWarp(server)
  // On WARP the exit is Cloudflare's network, so its logo stands in for the country flag (as in the app).
  const badge = warp
    ? { small_image: CLOUDFLARE_ICON, small_text: exit ? `Cloudflare WARP · Exit in ${exit.country}` : 'Cloudflare WARP' }
    : exit
      ? { small_image: `https://flagcdn.com/w80/${exit.countryCode.toLowerCase()}.png`, small_text: exit.city ? `${exit.city}, ${exit.country}` : exit.country }
      : {}
  return {
    details: s.state === 'starting' ? `Connecting to ${name}` : `Connected to ${name}`,
    state: s.state === 'starting' ? mode : exit ? `${mode} · Exit in ${exit.country}` : mode,
    timestamps: s.state === 'running' && s.startedAt ? { start: s.startedAt } : undefined,
    assets: {
      large_image: DISCORD_ICON,
      large_text: `Bridge ${app.getVersion()}`,
      ...badge
    },
    buttons: [{ label: 'Get Bridge', url: 'https://github.com/m4hdisa/Bridge-app/releases/latest' }]
  }
}

/**
 * Looks up the exit for the connection that started at `startedAt`. A tunnel can be slow for
 * its first seconds (WARP often is), so it tries again a few times before giving up; on WARP,
 * the exit country Aether reported is used if every lookup fails.
 */
async function findExit(port: number, startedAt: number): Promise<void> {
  const serverId = core.status.serverId
  const current = () => core.status.state === 'running' && core.status.startedAt === startedAt && core.status.serverId === serverId
  for (const wait of [1000, 4000, 10000, 30000]) {
    await new Promise((r) => setTimeout(r, wait))
    if (!current()) return
    const exit = await lookupExit(port)
    if (!current()) return
    if (exit) {
      core.log(`VPN exit: ${exit.ip} (${exit.city ? exit.city + ', ' : ''}${exit.country})`)
      // Cloudflare's own word on whether this tunnel is on WARP+ ("plus") or free WARP ("on").
      if (store.state.warpPlus && store.state.servers.some((s) => s.id === core.status.serverId && isWarp(s))) {
        void fetchTextVia(port, 'https://www.cloudflare.com/cdn-cgi/trace').then(
          (trace) => core.log(`Free WARP: Cloudflare reports this tunnel as warp=${trace.match(/^warp=(\w+)/m)?.[1] ?? 'unknown'}`),
          () => undefined
        )
      }
      return core.setExit(exit)
    }
  }
  const code = core.warpExit
  if (code) {
    const country = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code
    core.log(`Could not look up the VPN exit location; using the country WARP reported (${country})`, 'warn')
    core.setExit({ ip: '', countryCode: code, country })
  } else core.log('Could not look up the VPN exit location', 'warn')
}

core.on('status', (s) => {
  send('status', s)
  updateTray()
  discord.update(discordActivity())
  watchHealth(s)
  // Once per connection, and again after switching servers without reconnecting.
  const exitKey = s.switchedAt ?? s.startedAt
  if (s.state === 'running' && s.startedAt && exitKey !== exitLookedUpFor && core.probePort) {
    exitLookedUpFor = exitKey
    void findExit(core.probePort, s.startedAt)
  }
})
core.on('stats', (s) => send('stats', s))
// Under load sing-box prints hundreds of lines a second; sending each one made the
// whole UI re-render per line. Batch them instead.
let logBatch: LogLine[] = []
let logTimer: NodeJS.Timeout | undefined
core.on('log', (l: LogLine) => {
  logBatch.push(l)
  logTimer ??= setTimeout(() => {
    send('logs', logBatch.slice(-1000))
    logBatch = []
    logTimer = undefined
  }, 250)
})

// ---------- servers ----------

/**
 * Parses links into servers, collecting the ones that can't be used (with the reason).
 * Servers whose link is in `keep` keep their id and last latency, so a subscription
 * update doesn't lose the selection or test results.
 */
function parseLinks(links: string[], keep = new Map<string, ServerProfile>()): { servers: ServerProfile[]; skipped: SkippedConfig[] } {
  const servers: ServerProfile[] = []
  const skipped: SkippedConfig[] = []
  const seen = new Set<string>()
  for (const link of links) {
    if (seen.has(link)) continue
    seen.add(link)
    try {
      const p = parseLink(link)
      const old = keep.get(link)
      servers.push(old ? { ...p, id: old.id, latency: old.latency } : p)
    } catch (e) {
      skipped.push({ ...describeLink(link), reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { servers, skipped }
}

function importResult(added: number, skipped: SkippedConfig[]): ImportResult {
  return { added, errors: skipped.map((s) => `${s.name}: ${s.reason}`) }
}

/** Passes a result through, pinging the servers in the background when something was added. */
function withAutoPing(result: ImportResult, reason: string): ImportResult {
  if (result.added) autoPing(reason)
  return result
}

function addLinks(links: string[]): ImportResult {
  const existing = new Set(store.state.servers.map((s) => s.link))
  const { servers, skipped } = parseLinks(links.filter((l) => !existing.has(l)))
  store.update((s) => {
    const received = servers.filter(isWarp)
    s.servers.push(...servers.filter((x) => !isWarp(x)))
    if (received.length) {
      // Received WARP configs live under the Free WARP card, like the ones Bridge finds itself.
      let at = s.servers.findIndex((x) => isWarp(x) && !isWarpConfig(x))
      if (at < 0) s.servers.unshift(newWarpServer()), (at = 0)
      s.servers.splice(at + 1, 0, ...received)
      if (!s.selectedServerId) s.selectedServerId = received[0].id
    }
    if (!s.selectedServerId && s.servers.length) s.selectedServerId = s.servers[0].id
  })
  pushState()
  return importResult(servers.length, skipped)
}

/**
 * Directly first. Many panels sit on Cloudflare addresses that time out on a filtered network,
 * so if the server didn't answer, it goes through the VPN or, disconnected, a temporary WARP tunnel.
 */
async function fetchSubscriptionAnyRoute(url: string): Promise<SubscriptionResult> {
  try {
    return await fetchSubscription(url)
  } catch (e) {
    if (e instanceof SubscriptionAnswer) throw e
    const port = core.vpnPort
    if (port) {
      core.log(`Subscription: no answer directly (${e instanceof Error ? e.message : e}), trying through the VPN`)
      return fetchSubscription(url, fetcherVia(port))
    }
    if (core.status.state !== 'stopped') throw e
    core.log(`Subscription: no answer directly (${e instanceof Error ? e.message : e}), trying through WARP`)
    return core.withWarpProxy((warp) => fetchSubscription(url, fetcherVia(warp)))
  }
}

async function refreshSubscription(id: string): Promise<ImportResult> {
  const sub = store.state.subscriptions.find((s) => s.id === id)
  if (!sub) throw new Error('Subscription not found')
  try {
    const { links, usage, title, updateHours } = await fetchSubscriptionAnyRoute(sub.url)
    const old = store.state.servers.filter((x) => x.subscriptionId === id)
    const { servers, skipped } = parseLinks(links, new Map(old.map((x) => [x.link, x])))
    for (const s of servers) s.subscriptionId = id
    store.update((s) => {
      // Put the subscription's servers back where they were in the list.
      const at = s.servers.findIndex((x) => x.subscriptionId === id)
      const others = s.servers.filter((x) => x.subscriptionId !== id)
      const insertAt = at < 0 ? others.length : s.servers.slice(0, at).filter((x) => x.subscriptionId !== id).length
      s.servers = [...others.slice(0, insertAt), ...servers, ...others.slice(insertAt)]
      if (!s.servers.some((x) => x.id === s.selectedServerId)) s.selectedServerId = s.servers[0]?.id
      Object.assign(sub, {
        name: sub.name || title || new URL(sub.url).hostname,
        updatedAt: Date.now(),
        usage,
        lastError: undefined,
        total: links.length,
        skipped,
        updateHours: updateHours ?? sub.updateHours
      })
    })
    pushState()
    return importResult(servers.length, skipped)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.update(() => (sub.lastError = msg))
    pushState()
    throw new Error(`Could not update "${sub.name || sub.url}": ${msg}`)
  }
}

const DEFAULT_UPDATE_HOURS = 12

// ---------- public configs ----------

/** Fewer than this still answering, and it's time to look for more. */
const PUBLIC_MIN_ALIVE = 3
const PUBLIC_RETRY_MS = 3600_000
const PUBLIC_REFRESH_MS = 24 * 3600_000
let publicRun: Promise<ImportResult> | undefined

function setPublicStatus(status: AppState['publicStatus']): void {
  publicStatus = status
  pushState()
}

async function directText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** The lists, from the network itself if it lets them through, otherwise through the VPN or a temporary WARP tunnel. */
async function downloadPublicLinks(): Promise<{ links: string[]; clean: string[] }> {
  const log = (text: string) => core.log(text)
  setPublicStatus({ step: 'download' })
  const direct = await fetchPublicLinks(directText, log)
  if (direct.links.length) return direct
  const port = core.vpnPort
  if (port) return fetchPublicLinks((url) => fetchTextVia(port, url), log)
  if (core.status.state !== 'stopped') return direct
  core.log("Public configs: the lists can't be reached directly, trying through WARP")
  setPublicStatus({ step: 'warp' })
  return core.withWarpProxy((port) => fetchPublicLinks((url) => fetchTextVia(port, url), log))
}

/** Looks for public configs, starting from the ones already held. Overlapping calls share one run. */
function refreshPublicConfigs(): Promise<ImportResult> {
  publicRun ??= (async () => {
    let sub = store.state.subscriptions.find((s) => s.public)
    if (!sub) {
      sub = { id: randomUUID(), name: 'Public configs', url: '', public: true }
      const created = sub
      store.update((s) => s.subscriptions.push(created))
    }
    const { id } = sub
    try {
      const { links, clean } = await downloadPublicLinks()
      if (!links.length) throw new Error("The public lists can't be reached on this network right now")
      const old = store.state.servers.filter((s) => s.subscriptionId === id)
      const candidates = choosePublicCandidates(links, new Set(old.map(publicKey)), undefined, undefined, clean)
      const found = await core.findPublicConfigs([...old, ...candidates], store.state.settings.testUrl, (step, n) => setPublicStatus({ step, n }))
      if (!found.length) throw new Error('None of the public configs works on this network right now')
      const kept: ServerProfile[] = found.slice(0, PUBLIC_KEEP).map((f, i) => ({
        ...f.server,
        // The names in the lists are mostly adverts, and nobody checks them.
        name: `Public ${i + 1}`,
        subscriptionId: id,
        latency: f.latency,
        publicConfig: { downMbps: f.downMbps, exit: f.exit }
      }))
      // The test can miss the config this PC is connected through; it stays until the user moves.
      const inUse = old.find((s) => s.id === core.status.serverId && !kept.some((k) => k.id === s.id))
      store.update((s) => {
        s.servers = [...s.servers.filter((x) => x.subscriptionId !== id), ...kept, ...(inUse ? [inUse] : [])]
        if (!s.servers.some((x) => x.id === s.selectedServerId)) s.selectedServerId = kept[0].id
        Object.assign(s.subscriptions.find((x) => x.id === id)!, { updatedAt: Date.now(), lastError: undefined, total: candidates.length + old.length })
      })
      return importResult(kept.length, [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // The time is kept too, so a failure doesn't send hundreds of test connections again in ten minutes.
      store.update((s) => Object.assign(s.subscriptions.find((x) => x.id === id) ?? {}, { updatedAt: Date.now(), lastError: msg }))
      throw new Error(msg)
    } finally {
      setPublicStatus(undefined)
    }
  })().finally(() => (publicRun = undefined))
  return publicRun
}

/** Testing hundreds of servers stands out on a network, so it happens only when the configs have run low, or once a day. */
function publicRefreshDue(sub: Subscription): boolean {
  if (!sub.updatedAt) return true
  const age = Date.now() - sub.updatedAt
  const alive = store.state.servers.filter((s) => s.subscriptionId === sub.id && (s.latency ?? -1) >= 0).length
  return age >= PUBLIC_REFRESH_MS || (age >= PUBLIC_RETRY_MS && alive < PUBLIC_MIN_ALIVE)
}

/** Updates every subscription whose update interval has passed. Errors are kept on the subscription. */
async function refreshDueSubscriptions(): Promise<void> {
  for (const sub of store.state.subscriptions) {
    if (sub.public) {
      if (publicRefreshDue(sub)) await refreshPublicConfigs().catch((e) => core.log(`Public configs: ${e instanceof Error ? e.message : e}`, 'warn'))
      continue
    }
    const hours = sub.updateHours || DEFAULT_UPDATE_HOURS
    if (sub.updatedAt && Date.now() - sub.updatedAt < hours * 3600_000) continue
    await refreshSubscription(sub.id).catch((e) => core.log(String(e instanceof Error ? e.message : e), 'warn'))
  }
}

// ---------- auto ping / best server ----------

const AUTO_PING_EVERY_MS = 10 * 60_000
/** Ping results younger than this are trusted when Auto picks a server. */
const PING_FRESH_MS = 3 * 60_000
let pingRun: Promise<void> | undefined
let lastPingAt = 0

/** Tests every server's latency and saves the results. Overlapping calls share one run. */
function pingAll(reason: string): Promise<void> {
  pingRun ??= (async () => {
    if (!store.state.servers.length) return
    core.log(`Testing all servers (${reason})`)
    await ping(store.state.servers)
    lastPingAt = Date.now()
  })().finally(() => (pingRun = undefined))
  return pingRun
}

/** Background ping, when the user has it on (Settings, "Ping servers automatically"). */
function autoPing(reason: string): void {
  if (store.state.settings.autoPing) void pingAll(reason).catch((e) => core.log(`Auto ping failed: ${e instanceof Error ? e.message : e}`, 'warn'))
}

/** The responding server with the lowest latency, among these. */
function lowestLatency(servers: ServerProfile[], exclude?: string): ServerProfile | undefined {
  return servers.filter((s) => s.id !== exclude && s.latency !== undefined && s.latency >= 0).sort((a, b) => a.latency! - b.latency!)[0]
}

const ownServers = () => store.state.servers.filter((s) => !s.publicConfig)
const publicServers = () => store.state.servers.filter((s) => s.publicConfig)

/**
 * The server Auto should use. Public configs only count for someone who has no server of their
 * own: traffic must never move from a server they chose to one nobody knows, without them asking.
 */
function bestServer(exclude?: string): ServerProfile | undefined {
  const own = ownServers().filter((s) => !isWarp(s))
  return lowestLatency(own.length ? own : publicServers(), exclude)
}

/** Auto: selects the best-ping server, pinging first unless the last results are fresh. */
async function pickBestServer(): Promise<void> {
  if (Date.now() - lastPingAt > PING_FRESH_MS || !bestServer()) await pingAll('choosing the best server')
  const best = bestServer()
  if (!best) throw new Error('Auto: no server answered the ping test. Check your internet, or pick a server yourself.')
  if (best.id !== store.state.selectedServerId) {
    store.update((s) => (s.selectedServerId = best.id))
    pushState()
  }
  core.log(`Auto: using ${best.name} (${best.latency} ms)`)
}

// Auto failover: after two failed health checks in a row (about 40 s), ping everything and
// move to the best other server. A slightly faster server alone is no reason to switch,
// because switching drops open connections.
let failedChecks = 0
let lastCheckAt = 0
let failingOver = false
function watchHealth(s: CoreStatus): void {
  const h = s.health?.server
  if (s.state !== 'running') {
    failedChecks = 0
    return
  }
  if (!h || h.checkedAt === lastCheckAt) return
  lastCheckAt = h.checkedAt
  failedChecks = h.ok ? 0 : failedChecks + 1
  // Public configs come and go, so someone on one moves to the next public one, even with Auto off.
  const onPublic = !!store.state.servers.find((x) => x.id === store.state.selectedServerId)?.publicConfig
  if (failedChecks < 2 || failingOver || !(store.state.settings.autoServer || onPublic)) return
  failingOver = true
  void (async () => {
    const current = store.state.selectedServerId
    core.log('Auto: the server stopped responding, looking for another one', 'warn')
    await pingAll('server stopped responding')
    if ((store.state.servers.find((x) => x.id === current)?.latency ?? -1) >= 0) return core.log('Auto: the server responds again, staying on it')
    let best = onPublic ? lowestLatency(publicServers(), current) : bestServer(current)
    if (!best && onPublic) {
      await refreshPublicConfigs().catch((e) => core.log(`Public configs: ${e instanceof Error ? e.message : e}`, 'warn'))
      best = lowestLatency(publicServers(), current)
    }
    if (!best) return core.log('Auto: no other server responds either, staying on the current one', 'warn')
    store.update((st) => (st.selectedServerId = best.id))
    pushState()
    core.log(`Auto: switching to ${best.name} (${best.latency} ms)`)
    if (!(await core.switchServer(best).catch(() => false))) await core.start(best, store.state.settings, store.state.appRules, switchableServers(best.id))
  })()
    .catch((e) => core.log(`Auto: switching failed: ${e instanceof Error ? e.message : e}`, 'error'))
    .finally(() => {
      failingOver = false
      failedChecks = 0
    })
}

// When Cloudflare's WARP service is blocked, Free WARP creates its account through one of the
// user's own servers: the one with the best ping, or else the first one.
// A public config never gets to see the account being created.
core.warpHelper = () => lowestLatency(ownServers()) ?? ownServers().find((s) => !isWarp(s))
// A saved WARP config's gateway stopped answering and the scan found another: keep the new one.
core.onWarpPeer = (id, peer, method) => {
  const server = store.state.servers.find((s) => s.id === id)
  if (!server?.warp) return
  store.update(() => (server.warp = { ...server.warp!, peer, method }))
  pushState()
}

// ---------- updates ----------

const UPDATE_CHECK_EVERY_MS = 6 * 3600_000
const RELEASES_PAGE = 'https://github.com/m4hdisa/Bridge-app/releases/latest'
let update: UpdateStatus = { state: 'idle', current: app.getVersion() }

function setUpdate(u: UpdateStatus): void {
  update = u
  send('update', u)
}

/** Background checks stay quiet on failure (no internet, GitHub blocked); the UI check shows the error. */
async function checkUpdate(quiet: boolean): Promise<void> {
  if (['checking', 'downloading', 'installing'].includes(update.state)) return
  const before = update
  setUpdate({ ...update, state: 'checking', error: undefined })
  try {
    const result = await checkForUpdate()
    if (result.update && result.update.version !== before.update?.version) core.log(`Bridge ${result.update.version} is available (this is ${result.current})`)
    setUpdate(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    core.log(`Update check failed: ${msg}`, 'warn')
    setUpdate(quiet ? before : { ...before, state: 'error', error: `Could not check for updates: ${msg}` })
  }
}

async function installUpdate(): Promise<void> {
  const u = update.update
  if (update.state !== 'available' && update.state !== 'error') return
  if (!u?.installerUrl) {
    await shell.openExternal(u?.pageUrl ?? RELEASES_PAGE)
    return
  }
  setUpdate({ ...update, state: 'downloading', progress: 0, error: undefined })
  let file: string
  let shown = 0
  try {
    file = await downloadInstaller(u.installerUrl, (p) => {
      // One message per percent is plenty for a progress bar.
      if (p - shown >= 0.01) setUpdate({ ...update, progress: (shown = p) })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    setUpdate({ ...update, state: 'error', error: `Update download failed: ${msg}` })
    throw new Error(`Update download failed: ${msg}`)
  }
  setUpdate({ ...update, state: 'installing', progress: 1 })
  core.log(`Installing Bridge ${u.version}; Bridge restarts when it's done`)
  await core.stop()
  runInstaller(file)
  quitting = true
  app.quit()
}

// ---------- connect ----------

async function connect(): Promise<void> {
  const { settings, appRules } = store.state
  if (usesTun(settings.mode) && !(await isAdmin())) {
    throw new Error('VPN (TUN) and Per-App modes need administrator rights. Use "Restart as admin".')
  }
  if (settings.autoServer) await pickBestServer()
  const server = store.state.servers.find((s) => s.id === store.state.selectedServerId)
  if (!server) throw new Error('Select a server first')
  await core.start(server, settings, appRules, switchableServers(server.id))
}

/** Most servers kept ready next to the one in use; each is one outbound in the config. */
const MAX_ALTERNATES = 100

/**
 * Servers to keep ready in the running config, so picking one of them while connected switches
 * at once (see Core.switchServer): only those sing-box runs itself, and only those that answered
 * their last test, fastest first.
 */
function switchableServers(currentId: string): ServerProfile[] {
  return store.state.servers
    .filter((s) => s.id !== currentId && !isWarp(s) && s.engine !== 'xray' && !s.xrayOnly && (s.latency ?? -1) >= 0)
    .sort((a, b) => a.latency! - b.latency!)
    .slice(0, MAX_ALTERNATES)
}

/** Moves a running connection to the selected server: at once when it is ready, else by reconnecting. */
async function moveToSelected(): Promise<void> {
  const server = store.state.servers.find((s) => s.id === store.state.selectedServerId)
  if (server && (await core.switchServer(server).catch(() => false))) return
  await connect()
}

/** Restarts the core when the server or settings change while connected. */
async function reconnectIfRunning(): Promise<void> {
  if (core.status.state === 'running') await connect()
}

// ---------- IPC ----------

const iconCache = new Map<string, string>()
async function withIcon(p: RunningProcess): Promise<RunningProcess> {
  if (!iconCache.has(p.path)) {
    try {
      iconCache.set(p.path, (await app.getFileIcon(p.path, { size: 'normal' })).toDataURL())
    } catch {
      iconCache.set(p.path, '')
    }
  }
  return { ...p, icon: iconCache.get(p.path) || undefined }
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

handle('getState', () => store.state)
handle('getStatus', () => core.status)
handle('getLogs', () => core.logs)

/** Share links are added as they are; an https:// address among them is a subscription or a panel. */
async function importLinks(text: string): Promise<ImportResult> {
  const links = extractLinks(text)
  const isUrl = (l: string) => /^https?:\/\//i.test(l)
  const result = addLinks(links.filter((l) => !isUrl(l)))
  for (const url of links.filter(isUrl)) {
    const known = store.state.subscriptions.find((s) => s.url === url)
    const added = known ? await refreshSubscription(known.id) : await addSubscription('', url)
    result.added += added.added
    result.errors.push(...added.errors)
  }
  return withAutoPing(result, 'new servers')
}

async function addSubscription(name: string, url: string): Promise<ImportResult> {
  const id = randomUUID()
  // An empty name is filled from the panel's own title on the first update.
  store.update((s) => s.subscriptions.push({ id, name, url }))
  pushState()
  return refreshSubscription(id)
}

handle('importText', (text: string) => importLinks(text))
handle('importClipboard', () => importLinks(clipboard.readText()))
handle('removeServer', (id: string) => {
  if (store.state.servers.find((x) => x.id === id)?.warp?.shared) core.removeSharedWarpAccount(id)
  store.update((s) => {
    s.servers = s.servers.filter((x) => x.id !== id)
    if (s.selectedServerId === id) s.selectedServerId = s.servers[0]?.id
  })
  pushState()
})
handle('selectServer', async (id: string) => {
  const auto = id === AUTO_SERVER
  const before = store.state.selectedServerId
  store.update((s) => {
    s.settings.autoServer = auto
    if (!auto) s.selectedServerId = id
  })
  pushState()
  if (core.status.state !== 'running') return
  if (auto) await pickBestServer()
  // Move only if the server actually changed.
  if (store.state.selectedServerId !== before) await moveToSelected()
})
handle('setServerEngine', async (id: string, engine: Engine) => {
  const server = store.state.servers.find((s) => s.id === id)
  if (!server) throw new Error('Server not found')
  if (isWarp(server) || engine === 'aether') throw new Error('Only the free WARP server runs on the WARP core')
  if (engine === 'xray' && !server.xray) throw new Error('Xray cannot run this server')
  if (engine === 'sing-box' && server.xrayOnly) throw new Error('sing-box cannot run this server')
  store.update(() => {
    server.engine = engine
    server.latency = undefined
  })
  pushState()
  if (store.state.selectedServerId === id) await reconnectIfRunning()
})
handle('addWarpServer', async () => {
  let server = store.state.servers.find((s) => isWarp(s) && !isWarpConfig(s))
  store.update((s) => {
    if (!server) s.servers.unshift((server = newWarpServer()))
    s.selectedServerId = server.id
    s.settings.autoServer = false
  })
  pushState()
  await reconnectIfRunning()
})
handle('findWarpConfigs', async () => {
  const found = await core.findWarpConfigs()
  // Exits outside Iran first, since those open the sites that refuse Iranian users. Then the
  // fastest; those whose speed couldn't be measured go by how fast they connected.
  const inIran = (f: (typeof found)[number]) => (f.exit && f.exit !== 'IR' ? 0 : 1)
  found.sort((a, b) => inIran(a) - inIran(b) || (b.downMbps ?? 0) - (a.downMbps ?? 0) || a.readyMs - b.readyMs)
  store.update((s) => {
    // Configs someone sent stay: their accounts can't be found again.
    const old = new Set(s.servers.filter((x) => isWarpConfig(x) && !x.warp?.shared).map((x) => x.id))
    const configs = found.map(newWarpConfig)
    let at = s.servers.findIndex((x) => isWarp(x) && !isWarpConfig(x))
    if (at < 0) s.servers.unshift(newWarpServer()), (at = 0)
    s.servers = s.servers.filter((x) => !old.has(x.id))
    s.servers.splice(at + 1, 0, ...configs)
    // The selected config was replaced: pick the best new one, or plain Free WARP.
    if (s.selectedServerId && old.has(s.selectedServerId)) s.selectedServerId = (configs[0] ?? s.servers[at]).id
  })
  pushState()
  return found.length
})
handle('shareWarp', async (id: string) => {
  const server = store.state.servers.find((s) => s.id === id)
  if (!server) throw new Error('Server not found')
  const link = await core.shareWarpLink(server)
  clipboard.writeText(link)
  return link
})
/** A running WARP connection on the user's own account gets the new plan by connecting again. */
async function reconnectIfOnOwnWarp(): Promise<void> {
  const server = store.state.servers.find((s) => s.id === store.state.selectedServerId)
  if (server && isWarp(server) && !server.warp?.shared) await reconnectIfRunning()
}
handle('setWarpKey', async (key: string) => {
  const account = await core.setWarpKey(String(key).trim())
  store.update((s) => (s.warpPlus = { accountType: account.accountType, at: Date.now() }))
  pushState()
  await reconnectIfOnOwnWarp()
})
handle('clearWarpKey', async () => {
  await core.clearWarpKey()
  store.update((s) => delete s.warpPlus)
  pushState()
  await reconnectIfOnOwnWarp()
})
handle('setWarpMethod', async (id: string, method: WarpOptions['method']) => {
  const server = store.state.servers.find((s) => s.id === id)
  if (!server || !isWarp(server)) throw new Error('Not the WARP server')
  store.update(() => (server.warp = { method }))
  pushState()
  if (store.state.selectedServerId === id) await reconnectIfRunning()
})
handle('testLatency', async (ids?: string[]) => {
  await ping(store.state.servers.filter((s) => !ids || ids.includes(s.id)))
  if (!ids) lastPingAt = Date.now()
})

handle('addSubscription', async (name: string, url: string) => withAutoPing(await addSubscription(name, url), 'subscription added'))
handle('updateSubscription', async (id: string) => {
  if (store.state.subscriptions.find((s) => s.id === id)?.public) return refreshPublicConfigs()
  return withAutoPing(await refreshSubscription(id), 'subscription updated')
})
handle('addPublicConfigs', () => refreshPublicConfigs())
handle('removeSubscription', (id: string) => {
  if (publicRun && store.state.subscriptions.find((s) => s.id === id)?.public) throw new Error('Still looking for public configs; try again when it finishes')
  store.update((s) => {
    s.subscriptions = s.subscriptions.filter((x) => x.id !== id)
    s.servers = s.servers.filter((x) => x.subscriptionId !== id)
    if (!s.servers.some((x) => x.id === s.selectedServerId)) s.selectedServerId = s.servers[0]?.id
  })
  pushState()
})

handle('updateSettings', async (patch: Partial<Settings>) => {
  // Auto ping, Auto server, the Discord activity, the language and the button's look don't change the running connection.
  const connectionPart = ({ autoPing: _p, autoServer: _a, showInDiscord: _d, language: _l, buttonStyle: _b, ...rest }: Settings) => JSON.stringify(rest)
  const before = connectionPart(store.state.settings)
  const pingWasOn = store.state.settings.autoPing
  store.update((s) => Object.assign(s.settings, patch))
  pushState()
  discord.setEnabled(store.state.settings.showInDiscord)
  updateTray()
  if (!pingWasOn) autoPing('turned on')
  if (connectionPart(store.state.settings) !== before) await reconnectIfRunning()
})

// App rule changes are applied live (no core restart, so the connection never drops).
handle('saveAppRule', async (rule: AppRule) => {
  let oldPath: string | undefined
  store.update((s) => {
    const i = s.appRules.findIndex((r) => r.id === rule.id || r.path.toLowerCase() === rule.path.toLowerCase())
    if (i >= 0) {
      oldPath = s.appRules[i].path
      s.appRules[i] = { ...rule, id: s.appRules[i].id }
    } else s.appRules.push(rule)
  })
  pushState()
  // true: more apps on the VPN than the Per-App driver's inbounds, so reconnect to make more.
  if (await core.updateAppRules(store.state.appRules, oldPath ? [oldPath, rule.path] : [rule.path])) await reconnectIfRunning()
})
handle('removeAppRule', async (id: string) => {
  const removed = store.state.appRules.find((r) => r.id === id)
  store.update((s) => (s.appRules = s.appRules.filter((r) => r.id !== id)))
  pushState()
  await core.updateAppRules(store.state.appRules, removed ? [removed.path] : [])
})
handle('listProcesses', async () => Promise.all((await listProcesses()).map(withIcon)))
handle('pickExe', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose an app', filters: [{ name: 'Programs', extensions: ['exe'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return undefined
  const path = r.filePaths[0]
  return withIcon({ name: path.split('\\').pop()!, path })
})

handle('getUpdate', () => update)
handle('checkUpdate', () => checkUpdate(false))
handle('installUpdate', () => installUpdate())
handle('openUpdatePage', () => shell.openExternal(update.update?.pageUrl ?? RELEASES_PAGE))

handle('connect', () => connect())
handle('disconnect', () => core.stop())
handle('checkHealth', () => core.checkHealth())
handle('getSpeedTest', () => speedTest)
handle('runSpeedTest', async () => {
  if (speedTest.running) return
  const server = store.state.servers.find((s) => s.id === core.status.serverId)
  if (core.status.state !== 'running' || !server) throw new Error('Connect first, then run the speed test')
  speedAbort = new AbortController()
  const previous = speedTest.result
  setSpeedTest({ running: true, result: previous })
  try {
    const result = await core.speedTest(server, (path, phase, mbps) => setSpeedTest({ running: true, result: previous, path, phase, mbps }), speedAbort.signal)
    setSpeedTest({ running: false, result })
  } catch (e) {
    const stopped = speedAbort.signal.aborted
    setSpeedTest({ running: false, result: previous, error: stopped ? undefined : e instanceof Error ? e.message : String(e) })
  }
})
handle('stopSpeedTest', () => speedAbort?.abort())
handle('findMtu', () => core.findMtu(store.state.servers.find((s) => s.id === (core.status.serverId ?? store.state.selectedServerId))))
handle('isAdmin', () => isAdmin())
handle('perAppDriver', () => perAppDriverReady())
let installingDriver: Promise<boolean> | undefined
handle('installPerAppDriver', () => {
  installingDriver ??= installPerAppDriver(join(resourcesDir, 'proxifyre', 'install-driver.ps1'), (text, level) => core.log(text, level)).finally(() => (installingDriver = undefined))
  return installingDriver
})
handle('relaunchAsAdmin', async () => {
  await core.stop()
  await relaunchAsAdmin(process.execPath, process.argv.slice(1))
  quitting = true
  app.quit()
})

// ---------- window & tray ----------

function iconPath(): string {
  return join(resourcesDir, 'icon.png')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    title: 'Bridge',
    icon: iconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) return createWindow()
  win.show()
  win.focus()
}

function updateTray(): void {
  if (!tray) return
  const running = core.status.state === 'running'
  const server = store.state.servers.find((s) => s.id === store.state.selectedServerId)
  const fa = store.state.settings.language === 'fa'
  tray.setToolTip(running ? (fa ? `Bridge: وصل (${server?.name ?? ''})` : `Bridge: connected (${server?.name ?? ''})`) : fa ? 'Bridge: قطع' : 'Bridge: disconnected')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: fa ? 'باز کردن Bridge' : 'Open Bridge', click: showWindow },
      { type: 'separator' },
      running
        ? { label: fa ? 'قطع اتصال' : 'Disconnect', click: () => void core.stop() }
        : { label: fa ? 'اتصال' : 'Connect', enabled: !!server, click: () => void connect().catch((e) => core.log(String(e.message ?? e), 'error')) },
      { type: 'separator' },
      { label: fa ? 'خروج' : 'Quit', click: () => { quitting = true; app.quit() } }
    ])
  )
}

app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  // If a previous run crashed while connected, undo what it left behind: its engines (a sing-box
  // left in a TUN mode would keep slowing every app), the system proxy setting, and fake IPs in
  // Windows' DNS cache.
  const engines = [join(resourcesDir, 'core', 'sing-box.exe'), join(resourcesDir, 'xray', 'xray.exe'), join(resourcesDir, 'aether', 'aether.exe'), join(resourcesDir, 'aether', 'pt', 'psiphon-tunnel-core.exe')]
  const leftover = await stopLeftoverEngines(engines).catch(() => 0)
  if (leftover) core.log(`Stopped ${leftover} engine program(s) a previous run of Bridge left running`, 'warn')
  await clearSystemProxy(store.state.settings.mixedPort).catch(() => undefined)
  // and Per-App's driver and DNS rule (its watchdog normally undoes those; this needs admin rights).
  if (await isAdmin()) {
    await stopPerApp().catch(() => undefined)
    if (await restoreDns().catch(() => false)) core.log('Removed the DNS rule a previous run left behind')
  }
  await flushDns()
  createWindow()
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }))
  tray.on('click', showWindow)
  updateTray()
  discord.setEnabled(store.state.settings.showInDiscord)
  // Keep subscriptions (configs, usage, expiry) and every server's ping current without the
  // user pressing Update or Test.
  setTimeout(() => void refreshDueSubscriptions().then(() => autoPing('startup')), 10_000)
  setInterval(() => void refreshDueSubscriptions().then(() => autoPing('every 10 minutes')), AUTO_PING_EVERY_MS)
  // Look for a new Bridge shortly after start and then a few times a day.
  setTimeout(() => void checkUpdate(true), 20_000)
  setInterval(() => void checkUpdate(true), UPDATE_CHECK_EVERY_MS)
})

app.on('before-quit', (e) => {
  quitting = true
  discord.dispose()
  if (core.status.state !== 'stopped') {
    e.preventDefault()
    void core.stop().finally(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  // Keep running in the tray.
})
