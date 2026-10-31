// Converts share links (vless://, vmess://, trojan://, ss://, hysteria2://, tuic://)
// into sing-box outbound objects.
import { randomUUID } from 'node:crypto'
import type { Outbound, Protocol, ServerProfile } from '../shared/types'

export class UnsupportedLinkError extends Error {}

/** uTLS fingerprints sing-box accepts. Panels sometimes send others (e.g. Xray's "unsafe"). */
const FINGERPRINTS = new Set(['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'])

/**
 * Fixes values sing-box would refuse to start with. Applied when parsing and again
 * when building a config, so servers imported by older versions are fixed too.
 */
export function normalizeOutbound<T extends Record<string, unknown>>(outbound: T): T {
  const tls = outbound.tls as { utls?: { fingerprint?: string } } | undefined
  const fp = tls?.utls?.fingerprint
  if (!tls?.utls || fp === undefined) return outbound
  const fixed = FINGERPRINTS.has(fp.toLowerCase()) ? fp.toLowerCase() : 'chrome'
  if (fixed === fp) return outbound
  return { ...outbound, tls: { ...tls, utls: { ...tls.utls, fingerprint: fixed } } }
}

export function decodeBase64(input: string): string {
  let s = input.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  while (s.length % 4 !== 0) s += '='
  return Buffer.from(s, 'base64').toString('utf8')
}

function looksLikeBase64(s: string): boolean {
  return /^[A-Za-z0-9+/=_-]+$/.test(s.replace(/\s+/g, ''))
}

/**
 * Pulls share links out of arbitrary text: one link per line, or a whole
 * base64-encoded subscription body.
 */
export function extractLinks(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let body = trimmed
  if (!trimmed.includes('://') && looksLikeBase64(trimmed)) {
    try {
      body = decodeBase64(trimmed)
    } catch {
      // not base64 after all
    }
  }
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-z0-9]+:\/\//i.test(l))
}

export function parseLink(link: string): ServerProfile {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase()
  switch (scheme) {
    case 'vless':
      return parseVless(link)
    case 'vmess':
      return parseVmess(link)
    case 'trojan':
      return parseTrojan(link)
    case 'ss':
      return parseShadowsocks(link)
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(link)
    case 'tuic':
      return parseTuic(link)
    default:
      throw new UnsupportedLinkError(`Unsupported link type: ${scheme}://`)
  }
}

// ---------- helpers ----------

interface ParsedUrl {
  user: string
  pass: string
  host: string
  port: number
  params: URLSearchParams
  name: string
}

function parseUrl(link: string): ParsedUrl {
  // Swap the scheme for http so the WHATWG parser treats it as a normal URL.
  const url = new URL('http' + link.slice(link.indexOf('://')))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || 443)
  if (!host) throw new Error('Missing server address')
  return {
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    host,
    port,
    params: url.searchParams,
    name: safeDecode(url.hash.replace(/^#/, ''))
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function truthy(v: string | null | undefined): boolean {
  return v === '1' || v === 'true'
}

function list(v: string | null | undefined): string[] | undefined {
  if (!v) return undefined
  const items = v.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined || obj[k] === '') delete obj[k]
  return obj
}

interface TlsOptions {
  security?: string | null
  sni?: string | null
  fp?: string | null
  alpn?: string | null
  insecure?: boolean
  publicKey?: string | null
  shortId?: string | null
  fallbackSni?: string
}

function buildTls(o: TlsOptions): Record<string, unknown> | undefined {
  const security = (o.security || '').toLowerCase()
  if (security !== 'tls' && security !== 'reality' && security !== 'xtls') return undefined
  const tls: Record<string, unknown> = compact({
    enabled: true,
    server_name: o.sni || o.fallbackSni,
    insecure: o.insecure || undefined,
    alpn: list(o.alpn)
  })
  const fp = o.fp || (security === 'reality' ? 'chrome' : '')
  if (fp) tls.utls = { enabled: true, fingerprint: fp }
  if (security === 'reality') {
    if (!o.publicKey) throw new Error('REALITY link is missing pbk (public key)')
    tls.reality = compact({ enabled: true, public_key: o.publicKey, short_id: o.shortId || undefined })
  }
  return tls
}

interface TransportOptions {
  type?: string | null
  host?: string | null
  path?: string | null
  serviceName?: string | null
  headerType?: string | null
}

function buildTransport(o: TransportOptions): Record<string, unknown> | undefined {
  const type = (o.type || 'tcp').toLowerCase()
  switch (type) {
    case 'tcp':
    case 'raw':
    case '':
      // Xray's TCP "HTTP header" camouflage has no sing-box equivalent.
      if ((o.headerType || 'none').toLowerCase() === 'http') {
        throw new UnsupportedLinkError('TCP with HTTP header camouflage (headerType=http) is Xray-only, not supported by the sing-box core')
      }
      return undefined
    case 'ws': {
      let path = o.path || '/'
      const t: Record<string, unknown> = { type: 'ws' }
      // Xray-style early data: /path?ed=2048
      const m = path.match(/[?&]ed=(\d+)/)
      if (m) {
        t.max_early_data = Number(m[1])
        t.early_data_header_name = 'Sec-WebSocket-Protocol'
        path = path.replace(/[?&]ed=\d+/, '').replace(/\?$/, '') || '/'
      }
      t.path = path
      if (o.host) t.headers = { Host: o.host }
      return t
    }
    case 'grpc':
      return compact({ type: 'grpc', service_name: o.serviceName || o.path || undefined })
    case 'http':
    case 'h2':
      return compact({ type: 'http', host: list(o.host), path: o.path || undefined })
    case 'httpupgrade':
      return compact({ type: 'httpupgrade', host: o.host || undefined, path: o.path || undefined })
    default:
      throw new UnsupportedLinkError(`Transport "${type}" is not supported by the sing-box core`)
  }
}

function profile(protocol: Protocol, link: string, name: string, server: string, port: number, outbound: Outbound): ServerProfile {
  return {
    id: randomUUID(),
    name: name || `${server}:${port}`,
    protocol,
    server,
    port,
    link,
    outbound: normalizeOutbound(outbound)
  }
}

// ---------- protocols ----------

function parseVless(link: string): ServerProfile {
  const u = parseUrl(link)
  const p = u.params
  if (!u.user) throw new Error('VLESS link is missing the UUID')
  // Xray's post-quantum "VLESS Encryption" (encryption=mlkem768x25519plus...) is not in sing-box;
  // connecting without it just times out, so say so instead.
  const encryption = (p.get('encryption') || 'none').toLowerCase()
  if (encryption !== 'none') throw new UnsupportedLinkError(`VLESS Encryption ("${encryption.split('.')[0]}") is Xray-only, not supported by the sing-box core`)
  const outbound: Outbound = compact({
    type: 'vless' as const,
    server: u.host,
    server_port: u.port,
    uuid: u.user,
    flow: p.get('flow') || undefined,
    tls: buildTls({
      security: p.get('security'),
      sni: p.get('sni'),
      fp: p.get('fp'),
      alpn: p.get('alpn'),
      insecure: truthy(p.get('allowInsecure')) || truthy(p.get('insecure')),
      publicKey: p.get('pbk'),
      shortId: p.get('sid'),
      fallbackSni: p.get('host') || undefined
    }),
    transport: buildTransport({
      type: p.get('type'),
      host: p.get('host'),
      path: p.get('path'),
      serviceName: p.get('serviceName'),
      headerType: p.get('headerType')
    })
  })
  return profile('vless', link, u.name, u.host, u.port, outbound)
}

function parseVmess(link: string): ServerProfile {
  const raw = link.slice('vmess://'.length)
  let j: Record<string, unknown>
  try {
    j = JSON.parse(decodeBase64(raw))
  } catch {
    throw new Error('VMess link is not valid base64 JSON')
  }
  const s = (k: string): string => (j[k] === undefined || j[k] === null ? '' : String(j[k]))
  const server = s('add')
  const port = Number(s('port') || 443)
  if (!server || !s('id')) throw new Error('VMess link is missing address or id')
  const outbound: Outbound = compact({
    type: 'vmess' as const,
    server,
    server_port: port,
    uuid: s('id'),
    security: s('scy') || 'auto',
    alter_id: Number(s('aid') || 0),
    tls: buildTls({
      security: s('tls'),
      sni: s('sni'),
      fp: s('fp'),
      alpn: s('alpn'),
      insecure: truthy(s('allowInsecure')) || truthy(s('skip-cert-verify')),
      fallbackSni: s('host') || undefined
    }),
    transport: buildTransport({
      type: s('net'),
      host: s('host'),
      path: s('path'),
      serviceName: s('path'),
      headerType: s('type')
    })
  })
  return profile('vmess', link, s('ps'), server, port, outbound)
}

function parseTrojan(link: string): ServerProfile {
  const u = parseUrl(link)
  const p = u.params
  if (!u.user) throw new Error('Trojan link is missing the password')
  const outbound: Outbound = compact({
    type: 'trojan' as const,
    server: u.host,
    server_port: u.port,
    password: u.user,
    tls: buildTls({
      // Trojan is always TLS unless the link explicitly says otherwise.
      security: p.get('security') || 'tls',
      sni: p.get('sni') || p.get('peer'),
      fp: p.get('fp'),
      alpn: p.get('alpn'),
      insecure: truthy(p.get('allowInsecure')) || truthy(p.get('insecure')),
      publicKey: p.get('pbk'),
      shortId: p.get('sid'),
      fallbackSni: u.host
    }),
    transport: buildTransport({
      type: p.get('type'),
      host: p.get('host'),
      path: p.get('path'),
      serviceName: p.get('serviceName'),
      headerType: p.get('headerType')
    })
  })
  return profile('trojan', link, u.name, u.host, u.port, outbound)
}

function parseShadowsocks(link: string): ServerProfile {
  let rest = link.slice('ss://'.length)
  let name = ''
  const hashAt = rest.indexOf('#')
  if (hashAt >= 0) {
    name = safeDecode(rest.slice(hashAt + 1))
    rest = rest.slice(0, hashAt)
  }
  let query = ''
  const qAt = rest.indexOf('?')
  if (qAt >= 0) {
    query = rest.slice(qAt + 1)
    rest = rest.slice(0, qAt).replace(/\/$/, '')
  }
  // Legacy format: everything before # is base64(method:password@host:port)
  if (!rest.includes('@')) rest = decodeBase64(rest)

  const at = rest.lastIndexOf('@')
  if (at < 0) throw new Error('Shadowsocks link is malformed')
  let userinfo = rest.slice(0, at)
  const hostPort = rest.slice(at + 1)
  userinfo = safeDecode(userinfo)
  if (!userinfo.includes(':')) userinfo = decodeBase64(userinfo)
  const colon = userinfo.indexOf(':')
  const method = userinfo.slice(0, colon)
  const password = userinfo.slice(colon + 1)

  const hp = hostPort.match(/^\[?([^\]]+?)\]?:(\d+)$/)
  if (!hp || !method) throw new Error('Shadowsocks link is malformed')
  const server = hp[1]
  const port = Number(hp[2])

  const outbound: Outbound = { type: 'shadowsocks', server, server_port: port, method, password }
  const plugin = new URLSearchParams(query).get('plugin')
  if (plugin) {
    const [pluginName, ...opts] = plugin.split(';')
    const supported: Record<string, string> = { 'obfs-local': 'obfs-local', 'simple-obfs': 'obfs-local', 'v2ray-plugin': 'v2ray-plugin' }
    if (!supported[pluginName]) throw new UnsupportedLinkError(`Shadowsocks plugin "${pluginName}" is not supported`)
    outbound.plugin = supported[pluginName]
    outbound.plugin_opts = opts.join(';')
  }
  return profile('shadowsocks', link, name, server, port, outbound)
}

function parseHysteria2(link: string): ServerProfile {
  const u = parseUrl(link)
  const p = u.params
  const password = u.pass ? `${u.user}:${u.pass}` : u.user
  const outbound: Outbound = compact({
    type: 'hysteria2' as const,
    server: u.host,
    server_port: u.port,
    password: password || undefined,
    tls: compact({
      enabled: true,
      server_name: p.get('sni') || u.host,
      insecure: truthy(p.get('insecure')) || undefined,
      alpn: list(p.get('alpn')) || ['h3']
    })
  })
  const obfs = p.get('obfs')
  if (obfs && obfs !== 'none') {
    outbound.obfs = { type: obfs, password: p.get('obfs-password') || '' }
  }
  const mport = p.get('mport')
  if (mport) outbound.server_ports = mport.split(',').map((r) => r.replace('-', ':'))
  return profile('hysteria2', link, u.name, u.host, u.port, outbound)
}

function parseTuic(link: string): ServerProfile {
  const u = parseUrl(link)
  const p = u.params
  if (!u.user) throw new Error('TUIC link is missing the UUID')
  const outbound: Outbound = compact({
    type: 'tuic' as const,
    server: u.host,
    server_port: u.port,
    uuid: u.user,
    password: u.pass || undefined,
    congestion_control: p.get('congestion_control') || undefined,
    udp_relay_mode: p.get('udp_relay_mode') || undefined,
    tls: compact({
      enabled: true,
      server_name: p.get('sni') || u.host,
      insecure: truthy(p.get('allow_insecure')) || truthy(p.get('insecure')) || undefined,
      alpn: list(p.get('alpn')) || ['h3']
    })
  })
  return profile('tuic', link, u.name, u.host, u.port, outbound)
}
