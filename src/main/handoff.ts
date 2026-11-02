// Hands the UDP traffic of "Other VPN" apps (Discord voice, games) straight to the other tool.
//
// Windows routes by destination, not by app, so Bridge's TUN catches every app first. For an
// app set to "Other VPN", sing-box then re-sends its traffic from the other tool's adapter, but
// the socket belongs to sing-box.exe, and tools that pick traffic by app name (EZConnect /
// WireSock) don't carry it. Once Bridge sees such an app talk UDP to an address, it adds a
// host route for that address on the other tool's adapter: more specific than Bridge's half
// routes, so the app's next packets skip Bridge and reach the other tool from the app itself.
// Only UDP: voice and game servers have their own addresses, while TCP (chat, uploads) often
// goes to shared CDN addresses that other apps use too.

/** Upper bound on host routes added in one session. */
export const HANDOFF_MAX_ROUTES = 256

export interface HandoffConnection {
  chains?: string[]
  metadata: { network?: string; destinationIP?: string; processPath?: string }
}

/** A public IPv4 address (not private, loopback, link-local, CGNAT, multicast or reserved). */
export function isPublicIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b < 128) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b < 32) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

/**
 * New addresses to hand off: UDP destinations of connections that went out "direct-other",
 * minus addresses that other apps also reach through another outbound, and minus `known`.
 */
export function handoffCandidates(connections: HandoffConnection[], known: Set<string>, limit = HANDOFF_MAX_ROUTES): string[] {
  const shared = new Set<string>()
  const wanted = new Set<string>()
  for (const c of connections) {
    const ip = c.metadata.destinationIP
    if (!ip || !isPublicIPv4(ip)) continue
    if (c.chains?.[0] === 'direct-other') {
      if (c.metadata.network === 'udp') wanted.add(ip)
    } else shared.add(ip)
  }
  const room = Math.max(0, limit - known.size)
  return [...wanted].filter((ip) => !known.has(ip) && !shared.has(ip)).slice(0, room)
}
