// Windows integration: admin check, relaunch elevated, system proxy, running processes.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import type { RunningProcess } from '../shared/types'

const exec = promisify(execFile)

function powershell(script: string): Promise<{ stdout: string }> {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
}

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

export async function isAdmin(): Promise<boolean> {
  try {
    await exec('net', ['session'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

export async function relaunchAsAdmin(exe: string, args: string[]): Promise<void> {
  const argList = args.length ? ` -ArgumentList ${args.map(psQuote).join(',')}` : ''
  await powershell(`Start-Process -FilePath ${psQuote(exe)}${argList} -Verb RunAs`)
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

const INTERNET_SETTINGS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
// Tells WinINet-based apps (browsers, etc.) to re-read the proxy settings right away.
const REFRESH = `
Add-Type -Namespace Bridge -Name WinInet -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);'
[void][Bridge.WinInet]::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0)
[void][Bridge.WinInet]::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0)
`

export async function setSystemProxy(port: number): Promise<void> {
  const private172 = Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`).join(';')
  const bypass = `localhost;127.*;10.*;${private172};192.168.*;<local>`
  await powershell(`
Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyEnable -Value 1
Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyServer -Value '127.0.0.1:${port}'
Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyOverride -Value '${bypass}'
${REFRESH}`)
}

/** Turns the system proxy off, but only if it still points at our local port. */
export async function clearSystemProxy(port: number): Promise<void> {
  await powershell(`
$s = Get-ItemProperty -Path '${INTERNET_SETTINGS}'
if ($s.ProxyServer -eq '127.0.0.1:${port}') {
  Set-ItemProperty -Path '${INTERNET_SETTINGS}' -Name ProxyEnable -Value 0
  ${REFRESH}
}`)
}

export interface NetworkInfo {
  /** The real (physical) adapter that carries the default route, e.g. "Wi-Fi". */
  interfaceAlias?: string
  /** Its IPv4 DNS servers. */
  dnsServers: string[]
  /** Other virtual adapters that are up: tunnels of other VPN / game tools that may conflict. */
  otherTunnels: string[]
  /** Every IPv4 default route except Bridge's, best first, e.g. "Wi-Fi (metric 25)". For the log. */
  defaultRoutes: string[]
  /**
   * Bind Bridge's own traffic to the physical adapter: true when another tunnel is up or
   * any virtual adapter holds a default route, so traffic can't wander into it.
   */
  bindPhysical: boolean
}

/**
 * Looks at the network before TUN starts: which real adapter goes to the internet,
 * its DNS, and which other tunnels (WARP, game boosters, other VPNs) are active.
 */
export async function networkInfo(): Promise<NetworkInfo> {
  try {
    const { stdout } = await powershell(`
$phys = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up')
$metric = { $_.RouteMetric + (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).InterfaceMetric }
$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -ne 'Bridge' })
$best = $routes | Where-Object { $phys.ifIndex -contains $_.ifIndex } | Sort-Object $metric | Select-Object -First 1
if (-not $best) { $best = $routes | Sort-Object $metric | Select-Object -First 1 }
$dns = @()
if ($best) { $dns = @((Get-DnsClientServerAddress -InterfaceIndex $best.ifIndex -AddressFamily IPv4).ServerAddresses) }
$virtual = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'Bridge' -and ($phys.ifIndex -notcontains $_.ifIndex) -and $_.InterfaceDescription -notmatch 'Hyper-V|Loopback|Bluetooth|VirtualBox|VMware' })
# Only adapters that are up carry traffic; others may keep a stale default route
# (EZConnect's WireSock adapter does, even with EZConnect closed).
$others = @($virtual | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { "$($_.Name) ($($_.InterfaceDescription))" })
$virtualRoute = @($routes | Where-Object { $virtual.ifIndex -contains $_.ifIndex }).Count -gt 0
$defaults = @($routes | Sort-Object $metric | ForEach-Object { "$($_.InterfaceAlias) (metric $(& $metric))" })
[pscustomobject]@{ alias = $best.InterfaceAlias; dns = $dns; others = $others; defaults = $defaults; virtualRoute = $virtualRoute } | ConvertTo-Json -Compress`)
    const j = JSON.parse(stdout.trim() || '{}') as { alias?: string; dns?: string[] | string; others?: string[] | string; defaults?: string[] | string; virtualRoute?: boolean }
    const arr = (v?: string[] | string) => (Array.isArray(v) ? v : v ? [v] : [])
    const otherTunnels = arr(j.others)
    return {
      interfaceAlias: j.alias || undefined,
      dnsServers: arr(j.dns).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
      otherTunnels,
      defaultRoutes: arr(j.defaults),
      bindPhysical: otherTunnels.length > 0 || !!j.virtualRoute
    }
  } catch {
    return { dnsServers: [], otherTunnels: [], defaultRoutes: [], bindPhysical: false }
  }
}

/** Clears Windows' DNS cache, so apps don't keep fake IPs after disconnecting. */
export async function flushDns(): Promise<void> {
  await exec('ipconfig', ['/flushdns'], { windowsHide: true }).catch(() => undefined)
}

/** Running processes that have a readable exe path, one entry per exe. */
export async function listProcesses(): Promise<RunningProcess[]> {
  const { stdout } = await powershell(
    'Get-Process | Where-Object { $_.Path } | Select-Object ProcessName, Path | Sort-Object Path -Unique | ConvertTo-Json -Compress'
  )
  if (!stdout.trim()) return []
  const raw = JSON.parse(stdout) as { ProcessName: string; Path: string } | { ProcessName: string; Path: string }[]
  const items = Array.isArray(raw) ? raw : [raw]
  return items
    .filter((p) => !/^[a-z]:\\windows\\/i.test(p.Path))
    .map((p) => ({ name: p.Path.split('\\').pop() || p.ProcessName, path: p.Path }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
