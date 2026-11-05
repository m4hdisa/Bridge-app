// Some subscriptions (BPB Panel's Normal and Fragment, many others) answer with whole client config
// files instead of share links. This pulls the servers out of Xray, sing-box and Clash configs in
// JSON and writes them as share links, which is what the rest of Bridge works with.

type Json = Record<string, any>

/** One server, in the terms of a share link. */
interface Parts {
  scheme: 'vless' | 'trojan' | 'vmess'
  user: string
  host: string
  port: number
  name: string
  network?: string
  path?: string
  hostHeader?: string
  serviceName?: string
  mode?: string
  security?: string
  sni?: string
  fp?: string
  alpn?: string
  insecure?: boolean
  pbk?: string
  sid?: string
  spx?: string
  flow?: string
  encryption?: string
  /** VMess only: how it encrypts. */
  cipher?: string
  /** Xray's finalmask, as JSON: fragmenting the TLS hello, for example. */
  finalmask?: string
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v))
const alpnText = (v: unknown) => (Array.isArray(v) ? v.join(',') : str(v))
const earlyData = (path: string | undefined, ms: unknown) => (Number(ms) > 0 && path && !/[?&]ed=/.test(path) ? `${path}${path.includes('?') ? '&' : '?'}ed=${ms}` : path)

function toLink(p: Parts): string {
  if (p.scheme === 'vmess') {
    return `vmess://${b64(
      JSON.stringify({ v: '2', ps: p.name, add: p.host, port: p.port, id: p.user, aid: 0, scy: p.cipher ?? 'auto', net: p.network ?? 'tcp', type: 'none', host: p.hostHeader ?? '', path: p.path ?? p.serviceName ?? '', tls: p.security === 'tls' ? 'tls' : '', sni: p.sni ?? '', alpn: p.alpn ?? '', fp: p.fp ?? '' })
    )}`
  }
  const params = new URLSearchParams()
  const add = (k: string, v: string | undefined) => v && params.append(k, v)
  if (p.scheme === 'vless') add('encryption', p.encryption ?? 'none')
  add('type', p.network ?? 'tcp')
  add('security', p.security ?? 'none')
  add('host', p.hostHeader)
  add('path', p.path)
  add('serviceName', p.serviceName)
  add('mode', p.mode)
  add('sni', p.sni)
  add('fp', p.fp)
  add('alpn', p.alpn)
  add('allowInsecure', p.insecure ? '1' : undefined)
  add('pbk', p.pbk)
  add('sid', p.sid)
  add('spx', p.spx)
  add('flow', p.flow)
  add('fm', p.finalmask)
  const host = p.host.includes(':') ? `[${p.host}]` : p.host
  return `${p.scheme}://${encodeURIComponent(p.user)}@${host}:${p.port}?${params}#${encodeURIComponent(p.name)}`
}

const ssLink = (method: string, password: string, host: string, port: number, name: string) => `ss://${b64(`${method}:${password}`)}@${host.includes(':') ? `[${host}]` : host}:${port}#${encodeURIComponent(name)}`

/** What fragmenting looks like when another outbound does it, in the terms of finalmask. */
function dialerFinalmask(outbound: Json, all: Json[]): string | undefined | null {
  const tag = outbound.streamSettings?.sockopt?.dialerProxy
  if (!tag) return undefined
  const fragment = all.find((o) => o.tag === tag)?.settings?.fragment
  // A chain through another server can't be written as a link.
  if (!fragment) return null
  return JSON.stringify({ tcp: [{ type: 'fragment', settings: { packets: fragment.packets, length: fragment.length, delay: fragment.interval } }] })
}

function fromXrayOutbound(o: Json, all: Json[], name: string): string | undefined {
  const dialed = dialerFinalmask(o, all)
  if (dialed === null) return undefined
  const s = o.settings ?? {}
  const st: Json = o.streamSettings ?? {}
  const target: Json = s.vnext?.[0] ?? s.servers?.[0] ?? s
  const user: Json = target.users?.[0] ?? target
  const host = str(target.address)
  const port = Number(target.port)
  if (!host || !port) return undefined
  if (o.protocol === 'shadowsocks') return user.method && user.password ? ssLink(user.method, user.password, host, port, name) : undefined
  if (o.protocol !== 'vless' && o.protocol !== 'vmess' && o.protocol !== 'trojan') return undefined
  const credential = str(o.protocol === 'trojan' ? user.password : user.id)
  if (!credential) return undefined
  const network = str(st.network ?? st.method) ?? 'tcp'
  const transport: Json = st.wsSettings ?? st.httpupgradeSettings ?? st.xhttpSettings ?? st.splithttpSettings ?? {}
  const tls: Json = st.tlsSettings ?? {}
  const reality: Json = st.realitySettings ?? {}
  return toLink({
    scheme: o.protocol,
    user: credential,
    host,
    port,
    name,
    network: network === 'raw' ? 'tcp' : network === 'websocket' ? 'ws' : network,
    path: str(transport.path),
    hostHeader: str(transport.host ?? transport.headers?.Host),
    serviceName: str(st.grpcSettings?.serviceName),
    mode: str(transport.mode),
    security: str(st.security),
    sni: str(tls.serverName ?? reality.serverName),
    fp: str(tls.fingerprint ?? reality.fingerprint),
    alpn: alpnText(tls.alpn),
    insecure: !!tls.allowInsecure,
    pbk: str(reality.password ?? reality.publicKey),
    sid: str(reality.shortId),
    spx: str(reality.spiderX),
    flow: str(user.flow),
    encryption: str(user.encryption),
    cipher: str(user.security),
    finalmask: st.finalmask ? JSON.stringify(st.finalmask) : (dialed ?? undefined)
  })
}

function fromSingBoxOutbound(o: Json): string | undefined {
  const host = str(o.server)
  const port = Number(o.server_port)
  const name = str(o.tag) ?? `${host}:${port}`
  if (!host || !port) return undefined
  if (o.type === 'shadowsocks') return o.method && o.password ? ssLink(o.method, o.password, host, port, name) : undefined
  if (o.type !== 'vless' && o.type !== 'vmess' && o.type !== 'trojan') return undefined
  const credential = str(o.type === 'trojan' ? o.password : o.uuid)
  if (!credential) return undefined
  const t: Json = o.transport ?? {}
  const tls: Json = o.tls ?? {}
  return toLink({
    scheme: o.type,
    user: credential,
    host,
    port,
    name,
    network: str(t.type),
    path: earlyData(str(t.path), t.max_early_data),
    hostHeader: str(t.headers?.Host ?? t.host),
    serviceName: str(t.service_name),
    security: tls.enabled ? (tls.reality?.enabled ? 'reality' : 'tls') : undefined,
    sni: str(tls.server_name),
    fp: str(tls.utls?.fingerprint),
    alpn: alpnText(tls.alpn),
    insecure: !!tls.insecure,
    pbk: str(tls.reality?.public_key),
    sid: str(tls.reality?.short_id),
    flow: str(o.flow),
    cipher: str(o.security)
  })
}

function fromClashProxy(o: Json): string | undefined {
  const host = str(o.server)
  const port = Number(o.port)
  const name = str(o.name) ?? `${host}:${port}`
  if (!host || !port) return undefined
  if (o.type === 'ss') return o.cipher && o.password ? ssLink(o.cipher, o.password, host, port, name) : undefined
  if (o.type !== 'vless' && o.type !== 'vmess' && o.type !== 'trojan') return undefined
  const credential = str(o.type === 'trojan' ? o.password : o.uuid)
  if (!credential) return undefined
  const ws: Json = o['ws-opts'] ?? {}
  const reality: Json | undefined = o['reality-opts']
  return toLink({
    scheme: o.type,
    user: credential,
    host,
    port,
    name,
    network: str(o.network),
    path: earlyData(str(ws.path), ws['max-early-data']),
    hostHeader: str(ws.headers?.Host),
    serviceName: str(o['grpc-opts']?.['grpc-service-name']),
    // Trojan is always TLS in Clash, so the file doesn't have to say so.
    security: reality ? 'reality' : o.tls || o.type === 'trojan' ? 'tls' : undefined,
    sni: str(o.servername ?? o.sni),
    fp: str(o['client-fingerprint']),
    alpn: alpnText(o.alpn),
    insecure: !!o['skip-cert-verify'],
    pbk: str(reality?.['public-key']),
    sid: str(reality?.['short-id']),
    flow: str(o.flow),
    cipher: str(o.cipher)
  })
}

/** Without the name, so the same server under two names counts once. */
const withoutName = (link: string) => (link.startsWith('vmess://') ? link : link.split('#')[0])

/** The servers in a JSON config file (or a list of them), as share links. Empty if it isn't one. */
export function linksFromConfigFile(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const links: (string | undefined)[] = []
  for (const config of (Array.isArray(parsed) ? parsed : [parsed]) as Json[]) {
    if (!config || typeof config !== 'object') continue
    if (Array.isArray(config.proxies)) links.push(...config.proxies.map(fromClashProxy))
    for (const o of Array.isArray(config.outbounds) ? (config.outbounds as Json[]) : []) {
      if (o.type) links.push(fromSingBoxOutbound(o))
      else if (o.protocol) links.push(fromXrayOutbound(o, config.outbounds, str(config.remarks) ?? str(o.tag) ?? 'Config'))
    }
  }
  const seen = new Set<string>()
  return links.filter((l): l is string => {
    if (!l || seen.has(withoutName(l))) return false
    seen.add(withoutName(l))
    return true
  })
}

/** Why a downloaded body has no servers in it, in words the user can act on. */
export function noLinksReason(text: string): string {
  const body = text.trim()
  if (/^<(!doctype|html)/i.test(body)) return "This address is a web page, not a subscription. If it is a panel, copy the subscription link from inside it; Bridge couldn't find one by itself"
  if (/"(wireguard|WireGuard)"/.test(body)) return "This subscription only has WireGuard (WARP) configs, which Bridge doesn't import. Use Bridge's Free WARP instead"
  return 'The subscription returned no share links'
}
