// Public configs test. Offline part: which links are refused and how candidates are picked. Live
// part (safe on a VPS, no TUN or system proxy): downloads the real lists and tests them through
// separate local cores, the way the app does. Prints counts only, never the servers' addresses.
// Usage: tsx scripts/publicconfigtest.ts [--offline]
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { parseLink } from '../src/main/parser'
import { choosePublicCandidates, fetchPublicLinks, isPrivateAddress, middleOf, PUBLIC_CLEAN_LIST, PUBLIC_CLOUDFLARE_LIST, PUBLIC_KEEP, PUBLIC_SOURCE_LISTS, publicRefusal, rankPublic, spreadOut } from '../src/main/publicconfigs'
import { DEFAULT_SETTINGS } from '../src/main/store'

const root = join(__dirname, '..')
let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}

const UUID = '11111111-2222-3333-4444-555555555555'
const reality = (host: string) => `vless://${UUID}@${host}:443?security=reality&sni=example.com&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=ab&fp=chrome&type=tcp#ad%20%40channel`
const tls = (host: string, extra = '') => `trojan://secret@${host}:443?security=tls&sni=example.com${extra}#x`

function offline() {
  console.log('Refused links')
  const refusal = (link: string) => publicRefusal(parseLink(link))
  check(!refusal(reality('203.0.113.1')), 'VLESS with Reality is fine')
  check(!refusal(tls('203.0.113.1')), 'Trojan with TLS is fine')
  check(refusal(`vless://${UUID}@203.0.113.1:443?security=none&type=tcp#x`) === 'not encrypted', 'VLESS without TLS is refused: the network could read it')
  check(refusal(`trojan://secret@203.0.113.1:80?security=none#x`) === 'not encrypted', 'Trojan without TLS is refused')
  check(refusal(tls('203.0.113.1', '&allowInsecure=1')) === "doesn't check the server's certificate", "a config that doesn't check the certificate is refused")
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.9', '169.254.1.1', 'localhost', 'router.local', 'example.ir']) check(!!refusal(reality(host)), `${host} is refused`)
  check(isPrivateAddress('100.64.0.1') && !isPrivateAddress('8.8.8.8') && isPrivateAddress('::1') && !isPrivateAddress('2606:4700::1'), 'private addresses are told from public ones')

  console.log('Picking what to test')
  const links = [
    ...Array.from({ length: 30 }, (_, i) => reality(`203.0.113.${i + 1}`)),
    ...Array.from({ length: 30 }, (_, i) => `ss://${Buffer.from('aes-128-gcm:pw').toString('base64')}@198.51.100.${i + 1}:8388#y`),
    reality('203.0.113.1').replace('#ad', '#copy'),
    `vless://${UUID}@127.0.0.1:443?security=none#z`,
    'bridge://warp?m=h2&a=AAAA',
    'not a link://',
    'vless://broken'
  ]
  const picked = choosePublicCandidates(links, new Set(), 20)
  check(picked.length === 20, `stops at the limit (${picked.length})`)
  check(picked.filter((s) => s.protocol === 'vless').length === 16, 'mostly TLS and Reality, but not only')
  check(new Set(picked.map((s) => `${s.server}:${s.port}`)).size === 20, 'one for each address')
  check(picked.every((s) => !s.warp), 'never a WARP link from a list')
  const all = choosePublicCandidates(links, new Set(['203.0.113.2:443']), 1000)
  check(all.length === 59 && !all.some((s) => s.server === '203.0.113.2' || s.server === '127.0.0.1'), `what it holds and what is refused are left out (${all.length})`)
  let calls = 0
  const seeded = () => ((calls = (calls * 9301 + 49297) % 233280), calls / 233280)
  check(choosePublicCandidates(links, new Set(), 5, seeded)[0].server !== choosePublicCandidates(links, new Set(), 5, seeded)[0].server, 'each try looks at different ones')
  const neighbours = Array.from({ length: 10 }, (_, i) => parseLink(reality(`203.0.113.${i + 1}`)))
  const others = Array.from({ length: 4 }, (_, i) => parseLink(tls(`198.51.100.${i * 0 + 1}`).replace('@198.51.100.1', `@192.0.${i + 2}.1`)))
  const spread = spreadOut([...neighbours, ...others], 6)
  check(spread.length === 6 && spread.filter((s) => s.server.startsWith('203.0.113.')).length === 3 && spread.slice(0, 2).every((s) => s.server.startsWith('203.0.113.')), `the best stay first, but neighbours don't fill the list (${spread.filter((s) => s.server.startsWith('203.0.113.')).length} of 6 from one range)`)
  check(spreadOut(neighbours, 6).length === 6, 'with nothing else to take, neighbours fill up')
  const firstUp = choosePublicCandidates(links, new Set(), 10, Math.random, Array.from({ length: 8 }, (_, i) => reality('192.0.2.' + (i + 1))))
  check(firstUp.length === 10 && firstUp.slice(0, 5).every((s) => s.server.startsWith('192.0.2.')) && firstUp.slice(5).every((s) => !s.server.startsWith('192.0.2.')), 'the clean list goes first, but only takes half')
  console.log('Ranking')
  const ranked = rankPublic([{ downMbps: 90, latency: 2500 }, { downMbps: 5, latency: 100 }, { downMbps: 40, latency: 900 }, { latency: 50 }, { downMbps: 40, latency: 300 }])
  check(ranked.map((f) => `${f.downMbps}/${f.latency}`).join() === '40/300,40/900,5/100,undefined/50,90/2500', `speed decides, ties go by ping, a very slow ping goes last (${ranked.map((f) => `${f.downMbps}/${f.latency}`).join(', ')})`)
  check(middleOf([900, 120, 150]) === 150 && middleOf([100, 300]) === 100, 'one odd ping does not count')
  check([PUBLIC_CLEAN_LIST, PUBLIC_CLOUDFLARE_LIST, ...PUBLIC_SOURCE_LISTS].every((urls) => urls.length === 2 && urls[0].startsWith('https://raw.githubusercontent.com/') && urls[1].startsWith('https://cdn.jsdelivr.net/gh/')), 'every list has a second place to download it')
}

async function fallback() {
  console.log('Downloading')
  const asked: string[] = []
  const links = await fetchPublicLinks(
    async (url) => {
      asked.push(url)
      if (url.includes('raw.githubusercontent.com')) throw new Error('blocked')
      return `${reality('203.0.113.1')}\n${reality('203.0.113.2')}`
    },
    () => undefined
  )
  check(asked.filter((u) => u.includes('jsdelivr')).length === PUBLIC_SOURCE_LISTS.length + 2, 'a blocked GitHub falls back to the CDN')
  check(links.links.length === 2 && links.clean.length === 2, 'the same link from several lists counts once, and the clean list is told apart')
  check((await fetchPublicLinks(() => Promise.reject(new Error('blocked')), () => undefined)).links.length === 0, 'nothing reachable gives no links instead of an error')
}

async function live() {
  console.log('Live: the real lists on this network')
  const started = Date.now()
  const { links } = await fetchPublicLinks(
    async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    },
    (t) => console.log(`  ${t}`)
  )
  check(links.length > 500, `the lists give ${links.length} links`)
  const candidates = choosePublicCandidates(links, new Set())
  check(candidates.length > 100, `${candidates.length} candidates after the filters (${candidates.filter((s) => s.engine === 'xray').length} on Xray)`)

  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-public-'))
  const core = new Core({
    singBox: join(root, 'resources/core/sing-box.exe'),
    xray: join(root, 'resources/xray/xray.exe'),
    aether: join(root, 'resources/aether/aether.exe'),
    rulesDir: join(root, 'resources/rules'),
    dataDir
  })
  core.on('log', (l: { text: string }) => /^Public configs/.test(l.text) && console.log(`  ${l.text}`))
  const marks: string[] = []
  const found = await core.findPublicConfigs(candidates, DEFAULT_SETTINGS.testUrl, (step, n) => marks.push(`${step} ${n} at ${Math.round((Date.now() - started) / 1000)} s`))
  const seconds = Math.round((Date.now() - started) / 1000)
  console.log(`  ${marks.join(', ')}; finished at ${seconds} s`)
  console.log(`  kept: ${found.map((f) => `${f.server.protocol} ${f.exit} ${f.latency} ms ${f.downMbps ?? '?'} Mbps`).join(' | ')}`)
  check(found.length > 0, `${found.length} configs carry real HTTPS traffic`)
  check(found.length <= PUBLIC_KEEP, 'keeps no more than the limit')
  check(found.every((f) => f.exit !== 'IR'), 'none leaves in Iran')
  check(found.every((f, i) => !i || (found[i - 1].downMbps ?? 0) >= (f.downMbps ?? 0)), 'fastest first')
  check(seconds < 200, `done in ${seconds} s`)
  await core.stop().catch(() => undefined)
  rmSync(dataDir, { recursive: true, force: true })
}

async function main() {
  offline()
  await fallback()
  if (!process.argv.includes('--offline')) await live()
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
