import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Core } from './core'
import { describeLink, extractLinks, parseLink } from './parser'
import { Store } from './store'
import { fetchSubscription } from './subscription'
import { clearSystemProxy, flushDns, isAdmin, listProcesses, relaunchAsAdmin } from './system'
import type { AppRule, ImportResult, RunningProcess, ServerProfile, Settings, SkippedConfig } from '../shared/types'

if (!app.requestSingleInstanceLock()) app.quit()

const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
const dataDir = app.getPath('userData')
const store = new Store(join(dataDir, 'state.json'))
const core = new Core({
  singBox: join(resourcesDir, 'core', 'sing-box.exe'),
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

core.on('status', (s) => {
  send('status', s)
  updateTray()
})
core.on('stats', (s) => send('stats', s))
core.on('log', (l) => send('log', l))

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

// ---------- connect ----------

async function connect(): Promise<void> {
  const { servers, selectedServerId, settings, appRules } = store.state
  const server = servers.find((s) => s.id === selectedServerId)
  if (!server) throw new Error('Select a server first')
  if (settings.mode !== 'system-proxy' && !(await isAdmin())) {
    throw new Error('VPN (TUN) and Per-App modes need administrator rights. Use "Restart as admin".')
  }
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

handle('importText', (text: string) => addLinks(extractLinks(text)))
handle('importClipboard', () => addLinks(extractLinks(clipboard.readText())))
handle('removeServer', (id: string) => {
  store.update((s) => {
    s.servers = s.servers.filter((x) => x.id !== id)
    if (s.selectedServerId === id) s.selectedServerId = s.servers[0]?.id
  })
  pushState()
})
handle('selectServer', async (id: string) => {
  store.update((s) => (s.selectedServerId = id))
  pushState()
  await reconnectIfRunning()
})
handle('testLatency', async (ids?: string[]) => {
  const targets = store.state.servers.filter((s) => !ids || ids.includes(s.id))
  const results = await core.testLatency(targets, store.state.settings.testUrl)
  store.update((s) => {
    for (const server of s.servers) if (results.has(server.id)) server.latency = results.get(server.id)
  })
  pushState()
})

handle('addSubscription', async (name: string, url: string) => {
  const id = randomUUID()
  // An empty name is filled from the panel's own title on the first update.
  store.update((s) => s.subscriptions.push({ id, name, url }))
  pushState()
  return refreshSubscription(id)
})
handle('updateSubscription', (id: string) => refreshSubscription(id))
handle('removeSubscription', (id: string) => {
  store.update((s) => {
    s.subscriptions = s.subscriptions.filter((x) => x.id !== id)
    s.servers = s.servers.filter((x) => x.subscriptionId !== id)
    if (!s.servers.some((x) => x.id === s.selectedServerId)) s.selectedServerId = s.servers[0]?.id
  })
  pushState()
})

handle('updateSettings', async (patch: Partial<Settings>) => {
  const before = JSON.stringify(store.state.settings)
  store.update((s) => Object.assign(s.settings, patch))
  pushState()
  if (JSON.stringify(store.state.settings) !== before) await reconnectIfRunning()
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
  // Keep subscriptions (configs, usage, expiry) current without the user pressing Update.
  setTimeout(() => void refreshDueSubscriptions(), 10_000)
  setInterval(() => void refreshDueSubscriptions(), 10 * 60_000)
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
