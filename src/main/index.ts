import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Core } from './core'
import { extractLinks, parseLink } from './parser'
import { Store } from './store'
import { fetchSubscription } from './subscription'
import { clearSystemProxy, isAdmin, listProcesses, relaunchAsAdmin } from './system'
import type { AppRule, ImportResult, RunningProcess, ServerProfile, Settings } from '../shared/types'

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

function addLinks(links: string[], subscriptionId?: string): ImportResult {
  const result: ImportResult = { added: 0, errors: [] }
  const existing = new Set(store.state.servers.map((s) => s.link))
  const parsed: ServerProfile[] = []
  for (const link of links) {
    if (existing.has(link)) continue
    try {
      const p = parseLink(link)
      p.subscriptionId = subscriptionId
      parsed.push(p)
      existing.add(link)
    } catch (e) {
      result.errors.push(`${link.slice(0, 40)}...: ${e instanceof Error ? e.message : e}`)
    }
  }
  result.added = parsed.length
  store.update((s) => {
    s.servers.push(...parsed)
    if (!s.selectedServerId && s.servers.length) s.selectedServerId = s.servers[0].id
  })
  pushState()
  return result
}

async function refreshSubscription(id: string): Promise<ImportResult> {
  const sub = store.state.subscriptions.find((s) => s.id === id)
  if (!sub) throw new Error('Subscription not found')
  try {
    const { links, usage } = await fetchSubscription(sub.url)
    // Replace this subscription's servers, keeping the selection if the same link is still there.
    const selectedLink = store.state.servers.find((s) => s.id === store.state.selectedServerId)?.link
    store.update((s) => {
      s.servers = s.servers.filter((x) => x.subscriptionId !== id)
      Object.assign(sub, { updatedAt: Date.now(), usage, lastError: undefined })
    })
    const result = addLinks(links, id)
    const again = store.state.servers.find((s) => s.link === selectedLink)
    store.update((s) => {
      if (again) s.selectedServerId = again.id
      else if (!s.servers.some((x) => x.id === s.selectedServerId)) s.selectedServerId = s.servers[0]?.id
    })
    pushState()
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.update(() => (sub.lastError = msg))
    pushState()
    throw new Error(`Could not update "${sub.name}": ${msg}`)
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
  store.update((s) => s.subscriptions.push({ id, name: name || new URL(url).hostname, url }))
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
  // If a previous run crashed while the system proxy was on, turn it off.
  await clearSystemProxy(store.state.settings.mixedPort).catch(() => undefined)
  createWindow()
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }))
  tray.on('click', showWindow)
  updateTray()
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
