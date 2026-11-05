// Configs behind Cloudflare's CDN, moved onto a Cloudflare address that answers from Iran. The
// approach comes from patterniha/Free-Configs (MIT): any VLESS or Trojan config on WebSocket,
// HTTPUpgrade, XHTTP or gRPC with a Host can be reached through any Cloudflare address, because
// Cloudflare picks the origin by the server name, not by the address dialled. Only what the
// official cores understand is used: its upload tricks need patterniha's own Xray build.

/** A Cloudflare address that answers on Iranian networks, which every converted config dials. */
export const CLOUDFLARE_ADDRESS = '188.114.98.0'
/** Cloudflare's HTTPS ports, which all lead to port 443, and its plain HTTP ones. */
const TLS_PORTS = new Set(['443', '2053', '2083', '2087', '2096', '8443'])
const HTTP_PORTS = new Set(['80', '8080', '8880', '2052', '2082', '2086', '2095'])
const TRANSPORTS = new Set(['ws', 'websocket', 'httpupgrade', 'xhttp', 'splithttp', 'grpc'])
/** Settings a list may carry that are left out: certificate opt-outs, and ways of dialling that are this project's choice, not the list's. */
const DROPPED = new Set(['allowinsecure', 'insecure', 'skip-cert-verify', 'fm', 'dialmode', 'ech', 'echoutbound', 'fp', 'cs', 'pqv'])
/** Splitting the TLS hello in the form the official Xray reads, for networks that look for the server name. */
export const CLOUDFLARE_FRAGMENT = JSON.stringify({ tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '100-200', delay: '1' } }] })

/**
 * The same config through CLOUDFLARE_ADDRESS on port 443 with TLS, its Host as the server name, and
 * HTTP/1.1 for the transports that start with an HTTP/1.1 upgrade. Undefined for anything else:
 * Reality, plain TCP, no Host, a port Cloudflare doesn't serve, or TLS on a plain HTTP port.
 */
export function toCloudflare(link: string): string | undefined {
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase()
  if (scheme !== 'vless' && scheme !== 'trojan') return undefined
  let url: URL
  try {
    url = new URL(`http${link.slice(link.indexOf('://'))}`)
  } catch {
    return undefined
  }
  const params = new Map<string, string>()
  for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), v)
  const security = (params.get('security') ?? '').toLowerCase()
  const transport = (params.get('type') ?? 'tcp').toLowerCase()
  const host = (params.get('host') ?? '').split(',')[0].trim()
  const port = url.port || (security === 'tls' ? '443' : '80')
  if (!url.username || !host || !TRANSPORTS.has(transport) || !['', 'tls', 'none'].includes(security)) return undefined
  if (TLS_PORTS.has(port) ? security !== 'tls' : !HTTP_PORTS.has(port) || security === 'tls') return undefined
  const out = new URLSearchParams()
  for (const [k, v] of params) if (!DROPPED.has(k) && !['security', 'sni', 'alpn', 'host'].includes(k)) out.set(k, v)
  out.set('security', 'tls')
  out.set('host', host)
  out.set('sni', host)
  out.set('fp', 'chrome')
  if (transport === 'ws' || transport === 'websocket' || transport === 'httpupgrade') out.set('alpn', 'http/1.1')
  else if (params.get('alpn')) out.set('alpn', params.get('alpn')!)
  const name = link.includes('#') ? link.slice(link.indexOf('#')) : ''
  return `${scheme}://${url.username}@${CLOUDFLARE_ADDRESS}:443?${out}${name}`
}

/** What makes two converted configs the same: everything but the name. */
export function cloudflareKey(link: string): string {
  return link.split('#')[0]
}

/** The same converted config with its TLS hello split. */
export function withFragment(link: string): string {
  const [body, name = ''] = link.split('#')
  return `${body}&fm=${encodeURIComponent(CLOUDFLARE_FRAGMENT)}${name ? `#${name}` : ''}`
}
