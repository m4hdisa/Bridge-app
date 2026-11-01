import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Core } from './core'
import { lookupExit } from './geo'
import { describeLink, extractLinks, parseLink } from './parser'
import { Store } from './store'
import { fetchSubscription } from './subscription'
import { clearSystemProxy, flushDns, isAdmin, listProcesses, relaunchAsAdmin } from './system'
import { checkForUpdate, downloadInstaller, runInstaller } from './updater'
import { isWarp, isWarpConfig, newWarpConfig, newWarpServer } from './warp'
import { AUTO_SERVER, usesTun } from '../shared/types'
import type { AppRule, CoreStatus, Engine, ImportResult, LogLine, RunningProcess, ServerProfile, Settings, SkippedConfig, UpdateStatus, WarpOptions } from '../shared/types'

if (!app.requestSingleInstanceLock()) app.quit()

const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
const dataDir = app.getPath('userData')
const store = new Store(join(dataDir, 'state.json'))
const core = new Core({
  singBox: join(resourcesDir, 'core', 'sing-box.exe'),
  xray: join(resourcesDir, 'xray', 'xray.exe'),
  aether: join(resourcesDir, 'aether', 'aether.exe'),
  rulesDir: join(resourcesDir, 'rules'),
  dataDir: join(dataDir, 'core')
})

let win: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function pushState(): void {
  send('state', store.state)
  updateTray()
}

// Look up the VPN's exit location once per connection (keyed by its start time).
let exitLookedUpFor: number | undefined
core.on('status', (s) => {
  send('status', s)
  updateTray()
  watchHealth(s)
  if (s.state === 'running' && s.startedAt && s.startedAt !== exitLookedUpFor && core.probePort) {
    exitLookedUpFor = s.startedAt
    const port = core.probePort
    setTimeout(() => {
      void lookupExit(port).then((exit) => {
        if (core.status.startedAt !== s.startedAt) return
        if (exit) {
          core.log(`VPN exit: ${exit.ip} (${exit.city ? exit.city + ', ' : ''}${exit.country})`)
          core.setExit(exit)
        } else core.log('Could not look up the VPN exit location', 'warn')
      })
    }, 1000)
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
    s.servers.push(...servers)
    if (!s.selectedServerId && s.servers.length) s.selectedServerId = s.servers[0].id
  })
  pushState()
  return importResult(servers.length, skipped)
}

async function refreshSubscription(id: string): Promise<ImportResult> {
  const sub = store.state.subscriptions.find((s) => s.id === id)
  if (!sub) throw new Error('Subscription not found')
  try {
    const { links, usage, title, updateHours } = await fetchSubscription(sub.url)
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

/** Updates every subscription whose update interval has passed. Errors are kept on the subscription. */
async function refreshDueSubscriptions(): Promise<void> {
  for (const sub of store.state.subscriptions) {
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
    const results = await core.testLatency(store.state.servers, store.state.settings.testUrl)
    store.update((s) => {
      for (const server of s.servers) if (results.has(server.id)) server.latency = results.get(server.id)
    })
    lastPingAt = Date.now()
    pushState()
  })().finally(() => (pingRun = undefined))
  return pingRun
}

/** Background ping, when the user has it on (Settings, "Ping servers automatically"). */
function autoPing(reason: string): void {
  if (store.state.settings.autoPing) void pingAll(reason).catch((e) => core.log(`Auto ping failed: ${e instanceof Error ? e.message : e}`, 'warn'))
}

/** The responding server with the lowest latency. */
function bestServer(exclude?: string): ServerProfile | undefined {
  return store.state.servers
    .filter((s) => s.id !== exclude && s.latency !== undefined && s.latency >= 0)
    .sort((a, b) => a.latency! - b.latency!)[0]
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
  if (failedChecks < 2 || failingOver || !store.state.settings.autoServer) return
  failingOver = true
  void (async () => {
    const current = store.state.selectedServerId
    core.log('Auto: the server stopped responding, looking for another one', 'warn')
    await pingAll('server stopped responding')
    if ((store.state.servers.find((x) => x.id === current)?.latency ?? -1) >= 0) return core.log('Auto: the server responds again, staying on it')
    const best = bestServer(current)
    if (!best) return core.log('Auto: no other server responds either, staying on the current one', 'warn')
    store.update((st) => (st.selectedServerId = best.id))
    pushState()
    core.log(`Auto: switching to ${best.name} (${best.latency} ms)`)
    await core.start(best, store.state.settings, store.state.appRules)
  })()
    .catch((e) => core.log(`Auto: switching failed: ${e instanceof Error ? e.message : e}`, 'error'))
    .finally(() => {
      failingOver = false
      failedChecks = 0
    })
}

// When Cloudflare's WARP service is blocked, Free WARP creates its account through one of the
// user's own servers: the one with the best ping, or else the first one.
core.warpHelper = () => bestServer() ?? store.state.servers.find((s) => !isWarp(s))
// A saved WARP config's gateway stopped answering and the scan found another: keep the new one.
core.onWarpPeer = (id, peer) => {
  const server = store.state.servers.find((s) => s.id === id)
  if (!server?.warp) return
  store.update(() => (server.warp = { ...server.warp!, peer }))
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
  await core.start(server, settings, appRules)
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

handle('importText', (text: string) => withAutoPing(addLinks(extractLinks(text)), 'new servers'))
handle('importClipboard', () => withAutoPing(addLinks(extractLinks(clipboard.readText())), 'new servers'))
handle('removeServer', (id: string) => {
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
  // Reconnect only if the server actually changed.
  if (store.state.selectedServerId !== before) await connect()
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
  // Gool first (its exit is outside Iran), then the fastest.
  found.sort((a, b) => Number(b.method === 'gool') - Number(a.method === 'gool') || a.readyMs - b.readyMs)
  store.update((s) => {
    const old = new Set(s.servers.filter(isWarpConfig).map((x) => x.id))
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
handle('setWarpMethod', async (id: string, method: WarpOptions['method']) => {
  const server = store.state.servers.find((s) => s.id === id)
  if (!server || !isWarp(server)) throw new Error('Not the WARP server')
  store.update(() => (server.warp = { method }))
  pushState()
  if (store.state.selectedServerId === id) await reconnectIfRunning()
})
handle('testLatency', async (ids?: string[]) => {
  const targets = store.state.servers.filter((s) => !ids || ids.includes(s.id))
  const results = await core.testLatency(targets, store.state.settings.testUrl)
  store.update((s) => {
    for (const server of s.servers) if (results.has(server.id)) server.latency = results.get(server.id)
  })
  if (!ids) lastPingAt = Date.now()
  pushState()
})

handle('addSubscription', async (name: string, url: string) => {
  const id = randomUUID()
  // An empty name is filled from the panel's own title on the first update.
  store.update((s) => s.subscriptions.push({ id, name, url }))
  pushState()
  return withAutoPing(await refreshSubscription(id), 'subscription added')
})
handle('updateSubscription', async (id: string) => withAutoPing(await refreshSubscription(id), 'subscription updated'))
handle('removeSubscription', (id: string) => {
  store.update((s) => {
    s.subscriptions = s.subscriptions.filter((x) => x.id !== id)
    s.servers = s.servers.filter((x) => x.subscriptionId !== id)
    if (!s.servers.some((x) => x.id === s.selectedServerId)) s.selectedServerId = s.servers[0]?.id
  })
  pushState()
})

handle('updateSettings', async (patch: Partial<Settings>) => {
  // Auto ping and Auto server don't change the running connection.
  const connectionPart = ({ autoPing: _p, autoServer: _a, ...rest }: Settings) => JSON.stringify(rest)
  const before = connectionPart(store.state.settings)
  const pingWasOn = store.state.settings.autoPing
  store.update((s) => Object.assign(s.settings, patch))
  pushState()
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
  await core.updateAppRules(store.state.appRules, oldPath ? [oldPath, rule.path] : [rule.path])
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
handle('isAdmin', () => isAdmin())
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
  tray.setToolTip(running ? `Bridge: connected (${server?.name ?? ''})` : 'Bridge: disconnected')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Bridge', click: showWindow },
      { type: 'separator' },
      running
        ? { label: 'Disconnect', click: () => void core.stop() }
        : { label: 'Connect', enabled: !!server, click: () => void connect().catch((e) => core.log(String(e.message ?? e), 'error')) },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } }
    ])
  )
}

app.on('second-instance', showWindow)

app.whenReady().then(async () => {
  // If a previous run crashed while connected, undo what it left behind:
  // the system proxy setting, and fake IPs in Windows' DNS cache.
  await clearSystemProxy(store.state.settings.mixedPort).catch(() => undefined)
  await flushDns()
  createWindow()
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }))
  tray.on('click', showWindow)
  updateTray()
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
  if (core.status.state !== 'stopped') {
    e.preventDefault()
    void core.stop().finally(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  // Keep running in the tray.
})
