// Types shared by the main process (Node) and the renderer (UI).

export type Protocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'tuic'

/** A sing-box outbound object, without its `tag` (the tag is assigned when the config is built). */
export type Outbound = Record<string, unknown> & { type: Protocol }

export interface ServerProfile {
  id: string
  name: string
  protocol: Protocol
  server: string
  port: number
  /** The original share link this profile was imported from. */
  link: string
  outbound: Outbound
  subscriptionId?: string
  /** Last measured latency in ms; -1 means the test failed, undefined means never tested. */
  latency?: number
  /**
   * Which core talks to this server. "xray" is chosen automatically for configs only
   * Xray understands (xhttp, VLESS Encryption...); the user can also switch manually.
   * Missing means "sing-box".
   */
  engine?: Engine
  /** The Xray outbound for this server, when Xray can run it. */
  xray?: Record<string, unknown>
  /** True when sing-box can't run this server at all (then `outbound` is only a placeholder). */
  xrayOnly?: boolean
}

export type Engine = 'sing-box' | 'xray'

/** A config in a subscription that Bridge can't use, and why. */
export interface SkippedConfig {
  name: string
  /** Protocol and transport as far as they could be read, e.g. "vless / xhttp". */
  kind: string
  reason: string
}

export interface Subscription {
  id: string
  name: string
  url: string
  updatedAt?: number
  /**
   * Traffic info from the `subscription-userinfo` response header, when the panel sends it.
   * Panels that don't send it often put "120 GB Left / 26 Days" in a config name instead;
   * then only `remaining` and `expire` are known (total is 0).
   */
  usage?: { upload: number; download: number; total: number; expire?: number; remaining?: number }
  lastError?: string
  /** How many configs the subscription contained last time (supported or not). */
  total?: number
  skipped?: SkippedConfig[]
  /** Auto-update interval in hours (from the panel's `profile-update-interval` header, default 12). */
  updateHours?: number
}

/**
 * system-proxy: only apps that respect the Windows proxy setting go through the VPN.
 * tun:          everything goes through the VPN (except apps marked direct/block).
 * per-app:      only apps marked "proxy" go through the VPN, everything else is direct.
 * proxy-only:   just a local SOCKS5/HTTP proxy; nothing on the system is changed.
 */
export type ConnectionMode = 'system-proxy' | 'tun' | 'per-app' | 'proxy-only'

/** Modes that create the TUN adapter (and need administrator rights). */
export function usesTun(mode: ConnectionMode): boolean {
  return mode === 'tun' || mode === 'per-app'
}

/**
 * proxy:  through Bridge's VPN server.
 * direct: straight out of the real Wi-Fi / Ethernet adapter.
 * other:  handed to another VPN tool's adapter (e.g. EZConnect for Discord / games).
 * block:  no network.
 */
export type AppAction = 'proxy' | 'direct' | 'other' | 'block'

export interface AppRule {
  id: string
  name: string
  /** Full path to the .exe. Matching is case-insensitive. */
  path: string
  action: AppAction
  enabled: boolean
  /** Icon as a data: URL, captured when the app was added. */
  icon?: string
}

export interface Settings {
  mode: ConnectionMode
  /** Send Iranian sites (.ir, geosite-ir, geoip-ir) direct instead of through the VPN. */
  bypassIran: boolean
  /** Local HTTP+SOCKS port used in system-proxy mode. */
  mixedPort: number
  /** URL used for real latency tests. */
  testUrl: string
  /**
   * sing-box strict_route: blocks DNS outside the TUN adapter (stops DNS leaks) but also
   * breaks other VPN / game tools running alongside Bridge. Off by default.
   */
  strictRoute: boolean
  /**
   * How names are answered in TUN modes.
   * real:   real IPs from a clean DNS-over-HTTPS resolver. Other tools that work by IP
   *         (game boosters like EZConnect, WARP split tunnels) keep working. Default.
   * fakeip: instant fake IPs (198.18.x.x); slightly faster, but breaks such tools.
   */
  dnsMode: 'real' | 'fakeip'
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export interface AppState {
  servers: ServerProfile[]
  subscriptions: Subscription[]
  selectedServerId?: string
  appRules: AppRule[]
  settings: Settings
}

export type CoreState = 'stopped' | 'starting' | 'running' | 'stopping'

export interface HealthCheck {
  ok: boolean
  /** Round-trip time of a real request, in ms. */
  latency?: number
  error?: string
  checkedAt: number
}

export interface Health {
  /** A request through the VPN server. */
  server?: HealthCheck
  /** A request over the normal internet (what Direct apps use). */
  internet?: HealthCheck
}

export interface CoreStatus {
  state: CoreState
  mode?: ConnectionMode
  serverId?: string
  startedAt?: number
  error?: string
  /** Checked right after connecting and then every 20 seconds while connected. */
  health?: Health
  /** Other tunnels (VPNs, game boosters) that were active when connecting. */
  otherTunnels?: string[]
  /** Local SOCKS5/HTTP proxy port while running. */
  proxyPort?: number
  /** Where traffic leaves the VPN, looked up through the VPN shortly after connecting. */
  exit?: ExitLocation
}

export interface ExitLocation {
  ip: string
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  countryCode: string
  country: string
  city?: string
}

/** Where an app's open connections go: through the VPN, direct, or some of each. */
export type AppRoute = 'vpn' | 'direct' | 'mixed'

export interface AppTraffic {
  path: string
  name: string
  upload: number
  download: number
  connections: number
  route?: AppRoute
}

export interface TrafficStats {
  /** Bytes per second. */
  upSpeed: number
  downSpeed: number
  /** Bytes since connect. */
  upTotal: number
  downTotal: number
  apps: AppTraffic[]
}

export interface RunningProcess {
  name: string
  path: string
  icon?: string
}

export interface LogLine {
  time: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface ImportResult {
  added: number
  errors: string[]
}

/** The API the preload script exposes to the UI as `window.bridge`. */
export interface BridgeApi {
  getState(): Promise<AppState>
  getStatus(): Promise<CoreStatus>
  getLogs(): Promise<LogLine[]>

  importText(text: string): Promise<ImportResult>
  importClipboard(): Promise<ImportResult>
  removeServer(id: string): Promise<void>
  selectServer(id: string): Promise<void>
  /** Switch which core runs a server (only when both can). */
  setServerEngine(id: string, engine: Engine): Promise<void>
  testLatency(ids?: string[]): Promise<void>

  addSubscription(name: string, url: string): Promise<ImportResult>
  updateSubscription(id: string): Promise<ImportResult>
  removeSubscription(id: string): Promise<void>

  updateSettings(patch: Partial<Settings>): Promise<void>

  saveAppRule(rule: AppRule): Promise<void>
  removeAppRule(id: string): Promise<void>
  listProcesses(): Promise<RunningProcess[]>
  pickExe(): Promise<RunningProcess | undefined>

  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Re-checks server and internet health now (result arrives through onStatus). */
  checkHealth(): Promise<void>

  isAdmin(): Promise<boolean>
  relaunchAsAdmin(): Promise<void>

  onState(cb: (state: AppState) => void): () => void
  onStatus(cb: (status: CoreStatus) => void): () => void
  onStats(cb: (stats: TrafficStats) => void): () => void
  onLog(cb: (line: LogLine) => void): () => void
}
