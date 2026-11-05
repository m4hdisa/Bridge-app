// Free configs from public lists on GitHub. Nobody vouches for these servers, so everything in a
// list is treated as hostile input: only ordinary proxy links are read, nothing that would leave
// the traffic readable on the way is kept, and the names in the lists are never shown.
import { isIP } from 'node:net'
import { extractLinks, parseLink } from './parser'
import { needsRelay, type XrayOutbound } from './xray'
import type { ServerProfile } from '../shared/types'

/** How many configs are tested on the user's network each time. */
export const PUBLIC_TEST_MAX = 400
/** How many of those that answer get a quick try of real traffic, a few at a time. */
export const PUBLIC_SAMPLE_MAX = 30
export const PUBLIC_SAMPLE_WORKERS = 5
export const PUBLIC_SAMPLE_BYTES = 1_000_000
export const PUBLIC_SAMPLE_MS = 2500
/** How many of those get a proper reading, with the line to themselves. */
export const PUBLIC_MEASURE_MAX = 12
export const PUBLIC_MEASURE_BYTES = 5_000_000
export const PUBLIC_MEASURE_MS = 4000
/** How many are kept. */
export const PUBLIC_KEEP = 8
/** A ping worse than this makes pages crawl whatever the speed, so such a config ranks last. */
const SLOW_PING_MS = 1500
/** Share of the tests that goes to TLS and Reality, which get through filtering most often. */
const STRONG_SHARE = 0.8
/** More than this from one list is ignored. */
const MAX_LINKS_PER_LIST = 5000

const SOURCES = [
  { repo: 'barry-far/V2ray-Config', path: 'Splitted-By-Protocol/vless.txt' },
  { repo: 'barry-far/V2ray-Config', path: 'Splitted-By-Protocol/trojan.txt' },
  { repo: 'MatinGhanbari/v2ray-configs', path: 'subscriptions/v2ray/super-sub.txt' },
  { repo: 'Danialsamadi/v2go', path: 'Sub1.txt' },
  { repo: 'Rayan-Config/C-Sub', path: 'configs/proxy.txt' },
  // Gathered from Telegram channels.
  { repo: 'Surfboardv2ray/TGParse', path: 'splitted/mixed' },
  { repo: 'hamedcode/port-based-v2ray-configs', path: 'sub/vless.txt' },
  { repo: 'nyeinkokoaung404/V2ray-Configs', path: 'All_Configs_Sub.txt' },
  { repo: 'mahdibland/V2RayAggregator', branch: 'master', path: 'Eternity.txt' }
]

const where = ({ repo, branch = 'main', path }: { repo: string; branch?: string; path: string }) => [`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`]

/** Where each list can be downloaded: GitHub, then a CDN for networks where GitHub's file host is filtered. */
export const PUBLIC_SOURCE_LISTS = SOURCES.map(where)
/** Bridge's own daily list, already tested by the Bridge-configs repo. It still gets tested on the user's network. */
export const PUBLIC_CLEAN_LIST = where({ repo: 'm4hdisa/Bridge-configs', path: 'clean.txt' })

/** The middle value, which one odd reading can't move. */
export function middleOf(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
}

/** Best first: speed decides, unless the ping is so bad that the speed wouldn't help. Ties go by ping. */
export function rankPublic<T extends { downMbps?: number; latency: number }>(found: T[]): T[] {
  const slow = (f: T) => (f.latency > SLOW_PING_MS ? 1 : 0)
  return [...found].sort((a, b) => slow(a) - slow(b) || (b.downMbps ?? 0) - (a.downMbps ?? 0) || a.latency - b.latency)
}

/**
 * Downloads every list it can. A list that fails is skipped; no links at all means nothing got
 * through. `clean` is what came from Bridge's own daily list, which gets tested first.
 */
export async function fetchPublicLinks(get: (url: string) => Promise<string>, log: (text: string) => void, sources = [PUBLIC_CLEAN_LIST, ...PUBLIC_SOURCE_LISTS]): Promise<{ links: string[]; clean: string[] }> {
  const lists = await Promise.all(
    sources.map(async (urls) => {
      for (const url of urls) {
        try {
          const links = extractLinks(await get(url))
          if (links.length) return links.slice(0, MAX_LINKS_PER_LIST)
        } catch (e) {
          log(`Public configs: ${new URL(url).hostname} didn't answer (${e instanceof Error ? e.message : e})`)
        }
      }
      return []
    })
  )
  return { links: [...new Set(lists.flat())], clean: sources[0] === PUBLIC_CLEAN_LIST ? lists[0] : [] }
}

/** Addresses on the user's own machine or network, which a list has no business pointing at. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) return /^(::1?$|f[cd]|fe[89ab]|::ffff:)/i.test(ip)
  const [a, b] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

const LOCAL_HOST = /(^|\.)(localhost|local|lan|internal|home|ir)$/i

/** Why a config can't be used, or undefined if it can. */
export function publicRefusal(s: ServerProfile): string | undefined {
  if (s.warp) return 'a WARP config'
  const host = s.server.replace(/^\[|\]$/g, '')
  if (isIP(host) ? isPrivateAddress(host) : LOCAL_HOST.test(host) || !host.includes('.')) return 'a local or Iranian address'
  const o = s.outbound as { tls?: { enabled?: boolean; insecure?: boolean }; security?: string; method?: string }
  if (s.protocol === 'vmess' && /^(none|zero)$/.test(o.security ?? '')) return 'not encrypted'
  if (s.protocol === 'shadowsocks' && /^(none|plain)$/.test(o.method ?? '')) return 'not encrypted'
  const xray = s.xray as XrayOutbound | undefined
  if (o.tls?.insecure || xray?.streamSettings?.tlsSettings?.allowInsecure) return "doesn't check the server's certificate"
  // VLESS and Trojan encrypt nothing themselves: without TLS the network can read the traffic.
  if ((s.protocol === 'vless' || s.protocol === 'trojan') && !o.tls?.enabled && (!xray || needsRelay(xray))) return 'not encrypted'
  return undefined
}

/**
 * Takes the first `max` of `servers` (best first) while spreading them out: filtering often hits a
 * whole operator's address range or a whole protocol at once, and the fastest are often neighbours.
 * If that leaves too few, the rest fill up in order.
 */
export function spreadOut(servers: ServerProfile[], max: number): ServerProfile[] {
  const ranges = new Map<string, number>()
  const protocols = new Map<string, number>()
  const picked: ServerProfile[] = []
  for (const s of servers) {
    if (picked.length >= max) break
    const range = isIP(s.server) === 4 ? s.server.split('.').slice(0, 3).join('.') : s.server
    if ((ranges.get(range) ?? 0) >= 2 || (protocols.get(s.protocol) ?? 0) >= Math.ceil(max / 2)) continue
    ranges.set(range, (ranges.get(range) ?? 0) + 1)
    protocols.set(s.protocol, (protocols.get(s.protocol) ?? 0) + 1)
    picked.push(s)
  }
  return [...picked, ...servers.filter((s) => !picked.includes(s))].slice(0, max)
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** TLS or Reality, or a protocol built on QUIC. */
function isStrong(s: ServerProfile): boolean {
  return !!(s.outbound as { tls?: { enabled?: boolean } }).tls?.enabled || !!(s.xray as XrayOutbound | undefined)?.streamSettings?.security || s.protocol === 'hysteria2' || s.protocol === 'tuic'
}

/**
 * Picks which configs to test: one for each address, none that `publicRefusal` turns down and none
 * in `skip` ("host:port", the ones already held), at random so that each try looks at different ones.
 * Those in `first` take their places before the rest, but no more than half: filtering can kill a
 * list that looked fine from abroad, and the others are the way out of that.
 */
export function choosePublicCandidates(links: string[], skip: Set<string>, max = PUBLIC_TEST_MAX, random: () => number = Math.random, first: string[] = []): ServerProfile[] {
  if (first.length) {
    const chosen = choosePublicCandidates(first, skip, Math.floor(max / 2), random)
    const held = new Set([...skip, ...chosen.map((s) => `${s.server}:${s.port}`)])
    return [...chosen, ...choosePublicCandidates(links, held, max - chosen.length, random)]
  }
  const seen = new Set(skip)
  const usable: ServerProfile[] = []
  for (const link of shuffled(links, random)) {
    if (!/^(vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\//i.test(link)) continue
    try {
      const s = parseLink(link)
      const key = `${s.server}:${s.port}`
      if (seen.has(key) || publicRefusal(s)) continue
      seen.add(key)
      usable.push(s)
    } catch {
      // Lists are full of links that don't parse.
    }
  }
  const strong = usable.filter(isStrong)
  const rest = usable.filter((s) => !isStrong(s))
  const leading = strong.slice(0, Math.ceil(max * STRONG_SHARE))
  const others = rest.slice(0, max - leading.length)
  return [...leading, ...others, ...strong.slice(leading.length)].slice(0, max)
}
