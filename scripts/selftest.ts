// Offline self-test: parses sample links, builds configs for every mode and
// validates them with `sing-box check`. Does NOT start a VPN or touch the network.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeLink, extractLinks, parseLink } from '../src/main/parser'
import { buildConfig, buildTestConfig } from '../src/main/config'
import { usageFromNames } from '../src/main/subscription'
import { isNewer } from '../src/shared/version'
import type { AppRule, ConnectionMode, Settings } from '../src/shared/types'

const root = join(__dirname, '..')
const singBox = join(root, 'resources', 'core', 'sing-box.exe')
const rulesDir = join(root, 'resources', 'rules')

const vmessJson = {
  v: '2', ps: 'vmess ws tls', add: 'vm.example.com', port: '443', id: 'b831381d-6324-4d53-ad4f-8cda48b30811',
  aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ws?ed=2048', tls: 'tls', sni: 'cdn.example.com', fp: 'chrome'
}

const SAMPLES: Record<string, string> = {
  'vless reality vision':
    'vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0&sid=6ba85179e30d4fc2&type=tcp#Reality%20DE',
  'vless ws tls':
    'vless://b831381d-6324-4d53-ad4f-8cda48b30811@example.com:443?encryption=none&security=tls&sni=example.com&type=ws&host=example.com&path=%2Fvless#WS',
  'vless grpc':
    'vless://b831381d-6324-4d53-ad4f-8cda48b30811@example.com:443?security=tls&type=grpc&serviceName=grpcsvc#gRPC',
  'vmess ws tls': 'vmess://' + Buffer.from(JSON.stringify(vmessJson)).toString('base64'),
  'trojan': 'trojan://p%40ssword@tr.example.com:443?sni=tr.example.com&type=tcp#Trojan',
  'ss sip002': 'ss://' + Buffer.from('chacha20-ietf-poly1305:secret').toString('base64url') + '@5.6.7.8:8388#SS',
  'ss 2022 plain': 'ss://2022-blake3-aes-128-gcm:YWJjZGVmZ2hpamtsbW5vcA%3D%3D@5.6.7.8:8389#SS2022',
  'ss legacy': 'ss://' + Buffer.from('aes-256-gcm:pass@9.9.9.9:1234').toString('base64') + '#Legacy',
  'hysteria2': 'hysteria2://authpass@hy.example.com:8443?sni=hy.example.com&obfs=salamander&obfs-password=obfspw&insecure=1#HY2',
  'tuic': 'tuic://b831381d-6324-4d53-ad4f-8cda48b30811:pw@tuic.example.com:443?congestion_control=bbr&alpn=h3&udp_relay_mode=native#TUIC'
}

const settings: Settings = {
  mode: 'tun',
  autoPing: false,
  autoServer: false,
  bypassIran: true,
  mixedPort: 2080,
  testUrl: 'https://www.gstatic.com/generate_204',
  strictRoute: false,
  dnsMode: 'real',
  logLevel: 'info'
}

const appRules: AppRule[] = [
  { id: '1', name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', action: 'proxy', enabled: true },
  { id: '2', name: 'Telegram.exe', path: 'C:\\Users\\me\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe', action: 'proxy', enabled: true },
  { id: '3', name: 'steam.exe', path: 'C:\\Program Files (x86)\\Steam\\steam.exe', action: 'direct', enabled: true },
  { id: '4', name: 'bad.exe', path: 'C:\\bad\\bad.exe', action: 'block', enabled: true }
]

let failed = 0
const ok = (msg: string) => console.log(`  ok   ${msg}`)
const fail = (msg: string, err: unknown) => {
  failed++
  console.log(`  FAIL ${msg}\n       ${String(err instanceof Error ? err.message : err).split('\n').join('\n       ')}`)
}

const dir = mkdtempSync(join(tmpdir(), 'bridge-selftest-'))
function check(name: string, config: object) {
  const file = join(dir, name.replace(/\W+/g, '_') + '.json')
  writeFileSync(file, JSON.stringify(config, null, 2))
  try {
    execFileSync(singBox, ['check', '-c', file], { stdio: 'pipe' })
    ok(`sing-box check: ${name}`)
  } catch (e) {
    const err = e as { stderr?: Buffer }
    fail(`sing-box check: ${name}`, err.stderr?.toString() || e)
  }
}

console.log('Parser')
const profiles = []
for (const [name, link] of Object.entries(SAMPLES)) {
  try {
    const p = parseLink(link)
    profiles.push(p)
    ok(`${name} -> ${p.protocol} ${p.server}:${p.port} "${p.name}"`)
  } catch (e) {
    fail(name, e)
  }
}
const sub = Buffer.from(Object.values(SAMPLES).join('\n')).toString('base64')
const extracted = extractLinks(sub)
if (extracted.length === Object.keys(SAMPLES).length) ok(`base64 subscription -> ${extracted.length} links`)
else fail('base64 subscription', `expected ${Object.keys(SAMPLES).length}, got ${extracted.length}`)
{
  const p = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:443?security=tls&sni=x.com&fp=unsafe&type=tcp#fp')
  const fp = (p.outbound.tls as { utls?: { fingerprint?: string } }).utls?.fingerprint
  if (fp === 'chrome') ok('unknown uTLS fingerprint "unsafe" -> chrome')
  else fail('unknown uTLS fingerprint', `got ${fp}`)
  // A server saved by an older version still has "unsafe": the config builder must fix it too.
  const stale = { ...p, outbound: { ...p.outbound, tls: { enabled: true, server_name: 'x.com', utls: { enabled: true, fingerprint: 'unsafe' } } } }
  check('stale server with fp=unsafe', buildConfig({ server: stale, settings, appRules: [], clashApi: { port: 19090, secret: 'x' }, appRulesDir: join(dir, 'app-rules') }))
}
// Configs sing-box can't run are handed to the Xray core instead of being rejected.
for (const [label, link] of [
  ['VLESS Encryption -> Xray core', 'vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:443?encryption=mlkem768x25519plus.native.0rtt.abc&type=tcp'],
  ['xhttp -> Xray core', 'vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:443?type=xhttp&security=tls']
]) {
  try {
    const p = parseLink(link)
    if (p.engine === 'xray' && p.xrayOnly && p.xray) ok(label)
    else fail(label, `engine=${p.engine}`)
  } catch (e) {
    fail(label, e)
  }
}
try {
  parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:80?encryption=none&type=tcp&headerType=http&host=a.com')
  fail('plain VLESS + http header should be rejected by both cores', 'no error thrown')
} catch (e) {
  if (/not supported/.test(String(e))) ok(`plain VLESS + http header rejected by both cores with a clear error`)
  else fail('plain VLESS + http header', e)
}
{
  const d = describeLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:7779?type=xhttp&security=reality#VLESS-REALITY-XHTTP')
  if (d.name === 'VLESS-REALITY-XHTTP' && d.kind === 'vless / xhttp / reality') ok(`unsupported link still described: ${d.name} (${d.kind})`)
  else fail('describeLink', JSON.stringify(d))
}
try {
  parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:443?type=quic&security=tls')
  fail('transport neither core supports should be rejected', 'no error thrown')
} catch {
  ok('transport neither core supports (quic) rejected with a clear error')
}

console.log('Config (every server, tun mode)')
for (const p of profiles) {
  check(`server ${p.name}`, buildConfig({ server: p, settings, appRules, clashApi: { port: 19090, secret: 'x' }, rulesDir, appRulesDir: join(dir, 'app-rules') }))
}

console.log('Config (every mode)')
for (const mode of ['system-proxy', 'tun', 'per-app', 'proxy-only'] as ConnectionMode[]) {
  for (const bypassIran of [true, false]) {
    check(
      `mode ${mode} bypassIran=${bypassIran}`,
      buildConfig({ server: profiles[0], settings: { ...settings, mode, bypassIran }, appRules, clashApi: { port: 19090, secret: 'x' }, rulesDir, appRulesDir: join(dir, 'app-rules'), cacheFile: join(dir, 'cache.db') })
    )
  }
}
check('Other VPN apps bound to another adapter', buildConfig({ server: profiles[0], settings: { ...settings, mode: 'per-app' }, appRules: [{ id: 'd', name: 'Discord.exe', path: 'C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0\\Discord.exe', action: 'other', enabled: true }], clashApi: { port: 19090, secret: 'x' }, appRulesDir: join(dir, 'app-rules'), otherInterface: 'Ezconnect Virtual Adapter', defaultInterface: 'Wi-Fi' }))
check('VPN-only probe port (per-app)', buildConfig({ server: profiles[0], settings: { ...settings, mode: 'per-app' }, appRules: [], clashApi: { port: 19090, secret: 'x' }, appRulesDir: join(dir, 'app-rules'), probePort: 19095 }))
check('FakeIP DNS mode', buildConfig({ server: profiles[0], settings: { ...settings, dnsMode: 'fakeip' }, appRules: [], clashApi: { port: 19090, secret: 'x' }, appRulesDir: join(dir, 'app-rules') }))
check('explicit local DNS server', buildConfig({ server: profiles[0], settings, appRules: [], clashApi: { port: 19090, secret: 'x' }, appRulesDir: join(dir, 'app-rules'), localDns: { type: 'https', server: '1.1.1.1' }, defaultInterface: 'Wi-Fi', bypassProcesses: ['C:\\Program Files\\Bridge\\resources\\xray\\xray.exe'] }))
check('latency test config', buildTestConfig(profiles, { port: 19091, secret: 'x' }))

console.log('\nUsage written in config names (no subscription-userinfo header)')
const GB = 1024 ** 3
const nameCases: [string, string[], number | undefined, number | undefined][] = [
  ['English GB Left / Days', ['vless://x@h:1?a=b#16423-%F0%9F%93%8A173.83GB%20Left-%F0%9F%95%90expiredAt%2026Days', 'vless://x@h:1#VLESS-TCP'], 173.83, 26],
  ['Remaining: 50 GB', ['trojan://x@h:1#Remaining%3A%2050%20GB'], 50, undefined],
  ['Persian', ['vless://x@h:1#' + encodeURIComponent('۱۲ روز باقیمانده - ۳۰ گیگ باقیمانده')], 30, 12],
  ['plain names give nothing', ['vless://x@h:1#Germany', 'ss://abc#SS'], undefined, undefined]
]
for (const [label, links, gb, days] of nameCases) {
  const u = usageFromNames(links)
  const gotGb = u?.remaining !== undefined ? Math.round((u.remaining / GB) * 100) / 100 : undefined
  const gotDays = u?.expire ? Math.ceil((u.expire * 1000 - Date.now()) / 86400000) : undefined
  if (gotGb === gb && gotDays === days) ok(label)
  else fail(label, `got ${gotGb} GB / ${gotDays} days`)
}

console.log('\nUpdate version comparison')
const versionCases: [string, string, boolean][] = [
  ['0.3.4', '0.3.3', true],
  ['v0.4.0', '0.3.10', true],
  ['0.3.10', '0.3.9', true],
  ['1.0.0', '0.99.99', true],
  ['0.3.3', '0.3.3', false],
  ['0.3.2', '0.3.3', false],
  ['v0.3.3', '0.3.3', false]
]
for (const [a, b, want] of versionCases) {
  if (isNewer(a, b) === want) ok(`${a} ${want ? '>' : 'not >'} ${b}`)
  else fail(`${a} vs ${b}`, `expected ${want}`)
}

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exit(failed ? 1 : 0)
