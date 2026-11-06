// Per-App without TUN, the way Proxifier works: ProxiFyre (github.com/wiresock/proxifyre,
// AGPL-3.0) and its Windows Packet Filter driver hand only the chosen apps' connections to
// Bridge's SOCKS inbound. Routes, adapters and every other app's connections stay as they are,
// so connecting or disconnecting never drops a game that isn't on the VPN.
//
// Bridge ships all of it (ProxiFyre, Windows Packet Filter, whose EULA allows including it in free
// products, and the Visual C++ runtime) and installs it offline, from its installer or the Apps page.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { createServer, isIPv4 } from 'node:net'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AppRule } from '../shared/types'

const exec = promisify(execFile)

const SERVICE = 'ProxiFyreService'
/** Windows Packet Filter's driver service. */
const DRIVER = 'NDISRD'
/** Marks the ProxiFyre config as Bridge's, so Bridge never stops a ProxiFyre someone else set up. */
const MARKER = 'writtenBy'
/** The comment on the DNS policy rule Bridge adds while connected (see pointDnsHere). */
const NRPT_COMMENT = 'Bridge'

type Log = (text: string, level?: 'info' | 'warn') => void

export function proxifyreDir(): string {
  return join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'ProxiFyre')
}

function configPath(): string {
  return join(proxifyreDir(), 'app-config.json')
}

function powershell(script: string): Promise<{ stdout: string }> {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
}

/** "RUNNING", "STOPPED", ... or undefined when the service doesn't exist. */
async function serviceState(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('sc.exe', ['query', name], { windowsHide: true })
    return stdout.match(/STATE\s*:\s*\d+\s+(\w+)/)?.[1]
  } catch {
    return undefined
  }
}

async function waitForState(name: string, want: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await serviceState(name)) === want) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** True once ProxiFyre and its driver are installed, so Per-App can run without TUN. */
export async function perAppDriverReady(): Promise<boolean> {
  if (!existsSync(join(proxifyreDir(), 'ProxiFyre.exe'))) return false
  const [driver, service] = await Promise.all([serviceState(DRIVER), serviceState(SERVICE)])
  return !!driver && !!service
}

/** What install-driver.ps1's exit codes mean. */
const INSTALL_RESULTS: Record<number, string> = {
  2: 'ProxiFyre needs .NET Framework 4.7.2 or later; install it from Windows Update',
  3: 'The Per-App driver files that came with Bridge are damaged; reinstall Bridge',
  4: 'Windows is missing the Universal C runtime; install Windows updates and try again',
  1602: 'The installation was cancelled',
  1603: 'Windows could not install the Per-App driver',
  1223: 'Windows permission was declined'
}

/**
 * Installs the driver from the files that come with Bridge (resources\proxifyre, see
 * scripts/install-driver.ps1), with no download, so it works where GitHub and Microsoft are
 * blocked. Windows asks for permission once; resolves with whether everything is in place.
 */
export async function installPerAppDriver(script: string, log: Log): Promise<boolean> {
  if (!existsSync(script)) throw new Error('The Per-App driver files are missing; reinstall Bridge')
  log('Installing the Per-App driver (ProxiFyre with Windows Packet Filter); Windows asks for permission')
  const quoted = script.replace(/'/g, "''")
  let code: number
  try {
    const { stdout } = await powershell(
      `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
        `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${quoted}"'; $p.ExitCode`
    )
    code = Number(stdout.trim())
  } catch {
    // Start-Process fails when the permission prompt is declined.
    code = 1223
  }
  // What the script did, so it shows in Bridge's Logs (an elevated run as the same user shares %TEMP%).
  try {
    const lines = readFileSync(join(process.env.TEMP || '', 'bridge-install-driver.log'), 'utf8').trim().split(/\r?\n/)
    const start = lines.map((l) => l.includes('Installing the Per-App driver from')).lastIndexOf(true)
    for (const line of lines.slice(Math.max(start, lines.length - 30))) log(`[driver] ${line.replace(/^\S+ /, '')}`)
  } catch {
    // No log: the script never started (for example, the permission prompt was declined).
  }
  if (code === 3010) log('Windows needs a restart to finish the Per-App driver; restart, then press Install driver again', 'warn')
  else if (code !== 0) log(`${INSTALL_RESULTS[code] ?? `The Per-App driver installation failed (code ${code})`}. Details: %TEMP%\\bridge-install-driver.log`, 'warn')
  const ready = await perAppDriverReady()
  log(ready ? 'Per-App driver is installed' : 'Per-App driver is not installed', ready ? 'info' : 'warn')
  return ready
}

/**
 * How ProxiFyre should recognize an app. A name with a backslash matches anywhere in the
 * process's full path, so cutting the path before its first version number keeps the rule
 * working after the app updates itself into a new folder (Discord's "app-1.0.9187", Store apps'
 * "WhatsAppDesktop_2.2442.6.0_x64__...", Chrome's "120.0.6099.110").
 */
export function proxifyreAppName(path: string): string {
  const cut = path.lastIndexOf('\\')
  const dirs = path.slice(0, cut + 1)
  const version = dirs.search(/\d+(?:\.\d+)+/)
  return version > 0 ? dirs.slice(0, version) : path
}

export interface PerAppOptions {
  /**
   * Bridge's SOCKS inbounds for apps on the VPN, one per app (see appSlots), and the one that
   * refuses everything (Block). sing-box only sees ProxiFyre as the program behind every
   * connection, so the inbound a connection arrives on is how Bridge knows which app it is.
   */
  ports: number[]
  blockPort: number
  user: string
  password: string
  rules: AppRule[]
  /** Bridge's own programs, never redirected whatever the rules say. */
  exclude: string[]
}

/** One app on the VPN and the inbound (by its index in PerAppOptions.ports) it is handed to. */
export interface AppSlot {
  slot: number
  /** The app's path as the user chose it, for the traffic table. */
  path: string
  /** How ProxiFyre recognizes it (proxifyreAppName). */
  name: string
}

/**
 * Gives every app set to VPN its own inbound, in the order of the app list. Apps ProxiFyre would
 * recognize by the same name share the first one's. When there are more apps than inbounds, the
 * rest share the last inbound (Bridge reconnects with more inbounds; see Core.updateAppRules).
 */
export function appSlots(rules: AppRule[], slots: number): AppSlot[] {
  const seen = new Set<string>()
  const out: AppSlot[] = []
  for (const r of rules) {
    if (!r.enabled || r.action !== 'proxy') continue
    const name = proxifyreAppName(r.path)
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({ slot: Math.min(out.length, slots - 1), path: r.path, name })
  }
  return out
}

export function buildProxiFyreConfig(o: PerAppOptions): Record<string, unknown> {
  const names = (action: AppRule['action']) => [...new Set(o.rules.filter((r) => r.enabled && r.action === action).map((r) => proxifyreAppName(r.path)))]
  const rule = (appNames: string[], port: number) => ({
    appNames,
    socks5ProxyEndpoint: `127.0.0.1:${port}`,
    username: o.user,
    password: o.password,
    socks5Transport: 'TCP',
    supportedProtocols: ['TCP', 'UDP'],
    supportedAddressFamilies: ['IPv4', 'IPv6']
  })
  // Block first, so an app that is both (an exe inside a VPN app's folder) stays blocked.
  const vpn = appSlots(o.rules, o.ports.length).map((a) => rule([a.name], o.ports[a.slot]))
  const proxies = [rule(names('block'), o.blockPort), ...vpn].filter((r) => r.appNames.length)
  return {
    [MARKER]: 'Bridge',
    logLevel: 'Warning',
    bypassLan: true,
    // ProxiFyre needs at least one rule; one that names no app never matches.
    proxies: proxies.length ? proxies : [rule([], o.ports[0])],
    // Apps set to Direct or Other VPN need nothing: whatever no rule names keeps its own route.
    excludes: [...new Set(o.exclude)]
  }
}

function isOurs(): boolean {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))[MARKER] === 'Bridge'
  } catch {
    return false
  }
}

/** The newest lines ProxiFyre logged, to show why it didn't start. */
function logTail(): string {
  try {
    const dir = join(proxifyreDir(), 'logs')
    const newest = readdirSync(dir)
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]
    if (!newest) return ''
    return readFileSync(join(dir, newest.f), 'utf8').trim().split(/\r?\n/).slice(-5).join('\n')
  } catch {
    return ''
  }
}

/** Writes Bridge's rules into ProxiFyre and (re)starts its service. Needs administrator rights. */
export async function startPerApp(o: PerAppOptions, log: Log): Promise<void> {
  const file = configPath()
  // Someone's own ProxiFyre setup is kept aside, not overwritten.
  if (existsSync(file) && !isOurs()) {
    renameSync(file, `${file}.before-bridge`)
    log(`Your own ProxiFyre settings were saved as ${file}.before-bridge`)
  }
  writeFileSync(file, JSON.stringify(buildProxiFyreConfig(o), null, 2))
  // The service refuses a config owned by one user account rather than the Administrators group,
  // which is what a new file gets when Windows is set to make the creator its owner.
  await exec('icacls.exe', [file, '/setowner', '*S-1-5-32-544'], { windowsHide: true }).catch((e) => log(`Could not hand the ProxiFyre config to Administrators: ${e instanceof Error ? e.message : e}`, 'warn'))
  if ((await serviceState(SERVICE)) !== 'STOPPED') await stopService()
  await exec('sc.exe', ['start', SERVICE], { windowsHide: true }).catch(() => undefined)
  if (!(await waitForState(SERVICE, 'RUNNING', 15000))) {
    const tail = logTail()
    throw new Error(`The Per-App driver (ProxiFyre) did not start${tail ? `:\n${tail}` : ''}`)
  }
}

async function stopService(): Promise<void> {
  await exec('sc.exe', ['stop', SERVICE], { windowsHide: true }).catch(() => undefined)
  await waitForState(SERVICE, 'STOPPED', 15000)
}

/** Stops redirecting apps. Only touches ProxiFyre when it runs with Bridge's config. */
export async function stopPerApp(): Promise<void> {
  if (!isOurs()) return
  const state = await serviceState(SERVICE)
  if (state && state !== 'STOPPED') await stopService()
}

/**
 * Loopback addresses Bridge can answer Windows' DNS on (Windows only asks port 53). Another local
 * DNS tool often holds 127.0.0.1:53, and any 127.x address works just as well.
 */
const DNS_ADDRESSES = ['127.0.0.1', '127.0.0.53', '127.53.53.53']

function udpFree(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    socket.once('error', () => resolve(false))
    socket.bind(53, address, () => socket.close(() => resolve(true)))
  })
}

function tcpFree(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(53, address, () => server.close(() => resolve(true)))
  })
}

/** The first loopback address whose port 53 is free for both UDP and TCP (sing-box listens on both). */
export async function freeDnsAddress(): Promise<string | undefined> {
  for (const address of DNS_ADDRESSES) if ((await udpFree(address)) && (await tcpFree(address))) return address
  return undefined
}

/** Which programs hold port 53, e.g. "dnscrypt-proxy on 127.0.0.1", so the log can say. */
export async function dnsPortOwners(): Promise<string> {
  const { stdout } = await powershell(
    `@(Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue) + @(Get-NetTCPConnection -LocalPort 53 -State Listen -ErrorAction SilentlyContinue) | ` +
      `ForEach-Object { '{0} on {1}' -f (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName, $_.LocalAddress } | Sort-Object -Unique`
  )
  return stdout.trim().split(/\r?\n/).filter(Boolean).join(', ')
}

/**
 * Sends every Windows DNS lookup to Bridge (a Name Resolution Policy rule for all names), so apps
 * on the VPN get real addresses instead of Iran's block page (10.10.34.x). Nothing about the
 * adapters changes, and no connection is dropped. Clearing the cache makes apps ask again.
 * `fallback` (the network's own DNS servers) come after Bridge, so if Bridge ever dies without
 * undoing this, Windows still resolves names.
 */
export async function pointDnsHere(address: string, fallback: string[]): Promise<void> {
  const servers = [address, ...fallback.filter((ip) => isIPv4(ip) && !ip.startsWith('127.'))].map((ip) => `'${ip}'`).join(',')
  await powershell(
    `Get-DnsClientNrptRule | Where-Object Comment -eq '${NRPT_COMMENT}' | Remove-DnsClientNrptRule -Force; ` +
      `Add-DnsClientNrptRule -Namespace '.' -NameServers ${servers} -Comment '${NRPT_COMMENT}'; Clear-DnsClientCache`
  )
}

/**
 * A hidden PowerShell that waits for Bridge to exit and then undoes Per-App (stops ProxiFyre if it
 * runs Bridge's config, removes Bridge's DNS rule). A clean disconnect does that itself and ends
 * the watchdog; it only matters when Bridge crashes or is killed while connected.
 */
export function startWatchdog(bridgePid: number): ChildProcess {
  const config = configPath().replace(/'/g, "''")
  const script =
    `try { (Get-Process -Id ${bridgePid} -ErrorAction Stop).WaitForExit() } catch {}; ` +
    `try { if ((Get-Content -Raw -LiteralPath '${config}' | ConvertFrom-Json).${MARKER} -eq 'Bridge') { Stop-Service ${SERVICE} -Force } } catch {}; ` +
    `$r = @(Get-DnsClientNrptRule | Where-Object Comment -eq '${NRPT_COMMENT}'); if ($r.Count) { $r | Remove-DnsClientNrptRule -Force; Clear-DnsClientCache }`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  return child
}

/** Undoes pointDnsHere. Safe to call when it never ran (also at startup, after a crash). */
export async function restoreDns(): Promise<boolean> {
  const { stdout } = await powershell(
    `$r = @(Get-DnsClientNrptRule | Where-Object Comment -eq '${NRPT_COMMENT}'); ` +
      `if ($r.Count) { $r | Remove-DnsClientNrptRule -Force; Clear-DnsClientCache }; $r.Count`
  )
  return Number(stdout.trim()) > 0
}
