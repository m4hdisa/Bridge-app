// Offline test of moving configs behind Cloudflare's CDN onto a Cloudflare address.
// Usage: tsx scripts/cloudflarecdntest.ts
import { CLOUDFLARE_ADDRESS, cloudflareKey, toCloudflare, withFragment } from '../src/main/cloudflarecdn'
import { parseLink } from '../src/main/parser'
import { choosePublicCandidates, publicKey, publicRefusal } from '../src/main/publicconfigs'

let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}
const UUID = '11111111-2222-3333-4444-555555555555'
const ws = (extra: string, port = 443) => `vless://${UUID}@203.0.113.9:${port}?encryption=none&type=ws&host=cdn.example.com&path=%2Fabc${extra}#ad%20%40channel`

console.log('Converting')
const tls = toCloudflare(ws('&security=tls&sni=other.example.com&alpn=h2&fp=unsafe&allowInsecure=1&fm=x&cs=y&dialMode=oob'))!
const q = new URLSearchParams(tls.split('#')[0].split('?')[1])
check(tls.startsWith(`vless://${UUID}@${CLOUDFLARE_ADDRESS}:443?`), 'it dials the Cloudflare address on 443')
check(q.get('sni') === 'cdn.example.com' && q.get('host') === 'cdn.example.com', 'the server name is the Host, since Cloudflare picks the origin by it')
check(q.get('alpn') === 'http/1.1' && q.get('fp') === 'chrome', 'WebSocket gets HTTP/1.1 and a plain Chrome fingerprint')
check(!['allowInsecure', 'fm', 'cs', 'dialMode'].some((k) => q.has(k)), 'certificate opt-outs and settings for another Xray build are left out')
const plain = toCloudflare(ws('&security=none', 8080))!
check(!!plain && new URLSearchParams(plain.split('?')[1]).get('security') === 'tls' && plain.includes(':443?'), 'a plain one on a Cloudflare HTTP port moves onto TLS')
check(toCloudflare(ws('&security=tls', 2053))!.includes(':443?'), 'the other HTTPS ports lead to 443')
check(!toCloudflare(ws('&security=tls', 8080)) && !toCloudflare(ws('&security=none', 443)), 'TLS on an HTTP port, or none on an HTTPS one, is dropped')
check(!toCloudflare(ws('&security=reality&pbk=AAAA')) && !toCloudflare(`vless://${UUID}@203.0.113.9:443?type=tcp&security=tls#x`) && !toCloudflare(`vless://${UUID}@203.0.113.9:443?type=ws&security=tls#x`), 'Reality, plain TCP and no Host are dropped')
check(!toCloudflare(ws('&security=tls', 9999)) && !toCloudflare('vmess://abc') && !toCloudflare('nonsense'), 'other ports, VMess and junk are dropped')

console.log('Running on the official cores')
const s = parseLink(tls)
check(!publicRefusal(s), "Bridge's safety filters accept it")
const f = parseLink(withFragment(tls))
check(f.engine === 'xray' && (f.xray as any).streamSettings.finalmask.tcp[0].settings.packets === 'tlshello', 'the fragment form runs on Xray, in the shape the official build reads')
check(cloudflareKey(tls) === cloudflareKey(tls.replace('#ad', '#other')), 'the same config under another name counts once')

console.log('Many servers on one address')
const many = Array.from({ length: 5 }, (_, i) => toCloudflare(ws('&security=tls').replace('cdn.example.com', `cdn${i}.example.com`))!)
check(new Set(many.map((l) => publicKey(parseLink(l)))).size === 5, 'servers behind one Cloudflare address are told apart by Host')
check(choosePublicCandidates(many, new Set(), 10).length === 5, 'so picking candidates keeps them all')

console.log(failed ? `\n${failed} failed` : '\nAll passed')
process.exit(failed ? 1 : 0)
