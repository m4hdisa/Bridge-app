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

/**
 * The IPv4 DNS server of the network adapter that carries the default route
 * (usually the router). Must be called before TUN starts. Undefined if not found.
 */
export async function physicalDnsServer(): Promise<string | undefined> {
  try {
    const { stdout } = await powershell(`
$routes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -ne 'Bridge' }
$best = $routes | Sort-Object { $_.RouteMetric + (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4).InterfaceMetric } | Select-Object -First 1
if ($best) { (Get-DnsClientServerAddress -InterfaceIndex $best.ifIndex -AddressFamily IPv4).ServerAddresses | Select-Object -First 1 }`)
    const ip = stdout.trim().split(/\r?\n/)[0]?.trim()
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined
  } catch {
    return undefined
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
