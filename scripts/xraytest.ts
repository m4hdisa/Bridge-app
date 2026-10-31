// Offline Xray test: converts sample links to Xray outbounds and validates the generated
// configs with `xray run -test`. Nothing is started and the network is not touched.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLink } from '../src/main/parser'
import { buildXrayConfig, linkToXray, xrayWithServerIp } from '../src/main/xray'

const root = join(__dirname, '..')
const xray = join(root, 'resources', 'xray', 'xray.exe')
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811'
const PBK = 'dLN2Ibq5VLAB9qG5RveB10JA-pJctpgW7BT7_cfC6Sw'
const ENC = 'mlkem768x25519plus.native.0rtt.YJLDrbGBuMN0ErnLsYVOsajbPgjmcNK92_kVTGoGyiM'
const vmessXhttp = { v: '2', ps: 'vmess xhttp', add: 'vm.example.com', port: '443', id: UUID, scy: 'auto', net: 'xhttp', host: 'vm.example.com', path: '/x', tls: 'tls', sni: 'vm.example.com' }

const SAMPLES: Record<string, string> = {
  'vless xhttp reality': `vless://${UUID}@de.example.com:7779?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${PBK}&sid=6ba85179&spx=%2F&type=xhttp&path=%2Fxh&mode=auto#VLESS-REALITY-XHTTP`,
  'vless xhttp tls + extra': `vless://${UUID}@cdn.example.com:443?security=tls&sni=cdn.example.com&type=xhttp&path=%2Fx&host=cdn.example.com&mode=packet-up&extra=${encodeURIComponent(JSON.stringify({ xPaddingBytes: '100-1000' }))}#xhttp-cdn`,
  'vless raw + VLESS Encryption': `vless://${UUID}@de.example.com:7777?encryption=${ENC}&type=tcp&security=none#VLESS-TCP`,
  'vmess raw + http header': 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'http-header', add: 'vm.example.com', port: '80', id: UUID, scy: 'auto', net: 'tcp', type: 'http', host: 'a.com', path: '/' })).toString('base64'),
  'vless reality vision fp=unsafe': `vless://${UUID}@de.example.com:7780?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=unsafe&pbk=${PBK}&sid=6ba8&type=tcp#VLESS-REALITY-TCP`,
  'vless ws tls': `vless://${UUID}@cdn.example.com:443?security=tls&type=ws&path=%2Fws&host=cdn.example.com#ws`,
  'vmess xhttp tls': 'vmess://' + Buffer.from(JSON.stringify(vmessXhttp)).toString('base64'),
  'trojan grpc': 'trojan://pw@tr.example.com:443?security=tls&sni=tr.example.com&type=grpc&serviceName=svc#trojan-grpc'
}

let failed = 0
const ok = (m: string) => console.log(`  ok   ${m}`)
const fail = (m: string, e: unknown) => {
  failed++
  console.log(`  FAIL ${m}\n       ${String(e instanceof Error ? e.message : e).split('\n').join('\n       ')}`)
}

const dir = mkdtempSync(join(tmpdir(), 'bridge-xraytest-'))
function check(name: string, config: object) {
  const file = join(dir, name.replace(/\W+/g, '_') + '.json')
  writeFileSync(file, JSON.stringify(config, null, 2))
  try {
    execFileSync(xray, ['run', '-test', '-c', file], { stdio: 'pipe' })
    ok(`xray -test: ${name}`)
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    fail(`xray -test: ${name}`, (err.stdout?.toString() || '') + (err.stderr?.toString() || '') || e)
  }
}

console.log('Engine choice')
for (const [name, link] of Object.entries(SAMPLES)) {
  try {
    const p = parseLink(link)
    const expectXray = /xhttp|Encryption|http header|vmess xhttp/.test(name)
    if ((p.engine === 'xray') === expectXray && p.xray) ok(`${name} -> ${p.engine} (${p.server}:${p.port})`)
    else fail(name, `engine=${p.engine}, xray=${!!p.xray}`)
  } catch (e) {
    fail(name, e)
  }
}

try {
  parseLink(`vless://${UUID}@de.example.com:80?encryption=none&type=tcp&headerType=http&host=a.com#plain`)
  fail('plain VLESS + http header should be rejected', 'no error')
} catch (e) {
  ok(`plain VLESS + http header rejected: "${(e as Error).message}"`)
}

console.log('Xray configs')
const outbounds = Object.entries(SAMPLES).map(([name, link]) => ({ name, outbound: linkToXray(link) }))
for (const { name, outbound } of outbounds) check(name, buildXrayConfig([{ port: 20001, outbound }]))
check('all servers in one test instance', buildXrayConfig(outbounds.map((o, i) => ({ port: 20001 + i, outbound: o.outbound }))))
check('bound to the real adapter (TUN modes)', buildXrayConfig([{ port: 20001, outbound: outbounds[0].outbound }], 'warning', 'Wi-Fi'))
const pinned = xrayWithServerIp(outbounds[1].outbound, '1.2.3.4')
if (pinned.settings.address === '1.2.3.4' && pinned.streamSettings.tlsSettings.serverName === 'cdn.example.com') ok('pinned IP keeps the TLS server name')
else fail('pinning', JSON.stringify(pinned))
check('pinned outbound', buildXrayConfig([{ port: 20001, outbound: pinned }]))

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exitCode = failed ? 1 : 0
