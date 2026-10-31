// Xray-core support (written for Xray 26.x).
// sing-box stays in charge of TUN, per-app routing, DNS and health checks. Configs
// that only Xray understands (xhttp, VLESS Encryption, TCP HTTP camouflage...) run in
// a local xray.exe, and sing-box's "proxy" outbound becomes a SOCKS hop into it:
//   app -> TUN -> sing-box (rules) -> socks 127.0.0.1 -> xray.exe -> VPN server
import { decodeBase64 } from './parser'

export type XrayOutbound = Record<string, any>

class XrayLinkError extends Error {}

function truthy(v: string | null | undefined): boolean {
  return v === '1' || v === 'true'
}

function list(v: string | null | undefined): string[] | undefined {
  const items = (v || '').split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function clean<T extends Record<string, any>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '' || o[k] === null) delete o[k]
  return o
}

interface StreamParams {
  type?: string | null
  security?: string | null
  sni?: string | null
  fp?: string | null
  alpn?: string | null
  insecure?: boolean
  pbk?: string | null
  sid?: string | null
  spx?: string | null
  pqv?: string | null
  host?: string | null
  path?: string | null
  mode?: string | null
  extra?: string | null
  serviceName?: string | null
  authority?: string | null
  headerType?: string | null
  seed?: string | null
}

/** Builds Xray streamSettings from share-link style parameters. */
function buildStream(p: StreamParams): Record<string, any> {
  const type = (p.type || 'raw').toLowerCase()
  const stream: Record<string, any> = {}
  switch (type) {
    case 'raw':
    case 'tcp':
    case '':
      stream.method = 'raw'
      if ((p.headerType || '').toLowerCase() === 'http') {
        stream.rawSettings = {
          header: { type: 'http', request: clean({ path: list(p.path) || ['/'], headers: p.host ? { Host: list(p.host) } : undefined }) }
        }
      }
      break
    case 'xhttp':
    case 'splithttp': {
      stream.method = 'xhttp'
      const xhttp: Record<string, any> = clean({ host: p.host || undefined, path: p.path || '/', mode: p.mode || 'auto' })
      if (p.extra) {
        try {
          xhttp.extra = JSON.parse(p.extra)
        } catch {
          // Ignore a malformed "extra"; the basic settings still work.
        }
      }
      stream.xhttpSettings = xhttp
      break
    }
    case 'ws':
    case 'websocket':
      stream.method = 'websocket'
      stream.wsSettings = clean({ path: p.path || '/', host: p.host || undefined })
      break
    case 'httpupgrade':
      stream.method = 'httpupgrade'
      stream.httpupgradeSettings = clean({ path: p.path || '/', host: p.host || undefined })
      break
    case 'grpc':
      stream.method = 'grpc'
      stream.grpcSettings = clean({ serviceName: p.serviceName || p.path || undefined, authority: p.authority || undefined, multiMode: p.mode === 'multi' || undefined })
      break
    case 'kcp':
    case 'mkcp':
      stream.method = 'mkcp'
      stream.kcpSettings = clean({ seed: p.seed || undefined })
      break
    default:
      throw new XrayLinkError(`Transport "${type}" is not supported`)
  }

  const security = (p.security || 'none').toLowerCase()
  if (security === 'tls') {
    stream.security = 'tls'
    stream.tlsSettings = clean({
      serverName: p.sni || p.host || undefined,
      fingerprint: p.fp || 'chrome',
      alpn: list(p.alpn),
      allowInsecure: p.insecure || undefined
    })
  } else if (security === 'reality') {
    if (!p.pbk) throw new XrayLinkError('REALITY link is missing pbk (public key)')
    stream.security = 'reality'
    stream.realitySettings = clean({
      serverName: p.sni || undefined,
      // REALITY needs uTLS, so Xray's "unsafe" (plain Go TLS) is not allowed here.
      fingerprint: p.fp && p.fp !== 'unsafe' ? p.fp : 'chrome',
      password: p.pbk,
      shortId: p.sid || undefined,
      spiderX: p.spx || undefined,
      mldsa65Verify: p.pqv || undefined
    })
  }
  return stream
}

function urlParts(link: string) {
  const url = new URL('http' + link.slice(link.indexOf('://')))
  return {
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 443),
    params: url.searchParams
  }
}

function streamFromParams(params: URLSearchParams, defaults: Partial<StreamParams> = {}): Record<string, any> {
  const g = (k: string) => params.get(k)
  return buildStream({
    type: g('type'),
    security: g('security') ?? defaults.security,
    sni: g('sni') || g('peer'),
    fp: g('fp'),
    alpn: g('alpn'),
    insecure: truthy(g('allowInsecure')) || truthy(g('insecure')),
    pbk: g('pbk'),
    sid: g('sid'),
    spx: g('spx'),
    pqv: g('pqv'),
    host: g('host'),
    path: g('path'),
    mode: g('mode'),
    extra: g('extra'),
    serviceName: g('serviceName'),
    authority: g('authority'),
    headerType: g('headerType'),
    seed: g('seed')
  })
}

/** Converts a share link into an Xray outbound (without tag). Throws if Xray can't run it. */
export function linkToXray(link: string): XrayOutbound {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase()
  switch (scheme) {
    case 'vless': {
      const u = urlParts(link)
      if (!u.user) throw new XrayLinkError('VLESS link is missing the UUID')
      const encryption = u.params.get('encryption') || 'none'
      const stream = streamFromParams(u.params)
      // Xray 26 refuses VLESS with no TLS, no REALITY and no VLESS Encryption to a public server.
      if (encryption === 'none' && !stream.security) throw new XrayLinkError('Xray refuses VLESS without TLS, REALITY or VLESS Encryption')
      return {
        protocol: 'vless',
        settings: clean({ address: u.host, port: u.port, id: u.user, encryption, flow: u.params.get('flow') || undefined }),
        streamSettings: stream
      }
    }
    case 'trojan': {
      const u = urlParts(link)
      if (!u.user) throw new XrayLinkError('Trojan link is missing the password')
      return {
        protocol: 'trojan',
        settings: { address: u.host, port: u.port, password: u.user },
        streamSettings: streamFromParams(u.params, { security: 'tls' })
      }
    }
    case 'vmess': {
      const j = JSON.parse(decodeBase64(link.slice('vmess://'.length))) as Record<string, unknown>
      const s = (k: string) => (j[k] === undefined || j[k] === null ? '' : String(j[k]))
      if (!s('add') || !s('id')) throw new XrayLinkError('VMess link is missing address or id')
      return {
        protocol: 'vmess',
        settings: { address: s('add'), port: Number(s('port') || 443), id: s('id'), security: s('scy') || 'auto' },
        streamSettings: buildStream({
          type: s('net'),
          security: s('tls'),
          sni: s('sni'),
          fp: s('fp'),
          alpn: s('alpn'),
          host: s('host'),
          path: s('path'),
          serviceName: s('path'),
          headerType: s('type'),
          mode: s('mode')
        })
      }
    }
    default:
      throw new XrayLinkError(`${scheme}:// links are not handled by the Xray core in Bridge`)
  }
}

/** The VPN server address an Xray outbound connects to. */
export function xrayServer(o: XrayOutbound): { host: string; port: number } {
  return { host: String(o.settings?.address ?? ''), port: Number(o.settings?.port ?? 0) }
}

/** Like withServerIp() for sing-box: dial the resolved IP, keep the domain for SNI / Host. */
export function xrayWithServerIp(o: XrayOutbound, ip: string): XrayOutbound {
  const host = o.settings?.address
  if (typeof host !== 'string' || host === ip) return o
  const out = structuredClone(o)
  out.settings.address = ip
  const st = out.streamSettings || {}
  if (st.security === 'tls') st.tlsSettings = { serverName: host, ...st.tlsSettings }
  for (const key of ['wsSettings', 'httpupgradeSettings', 'xhttpSettings']) {
    if (st[key] && !st[key].host) st[key].host = host
  }
  return out
}

/** One local SOCKS port per outbound; each inbound is routed to its own outbound. */
export function buildXrayConfig(entries: { port: number; outbound: XrayOutbound }[], logLevel = 'warning'): Record<string, any> {
  return {
    log: { loglevel: logLevel },
    inbounds: entries.map((e, i) => ({
      tag: `in-${i}`,
      listen: '127.0.0.1',
      port: e.port,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true }
    })),
    outbounds: entries.map((e, i) => ({ ...e.outbound, tag: `out-${i}` })),
    routing: { rules: entries.map((_, i) => ({ inboundTag: [`in-${i}`], outboundTag: `out-${i}` })) }
  }
}
