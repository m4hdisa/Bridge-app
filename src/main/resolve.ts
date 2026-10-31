// Resolves VPN server hostnames without trusting the local network's DNS.
// Iranian ISPs answer DNS for blocked domains with fake addresses (10.10.34.x),
// which made sing-box dial 10.10.34.34 instead of the real server. So the server's
// address is looked up before connecting, from several sources, ignoring poisoned
// answers, and the last good answer is remembered for when every source fails.
import { promises as dns } from 'node:dns'
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
