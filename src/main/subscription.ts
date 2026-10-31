// Downloads and parses subscription URLs.
import { decodeBase64, extractLinks } from './parser'
import type { Subscription } from '../shared/types'

export interface SubscriptionResult {
  links: string[]
  usage?: Subscription['usage']
  /** Name the panel gives the subscription (`profile-title` header). */
  title?: string
  /** How often the panel asks clients to update (`profile-update-interval` header, hours). */
  updateHours?: number
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

const UNITS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }

/** Config names from share links (the #fragment, or "ps" inside a vmess link). */
function linkNames(links: string[]): string[] {
  return links.map((l) => {
    try {
      if (l.startsWith('vmess://')) return String(JSON.parse(decodeBase64(l.slice(8))).ps || '')
      const i = l.indexOf('#')
      return i < 0 ? '' : decodeURIComponent(l.slice(i + 1))
    } catch {
      return ''
    }
  })
}

/**
 * Fallback when there is no subscription-userinfo header: many panels write the usage
 * into a config name, like "📊173.83GB Left-🕐expiredAt 26Days" or "۲۶ روز باقیمانده".
 */
export function usageFromNames(links: string[]): Subscription['usage'] {
  let remaining: number | undefined
  let days: number | undefined
  for (const raw of linkNames(links)) {
    // Persian digits -> ASCII, so one set of patterns covers both.
    const name = raw.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    const r =
      name.match(/([\d.]+)\s*([KMGT])i?B\s*(?:left|remain)/i) ||
      name.match(/(?:left|remain(?:ing)?|traffic)\s*:?\s*([\d.]+)\s*([KMGT])i?B/i) ||
      name.match(/([\d.]+)\s*(?:([KMGT])i?B|(گیگ|مگ))[^\d]{0,12}(?:باقی|مانده)/)
    if (r && remaining === undefined) {
      const unit = r[2] ? r[2].toLowerCase() : r[3] === 'مگ' ? 'm' : 'g'
      remaining = Math.round(parseFloat(r[1]) * UNITS[unit])
    }
    const d = name.match(/(\d+)\s*(?:days?|روز)/i)
    if (d && days === undefined && /expire|left|remain|روز/i.test(name)) days = Number(d[1])
  }
  if (remaining === undefined && days === undefined) return undefined
  return {
    upload: 0,
    download: 0,
    total: 0,
    remaining,
    expire: days !== undefined ? Math.floor(Date.now() / 1000) + days * 86400 : undefined
  }
}

/** `profile-title` is either plain text or "base64:<encoded>". */
function parseTitle(header: string | null): string | undefined {
  if (!header) return undefined
  try {
    return (header.startsWith('base64:') ? decodeBase64(header.slice(7)) : decodeURIComponent(header)).trim() || undefined
  } catch {
    return header
  }
}

function download(url: string): Promise<Response> {
  return fetch(url, {
    // Panels (Marzban, 3x-ui, Hiddify...) pick the output format from the User-Agent;
    // this one gets plain base64 share links.
    headers: { 'User-Agent': 'v2rayN/7.0 Bridge/0.1' },
    signal: AbortSignal.timeout(20000)
  })
}

export async function fetchSubscription(url: string): Promise<SubscriptionResult> {
  let res = await download(url)
  // Some panels answer 5xx now and then (rate limits); one retry usually gets through.
  if (res.status >= 500) {
    await new Promise((r) => setTimeout(r, 2000))
    res = await download(url)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  const links = extractLinks(body)
  if (!links.length) throw new Error('The subscription returned no share links')
  const interval = Number(res.headers.get('profile-update-interval'))
  return {
    links,
    usage: parseUserInfo(res.headers.get('subscription-userinfo')) || usageFromNames(links),
    title: parseTitle(res.headers.get('profile-title')),
    updateHours: interval > 0 ? interval : undefined
  }
}
