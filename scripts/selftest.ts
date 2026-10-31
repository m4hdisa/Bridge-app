// Offline self-test: parses sample links, builds configs for every mode and
// validates them with `sing-box check`. Does NOT start a VPN or touch the network.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractLinks, parseLink } from '../src/main/parser'
import { buildConfig, buildTestConfig } from '../src/main/config'
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
  bypassIran: true,
  mixedPort: 2080,
  remoteDns: 'https://1.1.1.1/dns-query',
  testUrl: 'https://www.gstatic.com/generate_204',
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
try {
  parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@x.com:443?type=xhttp&security=tls')
  fail('xhttp should be rejected', 'no error thrown')
} catch {
  ok('xhttp rejected with a clear error')
}

console.log('Config (every server, tun mode)')
for (const p of profiles) {
  check(`server ${p.name}`, buildConfig({ server: p, settings, appRules, clashApi: { port: 19090, secret: 'x' }, rulesDir, appRulesDir: join(dir, 'app-rules') }))
}

console.log('Config (every mode)')
for (const mode of ['system-proxy', 'tun', 'per-app'] as ConnectionMode[]) {
  for (const bypassIran of [true, false]) {
    check(
      `mode ${mode} bypassIran=${bypassIran}`,
      buildConfig({ server: profiles[0], settings: { ...settings, mode, bypassIran }, appRules, clashApi: { port: 19090, secret: 'x' }, rulesDir, appRulesDir: join(dir, 'app-rules'), cacheFile: join(dir, 'cache.db') })
    )
  }
}
check('DoH by hostname', buildConfig({ server: profiles[0], settings: { ...settings, remoteDns: 'https://dns.google/dns-query' }, appRules: [], clashApi: { port: 19090, secret: 'x' }, appRulesDir: join(dir, 'app-rules') }))
check('latency test config', buildTestConfig(profiles, { port: 19091, secret: 'x' }))

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exit(failed ? 1 : 0)
