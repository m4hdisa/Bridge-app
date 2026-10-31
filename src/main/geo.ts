// Finds where traffic leaves the VPN (exit IP, country, city), by asking public
// IP-geolocation services *through* the VPN. This can differ from the server's own
// location, e.g. behind a CDN or a relay.
import { session } from 'electron'
import type { ExitLocation } from '../shared/types'

const regionName = new Intl.DisplayNames(['en'], { type: 'region' })

/** Tried in order; each returns undefined if its answer is unusable. */
const SOURCES: { url: string; parse: (j: any) => ExitLocation | undefined }[] = [
  {
    url: 'https://ipwho.is/',
    parse: (j) => (j?.success && j.country_code ? { ip: j.ip, countryCode: j.country_code, country: j.country, city: j.city || undefined } : undefined)
  },
  {
    url: 'https://api.country.is/',
    parse: (j) => (j?.country ? { ip: j.ip, countryCode: j.country, country: regionName.of(j.country) || j.country } : undefined)
  },
  {
    url: 'http://ip-api.com/json/',
    parse: (j) => (j?.status === 'success' ? { ip: j.query, countryCode: j.countryCode, country: j.country, city: j.city || undefined } : undefined)
  }
]

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
}

/** Looks up the exit location through the VPN-only SOCKS port. Undefined if every source fails. */
export async function lookupExit(probePort: number): Promise<ExitLocation | undefined> {
  // A private session so the proxy setting never touches the app window's own requests.
  const ses = session.fromPartition('bridge-probe', { cache: false })
  await ses.setProxy({ proxyRules: `socks5://127.0.0.1:${probePort}` })
  await ses.closeAllConnections()
  for (const { url, parse } of SOURCES) {
    try {
      const res = await withTimeout(ses.fetch(url), 8000)
      if (!res.ok) continue
      const exit = parse(await res.json())
      if (exit) return { ...exit, countryCode: exit.countryCode.toUpperCase() }
    } catch {
      // Try the next source.
    }
  }
  return undefined
}
