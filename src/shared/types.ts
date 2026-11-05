// Types shared by the main process (Node) and the renderer (UI).

export type Protocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'hysteria2' | 'tuic' | 'warp'

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
  /** Set on the built-in free WARP server (engine "aether"); its `outbound` is only a placeholder. */
  warp?: WarpOptions
  /** Set on configs from public lists, whose operators nobody knows: what was measured when found. Auto only uses them when there is nothing else. */
  publicConfig?: { downMbps?: number; exit?: string }
}

/** "aether" runs the built-in free WARP server (Cloudflare WARP, through the Aether core). */
export type Engine = 'sing-box' | 'xray' | 'aether'

/** How the free WARP server reaches Cloudflare. Which ones get through depends on the network. */
export type WarpMethod = 'gool' | 'gool-h3' | 'h3' | 'h2' | 'h2-fragment' | 'h2-ipv6' | 'wireguard'

export interface WarpOptions {
  /**
   * The two Auto modes try the methods at the same time. "auto" keeps the fastest one that works,
   * usually with an exit Cloudflare registers in Iran. "auto-foreign" waits for Gool, whose exit
   * is outside Iran but which is much slower, and uses another method if Gool doesn't get through.
   */
  method: WarpMethod | 'auto' | 'auto-foreign'
  /**
   * Set on configs found by "Find configs": the Cloudflare gateway ("ip:port") this method got
   * through on, so connecting skips the scan. Bridge scans again if it stops answering.
   */
  peer?: string
  /** Exit country Aether reported when the config was found, e.g. "DE". */
  exit?: string
  /** How long the tunnel took to come up when the config was found. */
  readyMs?: number
  /** Speed measured through this config when it was found. */
  downMbps?: number
  upMbps?: number
  /** Came from someone else's share link: it has a WARP account of its own, carried in its link. */
  shared?: boolean
}

/** One way through to WARP that "Find configs" proved on this network. */
export interface WarpFound {
  method: WarpMethod
  peer: string
  exit?: string
  readyMs: number
  downMbps?: number
  upMbps?: number
}

/** `auto`: raced by the "fastest" Auto mode. Gool joins only the "exit outside Iran" one. */
export const WARP_METHODS: { id: WarpMethod; label: string; hint: string; auto: boolean }[] = [
  { id: 'gool', label: 'Gool (WARP in WARP)', hint: 'Exits outside Iran: a second WARP hop is opened from inside the first, so Cloudflare gives a foreign address. Much slower than the others, upload most of all.', auto: false },
  { id: 'gool-h3', label: 'Gool over HTTP/3', hint: 'Gool with a faster download than plain Gool. Needs UDP, which some networks block.', auto: false },
  { id: 'h3', label: 'MASQUE over HTTP/3', hint: 'Fastest. Needs UDP, which some networks block (often Irancell).', auto: true },
  { id: 'h2', label: 'MASQUE over HTTP/2', hint: 'Runs over TCP, for networks that block QUIC / UDP.', auto: true },
  { id: 'h2-fragment', label: 'HTTP/2 + fragment', hint: 'Splits the TLS handshake, for networks that reset it (some home internet).', auto: true },
  { id: 'h2-ipv6', label: 'HTTP/2 over IPv6', hint: "For Hamrah-e Aval (MCI), which filters Cloudflare's IPv4 addresses. Needs IPv6.", auto: true },
  { id: 'wireguard', label: 'WireGuard', hint: 'Classic WARP. Usually blocked in Iran; not tried by Auto.', auto: false }
]

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
  /** The one that holds configs from public lists. It has no URL of its own. */
  public?: boolean
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
   * sing-box strict_route: blocks DNS outside the TUN adapter (stops DNS leaks and censored
   * answers) but also breaks other VPN / game tools running alongside Bridge. On by default.
   */
  strictRoute: boolean
  /**
   * How names are answered in TUN modes.
   * fakeip: instant fake IPs (198.18.x.x), and the VPN server looks up the sites of VPN apps.
   *         Breaks tools that work by IP (game boosters like EZConnect). Default.
   * real:   real IPs from a clean DNS-over-HTTPS resolver. Those tools keep working.
   */
  dnsMode: 'real' | 'fakeip'
  /** How the VPN adapter turns packets into connections. See TunStack. */
  tunStack: TunStack
  /** The VPN adapter's MTU. 0 is automatic (9000, the fastest for most servers). */
  tunMtu: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Ping every server on its own: at startup, after subscription updates and every 10 minutes. */
  autoPing: boolean
  /**
   * "Auto (best ping)": connect to the server with the lowest ping, and move to the best other
   * server if the current one stops responding. Chosen with selectServer(AUTO_SERVER).
   */
  autoServer: boolean
  /**
   * Show the connection status as the user's Discord activity (while the Discord app runs). On by
   * default. (0.4.5 called it discordActivity and had it off; the new name drops that saved value.)
   */
  showInDiscord: boolean
  /** The app's language: English, or Persian (right to left, Yekan Bakh). */
  language: 'en' | 'fa'
  /** The look of the connect button on the Dashboard. */
  buttonStyle: ButtonStyle
  /** Which defaults the saved settings have been moved to (see Store.load). */
  settingsVersion?: number
}

/** sing-box's TUN stacks. mixed: Windows' own TCP with gVisor's UDP (default). system: Windows' own for both. gvisor: gVisor for both. */
export type TunStack = 'mixed' | 'system' | 'gvisor'

/** dashboard: a round key with a status light, like a car's dashboard (default). classic: the glowing blue disc of 0.4.6-0.4.8. */
export type ButtonStyle = 'dashboard' | 'classic'

/** Server id the UI passes to selectServer() to turn on Auto (best ping). */
export const AUTO_SERVER = 'auto'

export interface AppState {
  servers: ServerProfile[]
  subscriptions: Subscription[]
  selectedServerId?: string
  appRules: AppRule[]
  settings: Settings
  /** Servers whose ping is being tested right now. Only in what the window sees; never saved. */
  pinging?: string[]
  /** Set while the user's own WARP+ key is on the Free WARP account. The key itself isn't kept. */
  warpPlus?: { accountType: string; at: number }
  /** What finding public configs is doing right now, with how many it is looking at. Never saved. */
  publicStatus?: { step: 'download' | 'warp' | 'test' | 'measure' | 'speed'; n?: number }
}

export type CoreState = 'stopped' | 'starting' | 'running' | 'stopping'

export interface HealthCheck {
  ok: boolean
  /** Round-trip time of a real request, in ms. */
  latency?: number
  error?: string
  checkedAt: number
}

/** How often Bridge checks the connection's health while connected. */
export const HEALTH_INTERVAL_MS = 20_000

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
  /** While connecting: when it began, and what Bridge is doing right now ("Finding a way through your network"). */
  connectingAt?: number
  progress?: string
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
/** Bridge's own updates, from GitHub Releases. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installing' | 'error'
  /** This build's version. */
  current: string
  checkedAt?: number
  update?: { version: string; title: string; notes: string; pageUrl: string; installerUrl?: string; size?: number }
  /** Download progress, 0 to 1. */
  progress?: number
  error?: string
}

/** The two ways the speed test reaches the VPN server. adapter: like an app, through the VPN adapter. core: straight into sing-box, skipping the adapter. */
export type SpeedPath = 'adapter' | 'core'

export interface SpeedResult {
  /** Megabits per second; missing if that direction could not be measured. */
  downMbps?: number
  upMbps?: number
  usedBytes: number
  error?: string
}

export interface SpeedTestResult {
  /** Only in Per-App and Full VPN: Proxy only has no adapter. */
  adapter?: SpeedResult
  core: SpeedResult
  serverName: string
  mode: ConnectionMode
  tunStack: TunStack
  tunMtu: number
  at: number
}

export interface SpeedTestStatus {
  running: boolean
  /** What is being measured right now. */
  path?: SpeedPath
  phase?: 'download' | 'upload'
  /** Megabits per second, right now. */
  mbps?: number
  result?: SpeedTestResult
  error?: string
}

export interface MtuResult {
  /** The largest packet that reaches the target without being split, in bytes. */
  pathMtu: number
  target: string
  /** The adapter MTU to use; missing when the path carries full-size packets and nothing needs changing. */
  recommended?: number
}

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
  /** Adds the built-in free WARP server (or returns the existing one) and selects it. */
  addWarpServer(): Promise<void>
  setWarpMethod(id: string, method: WarpOptions['method']): Promise<void>
  /** Tries every WARP method on this network (while disconnected) and saves the ones that work as configs. Returns how many. */
  findWarpConfigs(): Promise<number>
  /** Makes a share link for a WARP server or config, with a new WARP account made just for it. */
  shareWarp(id: string): Promise<string>
  /** Puts the user's own WARP+ key on the Free WARP account. */
  setWarpKey(key: string): Promise<void>
  clearWarpKey(): Promise<void>
  testLatency(ids?: string[]): Promise<void>

  addSubscription(name: string, url: string): Promise<ImportResult>
  updateSubscription(id: string): Promise<ImportResult>
  removeSubscription(id: string): Promise<void>
  /** Downloads public config lists, tests them on this network and keeps the best. */
  addPublicConfigs(): Promise<ImportResult>

  updateSettings(patch: Partial<Settings>): Promise<void>

  saveAppRule(rule: AppRule): Promise<void>
  removeAppRule(id: string): Promise<void>
  listProcesses(): Promise<RunningProcess[]>
  pickExe(): Promise<RunningProcess | undefined>

  connect(): Promise<void>
  disconnect(): Promise<void>
  /** Re-checks server and internet health now (result arrives through onStatus). */
  checkHealth(): Promise<void>

  getSpeedTest(): Promise<SpeedTestStatus>
  /** Measures the connected server's speed; progress and the result arrive through onSpeedTest. */
  runSpeedTest(): Promise<void>
  stopSpeedTest(): Promise<void>
  onSpeedTest(cb: (status: SpeedTestStatus) => void): () => void
  /** Finds the largest packet this network carries. */
  findMtu(): Promise<MtuResult>

  isAdmin(): Promise<boolean>
  relaunchAsAdmin(): Promise<void>

  onState(cb: (state: AppState) => void): () => void
  onStatus(cb: (status: CoreStatus) => void): () => void
  onStats(cb: (stats: TrafficStats) => void): () => void
  /** New log lines, delivered in batches (a few times a second) to keep the UI light under heavy traffic. */
  onLogs(cb: (lines: LogLine[]) => void): () => void
  getUpdate(): Promise<UpdateStatus>
  /** Asks GitHub for a newer version now. */
  checkUpdate(): Promise<void>
  /** Downloads the new installer, closes Bridge and installs it; Bridge starts again afterwards. */
  installUpdate(): Promise<void>
  openUpdatePage(): Promise<void>
  onUpdate(cb: (u: UpdateStatus) => void): () => void
}
