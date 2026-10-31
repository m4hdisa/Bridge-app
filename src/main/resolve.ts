// Resolves VPN server hostnames without trusting the local network's DNS.
// Iranian ISPs answer DNS for blocked domains with fake addresses (10.10.34.x),
// which made sing-box dial 10.10.34.34 instead of the real server. So the server's
// address is looked up before connecting, from several sources, ignoring poisoned
// answers, and the last good answer is remembered for when every source fails.
import { promises as dns, Resolver } from 'node:dns'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'

export interface Resolution {
  ip: string
  source: string
}

/** Addresses that are never a real public VPN server: private, loopback, link-local, CGNAT, benchmark/fake-IP. */
export function isBogusAddress(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  const [a, b] = p
  return (
    a === 0 ||
    a === 10 || // includes Iran's DNS-poisoning answers 10.10.34.x
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

async function viaDoh(url: string, name: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] }
  const ip = body.Answer?.find((a) => a.type === 1 && !isBogusAddress(a.data))?.data
  if (!ip) throw new Error(`no usable A record for ${name}`)
  return ip
}

async function viaSystem(name: string): Promise<string> {
  const { address } = await dns.lookup(name, { family: 4 })
  if (isBogusAddress(address)) throw new Error(`poisoned answer ${address}`)
  return address
}

/** Sends a real UDP DNS query to one server and checks it answers. */
async function dnsServerWorks(server: string): Promise<boolean> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 })
  resolver.setServers([server])
  return new Promise((resolve) => {
    resolver.resolve4('www.microsoft.com', (err, addresses) => resolve(!err && addresses.some((a) => !isBogusAddress(a))))
  })
}

/** A minimal DNS query (A record, recursion desired) in wire format. */
function dnsQueryPacket(name: string): Buffer {
  const header = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
  return Buffer.concat([header, ...labels, Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01])])
}

/** Sends one RFC 8484 DoH query (the exact protocol sing-box uses) and checks for an answer. */
async function dohServerWorks(server: string): Promise<boolean> {
  try {
    const q = dnsQueryPacket('www.microsoft.com').toString('base64url')
    const res = await fetch(`https://${server}/dns-query?dns=${q}`, {
      headers: { accept: 'application/dns-message' },
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return false
    const body = Buffer.from(await res.arrayBuffer())
    return body.length > 12 && body.readUInt16BE(6) > 0 // at least one answer record
  } catch {
    return false
  }
}

export interface DirectDns {
  type: 'https' | 'udp'
  server: string
}

/** Public DoH resolvers reachable by IP (their certificates cover the IP), in order of preference. */
const DOH_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4', '149.112.112.112']

/**
 * Chooses how Direct apps' domains are resolved while TUN is on.
 * Plain DNS (port 53) can't be used: sing-box's strict_route blocks port 53 outside
 * the TUN adapter on Windows (DNS leak protection), so a router or 1.1.1.1:53 resolver
 * times out and Direct apps (e.g. Chrome) could open nothing, even though the VPN
 * worked. DNS over HTTPS uses port 443 and is not affected, so a DoH server is probed
 * first; plain network DNS is only a last resort. Must run before TUN starts.
 */
export async function pickDirectDns(networkServers: string[], log: (text: string, level?: 'info' | 'warn') => void): Promise<DirectDns | undefined> {
  const doh = await Promise.all(DOH_SERVERS.map((s) => dohServerWorks(s)))
  const dohServer = DOH_SERVERS.find((_, i) => doh[i])
  if (dohServer) return { type: 'https', server: dohServer }

  log('No DNS-over-HTTPS server answered; falling back to plain DNS, Direct apps may not resolve names', 'warn')
  const usable = networkServers.filter((s) => !s.startsWith('127.') && !s.startsWith('0.'))
  for (const s of networkServers.filter((s) => !usable.includes(s))) log(`Network DNS ${s} is a local address (probably another VPN tool), not using it`, 'warn')
  const candidates = [...new Set([...usable, '1.1.1.1', '8.8.8.8'])]
  const results = await Promise.all(candidates.map((s) => dnsServerWorks(s)))
  const udp = candidates.find((_, i) => results[i])
  return udp ? { type: 'udp', server: udp } : undefined
}

export class ServerResolver {
  private cache: Record<string, string> = {}

  constructor(
    private cacheFile: string,
    private log: (text: string, level?: 'info' | 'warn') => void
  ) {
    try {
      if (existsSync(cacheFile)) this.cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch {
      this.cache = {}
    }
  }

  /** Returns a usable IPv4 address for a server host, or undefined if none could be found. */
  async resolve(host: string): Promise<Resolution | undefined> {
    if (isIP(host)) return { ip: host, source: 'address in link' }
    const name = encodeURIComponent(host)
    const sources: [string, Promise<string>][] = [
      ['Cloudflare DoH', viaDoh(`https://1.1.1.1/dns-query?name=${name}&type=A`, host)],
      ['Google DoH', viaDoh(`https://8.8.8.8/resolve?name=${name}&type=A`, host)],
      ['system DNS', viaSystem(host)]
    ]
    try {
      const result = await Promise.any(sources.map(([source, p]) => p.then((ip) => ({ ip, source }))))
      if (this.cache[host] !== result.ip) {
        this.cache[host] = result.ip
        try {
          writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2))
        } catch {
          // The cache is only a fallback.
        }
      }
      return result
    } catch (e) {
      const reasons = e instanceof AggregateError ? e.errors.map((err, i) => `${sources[i][0]}: ${err instanceof Error ? err.message : err}`) : [String(e)]
      const cached = this.cache[host]
      if (cached) {
        this.log(`Could not look up ${host} (${reasons.join('; ')}), using last known address ${cached}`, 'warn')
        return { ip: cached, source: 'last known address' }
      }
      this.log(`Could not look up ${host}: ${reasons.join('; ')}`, 'warn')
      return undefined
    }
  }
}
