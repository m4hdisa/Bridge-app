// The daily public list. Gathers configs from the public GitHub lists and public Telegram channels,
// applies Bridge's own safety filters, tests them with the real cores and writes the ones that carry
// HTTPS. It runs in the Bridge-configs repo as a bundled file: npm run bundle-collector.
// Usage: node collect.cjs --channels channels.txt --cores <dir with sing-box.exe and xray.exe> --out <dir>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { decodeBase64 } from '../src/main/parser'
import { cloudflareKey, toCloudflare, withFragment } from '../src/main/cloudflarecdn'
import { choosePublicCandidates, COLLECTOR_EXTRA_LISTS, fetchPublicLinks, PUBLIC_SOURCE_LISTS, publicRefusal } from '../src/main/publicconfigs'
import { parseLink } from '../src/main/parser'
import { DEFAULT_SETTINGS } from '../src/main/store'

const TEST_MAX = Number(arg('--test-max') ?? 1500)
const KEEP_MAX = Number(arg('--keep-max') ?? 300)
// Few of them work on any day, so all of them get tested.
const CF_TEST_MAX = Number(arg('--cf-test-max') ?? 6000)
const CF_KEEP_MAX = Number(arg('--cf-keep-max') ?? 150)
/** Below this something is wrong with the run, and yesterday's list is better. */
const KEEP_MIN = Number(arg('--keep-min') ?? 20)
const LINK = /(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\/[^\s<>"']+/g

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))

/** The links in a channel's public preview page. */
export function linksInChannelPage(html: string): string[] {
  return (html.match(LINK) ?? []).map(unescapeHtml)
}

async function fromChannels(names: string[]): Promise<{ links: string[]; answered: number }> {
  const queue = [...names]
  const links: string[] = []
  let answered = 0
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let name = queue.shift(); name; name = queue.shift()) {
        const found = await getText(`https://t.me/s/${encodeURIComponent(name)}`).then(linksInChannelPage, () => undefined)
        if (found) answered++
        links.push(...(found ?? []))
      }
    })
  )
  return { links, answered }
}

/** The same link under the list's own name, so no advert in a name goes any further. */
export function withName(link: string, name: string): string {
  if (!link.startsWith('vmess://')) return `${link.split('#')[0]}#${encodeURIComponent(name)}`
  const body = JSON.parse(decodeBase64(link.slice('vmess://'.length)))
  return `vmess://${Buffer.from(JSON.stringify({ ...body, ps: name }), 'utf8').toString('base64')}`
}

async function main() {
  const started = Date.now()
  const cores = arg('--cores') ?? join(__dirname, 'cores')
  const out = arg('--out') ?? process.cwd()
  const channelFile = arg('--channels')
  const names = channelFile && existsSync(channelFile) ? readFileSync(channelFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9_]{4,40}$/.test(l)) : []

  const fromLists = (await fetchPublicLinks(getText, (t) => console.log(t), [...PUBLIC_SOURCE_LISTS, ...COLLECTOR_EXTRA_LISTS])).links
  const channels = await fromChannels(names)
  const all = [...new Set([...channels.links, ...fromLists])]
  console.log(`${fromLists.length} links from lists, ${channels.links.length} from ${channels.answered} of ${names.length} channels, ${all.length} different`)
  const candidates = choosePublicCandidates(all, new Set(), TEST_MAX)
  console.log(`${candidates.length} candidates after the filters`)

  // Configs behind Cloudflare, moved onto one Cloudflare address: they all share it, so they are
  // told apart by Host and path, not picked by address like the others.
  const converted = new Map<string, string>()
  for (const link of all) {
    const cf = toCloudflare(link)
    if (cf && !converted.has(cloudflareKey(cf))) converted.set(cloudflareKey(cf), cf)
  }
  const cfCandidates = [...converted.values()]
    .sort(() => Math.random() - 0.5)
    .flatMap((link) => {
      try {
        const s = parseLink(link)
        return publicRefusal(s) ? [] : [s]
      } catch {
        return []
      }
    })
    .slice(0, CF_TEST_MAX)
  console.log(`${converted.size} configs behind Cloudflare, ${cfCandidates.length} of them tested`)

  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-collect-'))
  const core = new Core({ singBox: join(cores, 'sing-box.exe'), xray: join(cores, 'xray.exe'), rulesDir: join(cores, 'rules'), dataDir })
  core.on('log', (l: { text: string }) => /^Public configs/.test(l.text) && console.log(l.text))
  const kept = await core.checkPublicConfigs(candidates, DEFAULT_SETTINGS.testUrl, KEEP_MAX)
  const cfKept = await core.checkPublicConfigs(cfCandidates, DEFAULT_SETTINGS.testUrl, CF_KEEP_MAX)
  await core.stop().catch(() => undefined)
  rmSync(dataDir, { recursive: true, force: true })

  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`${kept.length} kept and ${cfKept.length} behind Cloudflare in ${seconds} s`)
  if (kept.length < KEEP_MIN) throw new Error(`Only ${kept.length} configs passed; keeping the previous list`)

  const links = kept.map((k, i) => withName(k.server.link, `Bridge ${i + 1}`))
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'clean.txt'), `${links.join('\n')}\n`)
  // Each one twice: as it is, and with its TLS hello split, for networks that look for the server name.
  const cfLinks = cfKept.flatMap((k, i) => [withName(k.server.link, `Bridge CF ${i + 1}`), withName(withFragment(k.server.link), `Bridge CF ${i + 1} F`)])
  if (cfLinks.length) writeFileSync(join(out, 'cloudflare.txt'), `${cfLinks.join('\n')}\n`)
  const count = (protocol: string) => kept.filter((k) => k.server.protocol === protocol).length
  writeFileSync(
    join(out, 'stats.json'),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), collected: all.length, tested: candidates.length, kept: kept.length, cloudflare: cfKept.length, cloudflareFound: converted.size, vless: count('vless'), trojan: count('trojan'), vmess: count('vmess'), shadowsocks: count('shadowsocks'), hysteria2: count('hysteria2'), tuic: count('tuic'), channelsAnswered: channels.answered, seconds }, null, 2)}\n`
  )
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
)
