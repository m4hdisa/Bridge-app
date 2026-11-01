// The built-in free WARP server, run by the Aether core (aether.exe, AGPL-3.0, by CluvexStudio:
// https://github.com/CluvexStudio/Aether). Aether finds a Cloudflare WARP gateway that this
// network lets through, opens the tunnel and serves it as a local SOCKS5 proxy; sing-box's
// "proxy" outbound then becomes a SOCKS hop into it, like with Xray:
//   app -> TUN -> sing-box (rules) -> socks 127.0.0.1 -> aether.exe -> Cloudflare WARP
import { randomUUID } from 'node:crypto'
import { WARP_METHODS, type ServerProfile, type WarpMethod, type WarpOptions } from '../shared/types'

/** Name of the identity file Aether keeps beside `--config` (its WARP account); keep it, or Cloudflare rate-limits new sign-ups. */
export const WARP_IDENTITY_FILE = 'aether-masque.toml'

export function newWarpServer(): ServerProfile {
  return {
    id: randomUUID(),
    name: 'Free WARP (Cloudflare)',
    protocol: 'warp',
    server: 'Cloudflare WARP',
    port: 0,
    link: 'warp://free',
    outbound: { type: 'warp' },
    engine: 'aether',
    warp: { method: 'auto' }
  }
}

export function isWarp(s: ServerProfile): boolean {
  return s.engine === 'aether'
}

/** The methods to try, in the order to try them. */
export function warpMethods(options: WarpOptions | undefined): WarpMethod[] {
  const method = options?.method ?? 'auto'
  return method === 'auto' ? WARP_METHODS.filter((m) => m.auto).map((m) => m.id) : [method]
}

export function warpLabel(method: WarpMethod): string {
  return WARP_METHODS.find((m) => m.id === method)?.label ?? method
}

const METHOD_ARGS: Record<WarpMethod, string[]> = {
  // WireGuard inside a MASQUE (HTTP/2) tunnel. Its WireGuard account is made from inside WARP,
  // so it needs no direct access to the WARP API, and Cloudflare gives it a foreign exit.
  gool: ['--gool', '--h2', '-4'],
  h3: ['--masque', '--h3', '-4'],
  h2: ['--masque', '--h2', '-4'],
  'h2-fragment': ['--masque', '--h2', '--fragment', '-4'],
  'h2-ipv6': ['--masque', '--h2', '-6'],
  wireguard: ['--wg', '-4']
}

/**
 * Command line for one attempt. Every question Aether would ask has a flag here, so it
 * never waits for input. `configFile` is Aether's base identity path; its WARP account
 * files are kept beside it.
 */
export function warpArgs(method: WarpMethod, port: number, configFile: string): string[] {
  return [
    ...METHOD_ARGS[method],
    // Stop at the first gateway that passes real traffic: connecting fast matters more here.
    '--scan',
    'turbo',
    '--quick-reconnect',
    '--bind',
    `127.0.0.1:${port}`,
    '--config',
    configFile,
    // Gool is there for its foreign exit, so it refuses an Iranian one and looks again. The
    // others take what they get: from Iran that is almost always an address Cloudflare
    // registers in Iran (the traffic still leaves abroad, so filtering is bypassed).
    ...(prefersForeignExit(method) ? ['--exit-loc', '!IR'] : [])
  ]
}

/** Methods whose point is an exit outside Iran; Auto waits a little for them before taking another. */
export function prefersForeignExit(method: WarpMethod): boolean {
  return method === 'gool'
}

/**
 * Ways to create the WARP account, in the order Bridge tries them. Iran's firewall resets the
 * TLS handshake to Cloudflare's WARP API (api.cloudflareclient.com / api.devices.cloudflare.com),
 * and Aether 2.4 falls back to other Cloudflare edges on its own, which takes a while. The
 * account is needed only once, so when the API can't be reached directly it is created through
 * one of the user's own servers ("via"), as PattN does with its exit-node. ECH is not tried:
 * its key domain (cloudflare-ech.com) is blocked in Iran.
 */
export const WARP_REGISTER_TRIES: { label: string; args: string[]; via?: boolean; timeoutMs: number }[] = [
  // The fragment splits the ClientHello whose server name the firewall looks for.
  { label: 'directly, with TLS fragment', args: ['--fragment'], timeoutMs: 150_000 },
  { label: 'through your own server', args: [], via: true, timeoutMs: 90_000 },
  { label: 'directly', args: [], timeoutMs: 120_000 }
]

/** Registers the WARP account once, before parallel attempts would each try to make their own. */
export function warpRegisterArgs(configFile: string, extra: string[] = [], upstreamPort?: number): string[] {
  return ['--register', 'masque', ...extra, ...(upstreamPort ? ['--upstream', `socks5://127.0.0.1:${upstreamPort}`] : []), '--config', configFile]
}

/** Aether prints "[time LEVEL target] message"; returns the level and the message alone. */
export function parseWarpLine(line: string): { level: 'info' | 'warn' | 'error'; text: string } {
  const m = line.match(/^\[\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+[^\]]*\]\s*(.*)$/)
  if (!m) return { level: /error|failed|panic/i.test(line) ? 'warn' : 'info', text: line.trim() }
  return { level: m[1] === 'ERROR' ? 'error' : m[1] === 'WARN' ? 'warn' : 'info', text: m[2] }
}

/**
 * Aether binds its port at startup but serves only once the tunnel is validated; this line says
 * so. Gool prints the same line first for an internal port, so the port must match.
 */
export function warpReady(text: string, port: number): boolean {
  return text.includes(`socks5 server listening on 127.0.0.1:${port}`)
}

/** The exit country Aether found for its tunnel ("masque exit: 104.28.214.161, IR via FRA, ..."). */
export function warpExitCountry(text: string): string | undefined {
  return text.match(/\bexit: \S+, ([A-Z]{2}) via /)?.[1]
}

/** Aether's line when the IPv6 method can't work at all on this network. */
export const WARP_NO_IPV6 = /host has no IPv6 route/
