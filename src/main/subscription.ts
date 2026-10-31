// Downloads and parses subscription URLs.
import { extractLinks } from './parser'
import type { Subscription } from '../shared/types'

export interface SubscriptionResult {
  links: string[]
  usage?: Subscription['usage']
}

/** Parses `upload=1; download=2; total=3; expire=4` from the subscription-userinfo header. */
function parseUserInfo(header: string | null): Subscription['usage'] {
  if (!header) return undefined
  const v: Record<string, number> = {}
  for (const part of header.split(';')) {
    const [k, n] = part.split('=').map((s) => s.trim())
    if (k && n && !Number.isNaN(Number(n))) v[k] = Number(n)
  }
  if (v.total === undefined) return undefined
  return { upload: v.upload || 0, download: v.download || 0, total: v.total, expire: v.expire || undefined }
}

export async function fetchSubscription(url: string): Promise<SubscriptionResult> {
  const res = await fetch(url, {
    // Panels (Marzban, 3x-ui, Hiddify...) pick the output format from the User-Agent;
    // this one gets plain base64 share links.
    headers: { 'User-Agent': 'v2rayN/7.0 Bridge/0.1' },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  const links = extractLinks(body)
  if (!links.length) throw new Error('No supported links found in the subscription')
  return { links, usage: parseUserInfo(res.headers.get('subscription-userinfo')) }
}
