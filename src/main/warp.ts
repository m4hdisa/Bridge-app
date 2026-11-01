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
    // WARP sometimes hands out an Iranian exit, which defeats the point; refuse those.
    '--exit-loc',
    '!IR'
  ]
}

/** Registers the WARP account once, before parallel attempts would each try to make their own. */
export function warpRegisterArgs(configFile: string): string[] {
  // The fragment also applies to the WARP API, whose handshake Iran's firewall resets.
  return ['--register', 'masque', '--fragment', '--config', configFile]
}

/** Aether prints "[time LEVEL target] message"; returns the level and the message alone. */
export function parseWarpLine(line: string): { level: 'info' | 'warn' | 'error'; text: string } {
  const m = line.match(/^\[\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+[^\]]*\]\s*(.*)$/)
  if (!m) return { level: /error|failed|panic/i.test(line) ? 'warn' : 'info', text: line.trim() }
  return { level: m[1] === 'ERROR' ? 'error' : m[1] === 'WARN' ? 'warn' : 'info', text: m[2] }
}

/** Aether binds its port at startup but serves only once the tunnel is validated; this line says so. */
export const WARP_READY = /socks5 server listening on/
