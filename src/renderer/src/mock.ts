// Fake backend so the UI can run in a normal browser (npm run dev:ui).
// Nothing here touches the network or the system.
import type { AppState, BridgeApi, CoreStatus, LogLine, TrafficStats } from '../../shared/types'

type Listener<T> = (v: T) => void

export function createMockBridge(): BridgeApi {
  const state: AppState = {
    servers: [
      { id: 's1', name: 'Germany Reality', protocol: 'vless', server: '1.2.3.4', port: 443, link: '', outbound: { type: 'vless' }, latency: 182 },
      { id: 's2', name: 'Netherlands WS', protocol: 'vmess', server: 'nl.example.com', port: 443, link: '', outbound: { type: 'vmess' }, subscriptionId: 'sub1', latency: 640, engine: 'xray', xray: {} },
      { id: 's3', name: 'Finland Hysteria2', protocol: 'hysteria2', server: 'fi.example.com', port: 8443, link: '', outbound: { type: 'hysteria2' }, subscriptionId: 'sub1', latency: -1, engine: 'xray', xray: {}, xrayOnly: true }
    ],
    subscriptions: [
      {
        id: 'sub1',
        name: 'My provider',
        url: 'https://panel.example.com/sub/abc',
        updatedAt: Date.now() - 3600_000,
        usage: { upload: 2e9, download: 18e9, total: 200e9, expire: Math.floor(Date.now() / 1000) + 26 * 86400 },
        total: 5,
        updateHours: 12,
        skipped: [
          { name: 'VLESS-REALITY-XHTTP', kind: 'vless / xhttp / reality', reason: 'Transport "xhttp" is not supported by the sing-box core' },
          { name: '16423-IP', kind: 'vless / xhttp / reality', reason: 'Transport "xhttp" is not supported by the sing-box core' }
        ]
      }
    ],
    selectedServerId: 's1',
    appRules: [
      { id: 'r1', name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', action: 'proxy', enabled: true },
      { id: 'r2', name: 'Telegram.exe', path: 'C:\\Users\\me\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe', action: 'proxy', enabled: true },
      { id: 'r3', name: 'steam.exe', path: 'C:\\Program Files (x86)\\Steam\\steam.exe', action: 'direct', enabled: false }
    ],
    settings: { mode: 'per-app', bypassIran: true, mixedPort: 2080, strictRoute: false, dnsMode: 'real', testUrl: 'https://www.gstatic.com/generate_204', logLevel: 'info' }
  }
  let status: CoreStatus = { state: 'stopped' }
  const logs: LogLine[] = [{ time: Date.now(), level: 'info', text: 'Mock backend: running in the browser, nothing is real.' }]
  const listeners = { state: new Set<Listener<AppState>>(), status: new Set<Listener<CoreStatus>>(), stats: new Set<Listener<TrafficStats>>(), log: new Set<Listener<LogLine>>() }
  let timer: ReturnType<typeof setInterval> | undefined
  let total = { up: 0, down: 0 }

  const emitState = () => listeners.state.forEach((l) => l(structuredClone(state)))
  const setStatus = (s: CoreStatus) => {
    status = s
    listeners.status.forEach((l) => l(s))
  }
  const log = (text: string) => {
    const line: LogLine = { time: Date.now(), level: 'info', text }
    logs.push(line)
    listeners.log.forEach((l) => l(line))
  }
  const sub = <T>(set: Set<Listener<T>>) => (cb: Listener<T>) => {
    set.add(cb)
    return () => set.delete(cb)
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  return {
    getState: async () => structuredClone(state),
    getStatus: async () => status,
    getLogs: async () => logs,
    importText: async () => ({ added: 0, errors: ['Mock backend cannot import'] }),
    importClipboard: async () => ({ added: 0, errors: ['Mock backend cannot import'] }),
    removeServer: async (id) => {
      state.servers = state.servers.filter((s) => s.id !== id)
      emitState()
    },
    setServerEngine: async (id, engine) => {
      const s = state.servers.find((x) => x.id === id)
      if (s) s.engine = engine
      emitState()
    },
    selectServer: async (id) => {
      state.selectedServerId = id
      emitState()
    },
    testLatency: async () => {
      await wait(800)
      state.servers.forEach((s) => (s.latency = Math.random() < 0.2 ? -1 : Math.round(100 + Math.random() * 900)))
      emitState()
    },
    addSubscription: async () => ({ added: 0, errors: ['Mock backend cannot fetch'] }),
    updateSubscription: async () => ({ added: 0, errors: [] }),
    removeSubscription: async (id) => {
      state.subscriptions = state.subscriptions.filter((s) => s.id !== id)
      emitState()
    },
    updateSettings: async (patch) => {
      Object.assign(state.settings, patch)
      emitState()
    },
    saveAppRule: async (rule) => {
      const i = state.appRules.findIndex((r) => r.id === rule.id)
      if (i >= 0) state.appRules[i] = rule
      else state.appRules.push(rule)
      emitState()
    },
    removeAppRule: async (id) => {
      state.appRules = state.appRules.filter((r) => r.id !== id)
      emitState()
    },
    listProcesses: async () => [
      { name: 'Discord.exe', path: 'C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0\\Discord.exe' },
      { name: 'Code.exe', path: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' },
      { name: 'firefox.exe', path: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' }
    ],
    pickExe: async () => ({ name: 'example.exe', path: 'C:\\Apps\\example.exe' }),
    connect: async () => {
      setStatus({ state: 'starting', mode: state.settings.mode })
      await wait(700)
      const now = Date.now()
      setStatus({
        state: 'running',
        mode: state.settings.mode,
        serverId: state.selectedServerId,
        startedAt: now,
        proxyPort: 2080,
        otherTunnels: ['EZConnect (Wintun Userspace Tunnel)'],
        health: { server: { ok: true, latency: 412, checkedAt: now }, internet: { ok: true, latency: 96, checkedAt: now } }
      })
      log('Mock: connected')
      // Like the real app: the exit location arrives a moment after connecting.
      setTimeout(() => setStatus({ ...status, exit: { ip: '185.244.25.12', countryCode: 'DE', country: 'Germany', city: 'Frankfurt am Main' } }), 1500)
      total = { up: 0, down: 0 }
      timer = setInterval(() => {
        const up = Math.random() * 60_000
        const down = Math.random() * 900_000
        total.up += up
        total.down += down
        const stats: TrafficStats = {
          upSpeed: up,
          downSpeed: down,
          upTotal: total.up,
          downTotal: total.down,
          apps: [
            { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'chrome.exe', upload: total.up * 0.6, download: total.down * 0.7, connections: 12, route: 'vpn' },
            { path: 'C:\\Users\\me\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe', name: 'Telegram.exe', upload: total.up * 0.3, download: total.down * 0.2, connections: 3, route: 'vpn' },
            { path: 'C:\\Program Files (x86)\\Steam\\steam.exe', name: 'steam.exe', upload: total.up * 0.1, download: total.down * 0.1, connections: 0, route: 'direct' }
          ]
        }
        listeners.stats.forEach((l) => l(stats))
      }, 1000)
    },
    disconnect: async () => {
      clearInterval(timer)
      setStatus({ state: 'stopped' })
      log('Mock: disconnected')
    },
    // Alternates between healthy and "server down" so both states can be seen in the UI.
    checkHealth: async () => {
      await wait(600)
      const now = Date.now()
      const down = status.health?.server?.ok
      setStatus({
        ...status,
        health: {
          server: down ? { ok: false, error: 'No response (timeout)', checkedAt: now } : { ok: true, latency: 398, checkedAt: now },
          internet: { ok: true, latency: 88, checkedAt: now }
        }
      })
    },
    isAdmin: async () => true,
    relaunchAsAdmin: async () => undefined,
    onState: sub(listeners.state),
    onStatus: sub(listeners.status),
    onStats: sub(listeners.stats),
    onLog: sub(listeners.log)
  }
}
