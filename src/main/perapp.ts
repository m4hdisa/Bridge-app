// Per-App without TUN, the way Proxifier works: bridge-perapp.exe (Bridge's own, in native/perapp)
// uses the Windows Packet Filter driver to hand only the chosen apps' connections to Bridge's SOCKS
// inbounds. Routes, adapters and every other app's connections stay as they are, so connecting or
// disconnecting never drops a game that isn't on the VPN.
//
// Bridge ships the driver (Windows Packet Filter, whose EULA allows including it in free products)
// and installs it offline, from its installer or the Apps page, out of Windows' list of installed
// apps: it is part of Bridge, and Bridge's uninstaller removes it.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { createServer, isIPv4 } from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { AppRule } from '../shared/types'

const exec = promisify(execFile)

/** Windows Packet Filter's driver service. */
const DRIVER = 'NDISRD'
/** The firewall rule that lets bridge-perapp.exe take the connections it redirects (see install-driver.ps1). */
const FIREWALL_RULE = 'Bridge Per-App'
/** The comment on the DNS policy rule Bridge adds while connected (see pointDnsHere). */
const NRPT_COMMENT = 'Bridge'

type Log = (text: string, level?: 'info' | 'warn') => void

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

/** True once the driver is installed, so Per-App can run without TUN. */
export async function perAppDriverReady(helper: string): Promise<boolean> {
  return existsSync(helper) && !!(await serviceState(DRIVER))
}

/** What install-driver.ps1's exit codes mean. */
const INSTALL_RESULTS: Record<number, string> = {
  3: 'The Per-App driver file that came with Bridge is damaged; reinstall Bridge',
  1602: 'The installation was cancelled',
  1603: 'Windows could not install the Per-App driver',
  1223: 'Windows permission was declined'
}

/**
 * Installs the driver from the file that comes with Bridge (resources\perapp, see
 * scripts/install-driver.ps1), with no download, so it works where GitHub and Microsoft are
 * blocked. Windows asks for permission once; resolves with whether everything is in place.
 */
export async function installPerAppDriver(script: string, helper: string, log: Log): Promise<boolean> {
  if (!existsSync(script)) throw new Error('The Per-App driver files are missing; reinstall Bridge')
  log('Installing the Per-App driver (Windows Packet Filter); Windows asks for permission')
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
  const ready = await perAppDriverReady(helper)
  log(ready ? 'Per-App driver is installed' : 'Per-App driver is not installed', ready ? 'info' : 'warn')
  return ready
}

/**
 * How an app is recognized: a name matches anywhere in the program's full path, so cutting the
 * path before its first version number keeps the rule working after the app updates itself into a
 * new folder (Discord's "app-1.0.9187", Store apps' "WhatsAppDesktop_2.2442.6.0_x64__...", Chrome's
 * "120.0.6099.110").
 */
export function perAppName(path: string): string {
  const cut = path.lastIndexOf('\\')
  const dirs = path.slice(0, cut + 1)
  const version = dirs.search(/\d+(?:\.\d+)+/)
  return version > 0 ? dirs.slice(0, version) : path
}

export interface PerAppOptions {
  /**
   * Bridge's SOCKS inbounds for apps on the VPN, one per app (see appSlots), and the one that
   * refuses everything (Block). sing-box only sees bridge-perapp.exe as the program behind every
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
  /** How it is recognized (perAppName). */
  name: string
}

/**
 * Gives every app set to VPN its own inbound, in the order of the app list. Apps recognized by the
 * same name share the first one's. When there are more apps than inbounds, the rest share the last
 * inbound (Bridge reconnects with more inbounds; see Core.updateAppRules).
 */
export function appSlots(rules: AppRule[], slots: number): AppSlot[] {
  const seen = new Set<string>()
  const out: AppSlot[] = []
  for (const r of rules) {
    if (!r.enabled || r.action !== 'proxy') continue
    const name = perAppName(r.path)
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({ slot: Math.min(out.length, slots - 1), path: r.path, name })
  }
  return out
}

/** The rules bridge-perapp.exe reads (its Config in native/perapp/rules.go). */
export function buildPerAppConfig(o: PerAppOptions): Record<string, unknown> {
  const blocked = [...new Set(o.rules.filter((r) => r.enabled && r.action === 'block').map((r) => perAppName(r.path)))]
  // Block first, so an app that is both (an exe inside a VPN app's folder) stays blocked.
  const proxies = [{ apps: blocked, port: o.blockPort }, ...appSlots(o.rules, o.ports.length).map((a) => ({ apps: [a.name], port: o.ports[a.slot] }))]
  return {
    user: o.user,
    password: o.password,
    // Apps set to Direct or Other VPN need nothing: whatever no rule names keeps its own route.
    proxies: proxies.filter((p) => p.apps.length),
    exclude: [...new Set(o.exclude)]
  }
}

/** Lets bridge-perapp.exe take redirected connections (Windows Firewall would refuse them). Needs administrator rights. */
async function allowThroughFirewall(helper: string, log: Log): Promise<void> {
  try {
    const { stdout } = await exec('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`, 'verbose'], { windowsHide: true })
    if (stdout.toLowerCase().includes(helper.toLowerCase())) return
  } catch {
    // No rule yet.
  }
  await exec('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`], { windowsHide: true }).catch(() => undefined)
  await exec('netsh.exe', ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', `program=${helper}`, 'enable=yes', 'profile=any'], { windowsHide: true }).catch((e) =>
    log(`Could not let the Per-App helper through Windows Firewall: ${e instanceof Error ? e.message : e}`, 'warn')
  )
}

/** A running bridge-perapp.exe. */
export interface PerAppRun {
  stop(): Promise<void>
}

/**
 * Starts redirecting the apps in the rules: bridge-perapp.exe, which stops by itself when Bridge
 * exits, so a crash never leaves apps redirected. Needs administrator rights.
 */
export async function startPerApp(helper: string, configFile: string, o: PerAppOptions, log: Log): Promise<PerAppRun> {
  await allowThroughFirewall(helper, log)
  writeFileSync(configFile, JSON.stringify(buildPerAppConfig(o), null, 2))
  const child = spawn(helper, ['-config', configFile, '-parent', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: string[] = []
  const tail = () => (lines.length ? `:\n${lines.slice(-5).join('\n')}` : '')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`The Per-App driver did not start in time${tail()}`))
    }, 15000)
    const onLine = (line: string) => {
      if (line === 'ready') {
        clearTimeout(timer)
        resolve()
        return
      }
      lines.push(line)
      log(`[per-app] ${line}`, /fail|can't|couldn't|not installed|error/i.test(line) ? 'warn' : 'info')
    }
    createInterface({ input: child.stdout! }).on('line', onLine)
    createInterface({ input: child.stderr! }).on('line', onLine)
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`The Per-App driver stopped (code ${code})${tail()}`))
    })
  })
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        const timer = setTimeout(() => {
          child.kill()
          resolve()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        // Closing its input is how it is asked to stop; it puts the adapter back at once.
        child.stdin?.end()
      })
  }
}

/**
 * Removes the ProxiFyre that Bridge 0.6.0 and 0.6.1 installed (they used it before bridge-perapp.exe
 * did its work); one someone set up with their own rules stays. Needs administrator rights.
 */
export async function removeOldProxiFyre(log: Log): Promise<void> {
  const dir = join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'ProxiFyre')
  if (!existsSync(join(dir, 'ProxiFyre.exe'))) return
  try {
    if (JSON.parse(readFileSync(join(dir, 'app-config.json'), 'utf8')).writtenBy !== 'Bridge') return
  } catch {
    // No rules at all: only Bridge's installer put it there.
    if (existsSync(join(dir, 'app-config.json'))) return
  }
  const state = await serviceState('ProxiFyreService')
  if (state && state !== 'STOPPED') await exec('sc.exe', ['stop', 'ProxiFyreService'], { windowsHide: true }).catch(() => undefined)
  const { stdout } = await powershell(
    `$e = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | ` +
      `Where-Object { $_.DisplayName -like 'ProxiFyre*' } | Select-Object -First 1; ` +
      `if ($e) { (Start-Process msiexec.exe -ArgumentList "/x $($e.PSChildName) /qn /norestart" -Wait -PassThru -WindowStyle Hidden).ExitCode }`
  ).catch(() => ({ stdout: '' }))
  if (stdout.trim()) log(`Removed ProxiFyre, which older versions of Bridge installed; Bridge does its work itself now (code ${stdout.trim()})`)
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
 * A hidden PowerShell that waits for Bridge to exit and then removes Bridge's DNS rule. A clean
 * disconnect does that itself and ends the watchdog; it only matters when Bridge crashes or is
 * killed while connected (bridge-perapp.exe stops by itself then).
 */
export function startWatchdog(bridgePid: number): ChildProcess {
  const script =
    `try { (Get-Process -Id ${bridgePid} -ErrorAction Stop).WaitForExit() } catch {}; ` +
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
