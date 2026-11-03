// Finds the largest packet this network carries without splitting it, with Windows' ping and its
// "don't fragment" flag. Plain internet is 1500; PPPoE lines (most ADSL and VDSL) are usually 1492.
import { execFile } from 'node:child_process'
import type { MtuResult } from '../shared/types'

/** An IPv4 header plus an ICMP header: ping's -l size doesn't count them. */
const HEADERS = 28
const MAX_PAYLOAD = 1500 - HEADERS
/** Below this the problem isn't the packet size; the adapter wouldn't work there anyway. */
const MIN_PAYLOAD = 1200 - HEADERS
const SMALL_PAYLOAD = 64
const MIN_ADAPTER_MTU = 1280
/** Room for the headers of a VPN protocol that runs over UDP (QUIC, WireGuard). */
const VPN_HEADERS = 80
export const MTU_TARGETS = ['1.1.1.1', '8.8.8.8', '9.9.9.9']

/** True if a packet with this much data got an answer. */
export type Ping = (host: string, payload: number, source?: string) => Promise<boolean>

/** `source` (the real adapter's IP) keeps the ping off Bridge's VPN adapter while connected. */
export const windowsPing: Ping = (host, payload, source) =>
  new Promise((resolve) => {
    const args = ['-n', '1', '-w', '1500', '-f', '-l', String(payload), ...(source ? ['-S', source] : []), host]
    // Ping's text is in Windows' language, but a real reply always says TTL=.
    execFile('ping', args, { windowsHide: true, timeout: 5000 }, (_e, stdout) => resolve(/TTL=/i.test(String(stdout))))
  })

/** A lost ping must not read as "too big": a size only fails after two tries. */
async function fits(ping: Ping, host: string, payload: number, source?: string): Promise<boolean> {
  return (await ping(host, payload, source)) || ping(host, payload, source)
}

/** The adapter MTU to suggest. On a path that carries full-size packets, the default is already right. */
export function recommendMtu(pathMtu: number): number | undefined {
  return pathMtu >= 1500 ? undefined : Math.max(MIN_ADAPTER_MTU, pathMtu - VPN_HEADERS)
}

export async function findPathMtu(targets: string[], source?: string, ping: Ping = windowsPing): Promise<MtuResult> {
  let target: string | undefined
  for (const t of targets) {
    if (await fits(ping, t, SMALL_PAYLOAD, source)) {
      target = t
      break
    }
  }
  if (!target) throw new Error('No test address answered ping on this network, so the MTU can\'t be measured. Disconnect the VPN and try again.')

  const done = (payload: number): MtuResult => ({ pathMtu: payload + HEADERS, target: target!, recommended: recommendMtu(payload + HEADERS) })
  if (await fits(ping, target, MAX_PAYLOAD, source)) return done(MAX_PAYLOAD)
  if (!(await fits(ping, target, MIN_PAYLOAD, source))) throw new Error('Even 1200-byte packets don\'t get through, so packet size isn\'t the problem here.')
  let low = MIN_PAYLOAD
  let high = MAX_PAYLOAD
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (await fits(ping, target, middle, source)) low = middle
    else high = middle
  }
  return done(low)
}
