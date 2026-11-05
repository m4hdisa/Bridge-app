// The built-in free WARP server, run by the Aether core (aether.exe, AGPL-3.0, by CluvexStudio:
// https://github.com/CluvexStudio/Aether). Aether finds a Cloudflare WARP gateway that this
// network lets through, opens the tunnel and serves it as a local SOCKS5 proxy; sing-box's
// "proxy" outbound then becomes a SOCKS hop into it, like with Xray:
//   app -> TUN -> sing-box (rules) -> socks 127.0.0.1 -> aether.exe -> Cloudflare WARP
import { randomUUID } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { WARP_METHODS, type ServerProfile, type WarpFound, type WarpMethod, type WarpOptions } from '../shared/types'

/** Name of the identity file Aether keeps beside `--config` (its WARP account); keep it, or Cloudflare rate-limits new sign-ups. */
export const WARP_IDENTITY_FILE = 'aether-masque.toml'

export const WARP_SHARE_SCHEME = 'bridge://warp'
/** Fields of Aether's identity file. A share link carrying anything else isn't one of ours. */
const IDENTITY_FIELDS = new Set(['device_id', 'access_token', 'cert_pem', 'key_pem', 'cert_issued_at', 'ipv4', 'ipv6', 'wg_private_key', 'wg_peer_public_key', 'client_id', 'organization', 'gateway_proxy', 'assigned_endpoint'])
const MAX_IDENTITY_BYTES = 8192

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

/** A config saved by "Find configs": one method on one gateway. */
export function newWarpConfig(found: WarpFound): ServerProfile {
  return {
    ...newWarpServer(),
    name: `Free WARP · ${warpLabel(found.method)}${found.exit ? ` · ${found.exit}` : ''}`,
    server: found.peer.replace(/:\d+$/, ''),
    port: Number(found.peer.split(':').pop()) || 0,
    link: `warp://${found.method}@${found.peer}`,
    warp: { method: found.method, peer: found.peer, exit: found.exit, readyMs: found.readyMs, downMbps: found.downMbps, upMbps: found.upMbps }
  }
}

/** True for configs saved by "Find configs" or received as a link (the plain Free WARP server finds its way each time). */
export function isWarpConfig(s: ServerProfile): boolean {
  return isWarp(s) && !!s.warp?.peer
}

/** Only these Cloudflare ranges can be a WARP gateway; a share link can't point Bridge anywhere else. */
function isWarpGateway(peer: string): boolean {
  const v4 = peer.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/)
  if (v4) {
    const [a, b, c, d, port] = v4.slice(1).map(Number)
    if (c > 255 || d > 255 || port < 1 || port > 65535) return false
    return (a === 162 && b === 159) || (a === 188 && b === 114 && c >= 96 && c <= 111)
  }
  const v6 = peer.match(/^\[(2606:4700:[0-9a-f:]+)\]:(\d{1,5})$/i)
  return !!v6 && Number(v6[2]) >= 1 && Number(v6[2]) <= 65535
}

/** Throws unless `text` is a plain Aether identity file: only its own fields, with a private key. */
function checkIdentity(text: string): void {
  const keys = text.split(/\r?\n/).flatMap((l) => l.match(/^([a-z0-9_]+)\s*=/)?.[1] ?? [])
  const bad = keys.find((k) => !IDENTITY_FIELDS.has(k))
  if (bad) throw new Error(`This link's WARP account has an unknown field (${bad})`)
  for (const field of ['device_id', 'access_token', 'cert_pem', 'key_pem']) {
    if (!keys.includes(field)) throw new Error(`This link's WARP account is missing ${field}`)
  }
}

/**
 * A link that gives someone else a working WARP config inside Bridge: the method, the gateway
 * that worked for the sender (they may have to look for another), and a WARP account of its own,
 * so it also works for someone who can't reach Cloudflare's sign-up service.
 */
export function warpShareLink(warp: WarpOptions, identity: string, name: string): string {
  checkIdentity(identity)
  const query = new URLSearchParams({ m: warp.method })
  if (warp.peer) query.set('p', warp.peer)
  if (warp.exit) query.set('x', warp.exit)
  query.set('a', deflateRawSync(identity).toString('base64url'))
  return `${WARP_SHARE_SCHEME}?${query}#${encodeURIComponent(name)}`
}

export interface ParsedWarpLink {
  warp: WarpOptions
  identity: string
  name: string
}

/** Reads a share link without trusting it: nothing outside WARP's own methods, gateways and account fields gets through. */
export function parseWarpShareLink(link: string): ParsedWarpLink {
  const [body, hash] = link.split('#')
  if (!body.startsWith(`${WARP_SHARE_SCHEME}?`)) throw new Error('Not a Bridge WARP link')
  const query = new URLSearchParams(body.slice(WARP_SHARE_SCHEME.length + 1))
  const method = query.get('m') as WarpOptions['method']
  if (method !== 'auto' && method !== 'auto-foreign' && !WARP_METHODS.some((m) => m.id === method)) throw new Error('This WARP link names an unknown method')
  const peer = query.get('p') || undefined
  if (peer && !isWarpGateway(peer)) throw new Error('This WARP link points at an address outside Cloudflare WARP')
  const exit = query.get('x') || undefined
  if (exit && !/^[A-Z]{2}$/.test(exit)) throw new Error('This WARP link names an unknown exit country')
  let identity: string
  try {
    identity = inflateRawSync(Buffer.from(query.get('a') || '', 'base64url'), { maxOutputLength: MAX_IDENTITY_BYTES }).toString('utf8')
  } catch {
    throw new Error('This WARP link is damaged; ask for it again')
  }
  checkIdentity(identity)
  let name = ''
  try {
    name = decodeURIComponent(hash || '')
  } catch {
    // A broken name doesn't make the config unusable.
  }
  return { warp: { method, peer, exit, shared: true }, identity, name: name.slice(0, 80) }
}

/** The server a share link gives: a WARP config whose account travels in `link`. */
export function warpServerFromLink(link: string): ServerProfile {
  const { warp, name } = parseWarpShareLink(link)
  return {
    ...newWarpServer(),
    name: name || `Free WARP · ${warp.method === 'auto' || warp.method === 'auto-foreign' ? 'Auto' : warpLabel(warp.method)}`,
    server: warp.peer?.replace(/:\d+$/, '') ?? 'Cloudflare WARP',
    port: Number(warp.peer?.split(':').pop()) || 0,
    link,
    warp
  }
}

/** The methods to try, in the order to try them. */
export function warpMethods(options: WarpOptions | undefined): WarpMethod[] {
  const method = options?.method ?? 'auto'
  const fast = WARP_METHODS.filter((m) => m.auto).map((m) => m.id)
  // One MASQUE in MASQUE at a time: two would race to make its second account.
  return method === 'auto' ? fast : method === 'auto-foreign' ? ['gool', 'mim-h2', ...fast] : [method]
}

/** Every method "Find configs" tries at first; the HTTP/3 forms of the two-hop ones follow once their accounts exist. */
export const WARP_FIND_METHODS: WarpMethod[] = ['gool', 'mim-h2', ...WARP_METHODS.filter((m) => m.auto).map((m) => m.id)]

export function warpLabel(method: WarpMethod): string {
  return WARP_METHODS.find((m) => m.id === method)?.label ?? method
}

const METHOD_ARGS: Record<WarpMethod, string[]> = {
  // WireGuard inside a MASQUE (HTTP/2) tunnel. Its WireGuard account is made from inside WARP,
  // so it needs no direct access to the WARP API, and Cloudflare gives it a foreign exit.
  gool: ['--gool', '--h2', '-4'],
  'gool-h3': ['--gool', '--h3', '-4'],
  // A MASQUE tunnel inside a MASQUE one. Its second account is made from inside the first.
  'mim-h2': ['--mim', '--h2', '-4'],
  mim: ['--mim', '--h3', '-4'],
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
export function warpArgs(method: WarpMethod, port: number, configFile: string, peer?: string, fresh = false, verifyGateway = false, psiphon?: PsiphonChain): string[] {
  return [
    ...METHOD_ARGS[method],
    // A saved gateway: no scan. For the two-hop methods it is the outer hop.
    ...(peer ? [method === 'mim' || method === 'mim-h2' ? '--mim-outer' : '--peer', peer] : []),
    // A gateway from someone else's link has to prove it really is Cloudflare's.
    ...(verifyGateway ? ['--tls-verify'] : []),
    // Stop at the first gateway that passes real traffic: connecting fast matters more here. With
    // two hops, "verified" keeps them in separate ranges, which is what moves the exit address.
    '--scan',
    prefersForeignExit(method) ? 'verified' : 'turbo',
    // The last working gateway is one file shared by every method; "Find configs" ignores it
    // so each method proves a gateway of its own.
    fresh ? '--no-quick-reconnect' : '--quick-reconnect',
    '--bind',
    `127.0.0.1:${port}`,
    '--config',
    configFile,
    // Two hops are there for the foreign exit, so they refuse an Iranian one and look again. The
    // others take what they get: from Iran that is almost always an address Cloudflare
    // registers in Iran (the traffic still leaves abroad, so filtering is bypassed).
    ...(prefersForeignExit(method) ? ['--exit-loc', '!IR'] : []),
    // Psiphon inside the tunnel, on a port of its own: aether -> WARP -> Psiphon -> the internet.
    ...(psiphon ? ['--psiphon', '--psiphon-bin', psiphon.bin, '--psiphon-bind', `127.0.0.1:${psiphon.port}`, ...(psiphon.region ? ['--psiphon-region', psiphon.region] : [])] : [])
  ]
}

export interface PsiphonChain {
  bin: string
  port: number
  /** The country to leave from; Psiphon picks one when missing. */
  region?: string
}

/** Methods whose point is an exit outside Iran; Auto waits a little for them before taking another. */
export function prefersForeignExit(method: WarpMethod): boolean {
  return method === 'gool' || method === 'gool-h3' || method === 'mim' || method === 'mim-h2'
}

/** What Bridge remembers between connects, kept in WARP_STATE_FILE beside Aether's files. */
export interface WarpState {
  /** When Auto last waited for Gool and Gool didn't get through. */
  goolMissedAt?: number
  /** When Auto last waited for HTTP/3 and it didn't get through. */
  h3MissedAt?: number
  /** The WARP account's own free key, from before a WARP+ key replaced it. */
  plusOriginalLicense?: string
}

export const WARP_STATE_FILE = 'bridge-warp-state.json'
/** After Gool misses, how long Auto connects without waiting for it (it still runs in the race). */
export const GOOL_RETRY_MS = 30 * 60 * 1000
const H3_RETRY_MS = 6 * 60 * 60 * 1000

/**
 * Whether Auto should hold a working tunnel back to give Gool time. Not when Gool missed
 * recently: on networks where it never gets through, every connect would be slower for nothing.
 */
export function waitForGool(state: WarpState, now = Date.now()): boolean {
  return !state.goolMissedAt || now - state.goolMissedAt >= GOOL_RETRY_MS
}

/** The same for HTTP/3, which is about twice as fast as HTTP/2 where UDP gets through. */
export function waitForH3(state: WarpState, now = Date.now()): boolean {
  return !state.h3MissedAt || now - state.h3MissedAt >= H3_RETRY_MS
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

/** The Cloudflare gateway Aether connects to ("[+] using cloudflare edge 162.159.198.131:443"). */
export function warpGateway(text: string): string | undefined {
  return text.match(/using cloudflare edge (\S+:\d+)/)?.[1] ?? text.match(/masque-in-masque ready: (\S+:\d+) \(outer\)/)?.[1]
}

/**
 * Aether's line when it drops a working tunnel over its exit country ("exit location IR
 * rejected"). From Iran, Gool's inner hop is dialled from an Iranian-registered WARP address, so
 * Cloudflare often gives Gool an Iranian exit too, every time; Aether then retries forever.
 */
export const WARP_EXIT_REFUSED = /exit location [A-Z]{2} rejected/
/** After this many refused exits, the method gives up: its exit won't be foreign on this network. */
export const WARP_MAX_EXIT_REFUSED = 5

/** Aether's line when the IPv6 method can't work at all on this network. */
export const WARP_NO_IPV6 = /host has no IPv6 route/
