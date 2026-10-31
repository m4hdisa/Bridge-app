// Fake backend so the UI can run in a normal browser (npm run dev:ui).
// Nothing here touches the network or the system.
import type { AppState, BridgeApi, CoreStatus, LogLine, TrafficStats } from '../../shared/types'

type Listener<T> = (v: T) => void

export function createMockBridge(): BridgeApi {
  const state: AppState = {
    servers: [
      { id: 's1', name: 'Germany Reality', protocol: 'vless', server: '1.2.3.4', port: 443, link: '', outbound: { type: 'vless' }, latency: 182 },
      { id: 's2', name: 'Netherlands WS', protocol: 'vmess', server: 'nl.example.com', port: 443, link: '', outbound: { type: 'vmess' }, subscriptionId: 'sub1', latency: 640 },
      { id: 's3', name: 'Finland Hysteria2', protocol: 'hysteria2', server: 'fi.example.com', port: 8443, link: '', outbound: { type: 'hysteria2' }, subscriptionId: 'sub1', latency: -1 }
    ],
    subscriptions: [
      { id: 'sub1', name: 'My panel', url: 'https://panel.example.com/sub/abc', updatedAt: Date.now() - 3600_000, usage: { upload: 2e9, download: 18e9, total: 50e9 } }
    ],
    selectedServerId: 's1',
    appRules: [
      { id: 'r1', name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', action: 'proxy', enabled: true },
      { id: 'r2', name: 'Telegram.exe', path: 'C:\\Users\\me\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe', action: 'proxy', enabled: true },
      { id: 'r3', name: 'steam.exe', path: 'C:\\Program Files (x86)\\Steam\\steam.exe', action: 'direct', enabled: false }
    ],
    settings: { mode: 'per-app', bypassIran: true, mixedPort: 2080, remoteDns: 'https://1.1.1.1/dns-query', testUrl: 'https://www.gstatic.com/generate_204', logLevel: 'info' }
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
      setStatus({ state: 'running', mode: state.settings.mode, serverId: state.selectedServerId, startedAt: Date.now() })
      log('Mock: connected')
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
            { path: 'chrome.exe', name: 'chrome.exe', upload: total.up * 0.7, download: total.down * 0.8, connections: 12 },
            { path: 'Telegram.exe', name: 'Telegram.exe', upload: total.up * 0.3, download: total.down * 0.2, connections: 3 }
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
    isAdmin: async () => true,
    relaunchAsAdmin: async () => undefined,
    onState: sub(listeners.state),
    onStatus: sub(listeners.status),
    onStats: sub(listeners.stats),
    onLog: sub(listeners.log)
  }
}
