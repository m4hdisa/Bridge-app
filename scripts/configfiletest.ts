// Offline test of importing whole config files and panel addresses instead of share links.
// Usage: tsx scripts/configfiletest.ts
import { linksFromConfigFile, noLinksReason } from '../src/main/configfile'
import { extractLinks, parseLink } from '../src/main/parser'
import { fetchSubscription, panelSubscriptions, SubscriptionAnswer, type Fetcher } from '../src/main/subscription'

let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}

const UUID = '11111111-2222-3333-4444-555555555555'
const ws = { network: 'ws', wsSettings: { host: 'cdn.example.com', path: '/abc?ed=2560' }, security: 'tls', tlsSettings: { serverName: 'cdn.example.com', fingerprint: 'chrome', alpn: ['http/1.1'] } }
const vless = (address: string, extra = {}) => ({ protocol: 'vless', settings: { vnext: [{ address, port: 443, users: [{ id: UUID, encryption: 'none' }] }] }, streamSettings: { ...ws, ...extra }, tag: 'proxy' })
const trojan = { protocol: 'trojan', settings: { servers: [{ address: '203.0.113.2', port: 443, password: 'pw' }] }, streamSettings: ws, tag: 'proxy' }
const others = [{ protocol: 'dns', tag: 'dns-out' }, { protocol: 'freedom', settings: {}, tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }]
const mask = { tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '100-200', delay: '1' } }] }

console.log('Xray config files')
const one = parseLink(linksFromConfigFile(JSON.stringify([{ remarks: 'First', outbounds: [vless('203.0.113.1'), ...others] }]))[0])
const o = one.outbound as any
check(one.name === 'First' && one.protocol === 'vless' && one.server === '203.0.113.1' && one.engine === 'sing-box', 'a VLESS server comes out under the config name')
check(o.transport?.type === 'ws' && o.transport?.headers?.Host === 'cdn.example.com' && o.transport?.path === '/abc' && o.transport?.max_early_data === 2560, 'WebSocket settings and early data survive')
check(o.tls?.server_name === 'cdn.example.com' && o.tls?.alpn?.[0] === 'http/1.1' && o.tls?.utls?.fingerprint === 'chrome', 'TLS settings survive')
check(linksFromConfigFile(JSON.stringify([{ remarks: 'T', outbounds: [trojan] }]))[0].startsWith('trojan://pw@203.0.113.2:443'), 'Trojan')
const best = [{ remarks: 'A', outbounds: [vless('203.0.113.1')] }, { remarks: 'B', outbounds: [vless('203.0.113.3')] }, { remarks: 'Best Ping', outbounds: [vless('203.0.113.1'), vless('203.0.113.3')] }]
check(linksFromConfigFile(JSON.stringify(best)).length === 2, 'a Best Ping config adds no copies')
const fragmented = parseLink(linksFromConfigFile(JSON.stringify([{ remarks: 'F', outbounds: [vless('203.0.113.1', { finalmask: mask }), ...others] }]))[0])
check(fragmented.engine === 'xray' && JSON.stringify((fragmented.xray as any).streamSettings.finalmask) === JSON.stringify(mask), 'fragment settings survive, and such a config runs on Xray')
const dialer = { protocol: 'freedom', tag: 'frag', settings: { fragment: { packets: 'tlshello', length: '10-20', interval: '1-2' } } }
const viaDialer = parseLink(linksFromConfigFile(JSON.stringify({ outbounds: [vless('203.0.113.1', { sockopt: { dialerProxy: 'frag' } }), dialer] }))[0])
check((viaDialer.xray as any).streamSettings.finalmask?.tcp?.[0]?.settings?.length === '10-20', 'the older way of fragmenting, through a second outbound, is read too')
check(linksFromConfigFile(JSON.stringify({ outbounds: [vless('203.0.113.1', { sockopt: { dialerProxy: 'chain' } }), { ...trojan, tag: 'chain' }] })).length === 1, 'a chain through another server is left out, not imported broken')

console.log('sing-box and Clash config files')
const singBox = { outbounds: [{ tag: 'S', type: 'vless', server: '203.0.113.4', server_port: 443, uuid: UUID, tls: { enabled: true, server_name: 'cdn.example.com', alpn: ['http/1.1'], utls: { enabled: true, fingerprint: 'chrome' } }, transport: { type: 'ws', path: '/abc', max_early_data: 2560, early_data_header_name: 'Sec-WebSocket-Protocol', headers: { Host: 'cdn.example.com' } } }, { type: 'selector', tag: 'x', outbounds: ['S'] }, { type: 'direct', tag: 'direct' }] }
const fromSb = parseLink(linksFromConfigFile(JSON.stringify(singBox))[0])
check(fromSb.name === 'S' && (fromSb.outbound as any).transport?.max_early_data === 2560, 'sing-box, ignoring selector and direct')
const clash = { proxies: [{ name: 'C', type: 'trojan', server: '203.0.113.5', port: 443, password: 'pw', sni: 'cdn.example.com', network: 'ws', 'ws-opts': { path: '/abc', headers: { Host: 'cdn.example.com' } } }, { name: 'C2', type: 'ss', server: '203.0.113.6', port: 8388, cipher: 'aes-128-gcm', password: 'pw' }] }
const fromClash = linksFromConfigFile(JSON.stringify(clash)).map(parseLink)
check(fromClash.length === 2 && !!(fromClash[0].outbound as any).tls?.enabled && fromClash[1].protocol === 'shadowsocks', 'Clash, with Trojan on TLS even when the file leaves it out')

console.log('Through the normal import path')
const file = JSON.stringify([{ remarks: 'First', outbounds: [vless('203.0.113.1')] }])
check(extractLinks(file).length === 1, 'pasted JSON')
check(extractLinks(Buffer.from(file).toString('base64')).length === 1, 'base64 JSON')
check(extractLinks(`vless://${UUID}@203.0.113.1:443?security=tls#x`).length === 1, 'plain links as before')
check(linksFromConfigFile('{broken').length === 0 && linksFromConfigFile('{"a":1}').length === 0, "something else isn't an error")
check(linksFromConfigFile(JSON.stringify([{ outbounds: [{ protocol: 'wireguard', settings: {} }] }])).length === 0, 'WireGuard is skipped')

console.log('Panel addresses')
const panel = 'https://x.example.com/secret/panel'
check(panelSubscriptions(panel).join() === 'https://x.example.com/secret/sub/raw?app=xray,https://x.example.com/secret/sub/fragment?app=xray', "a panel's own address leads to its plain and fragment subscriptions")
check(panelSubscriptions('https://x.example.com/secret/login').length === 2, 'its login page too')
check(panelSubscriptions('https://x.example.com/secret/sub/normal').join() === 'https://x.example.com/secret/sub/normal?app=xray', 'a link that lost its ?app= gets it back')
check(!panelSubscriptions('https://x.example.com/secret/sub/normal?app=xray').length, 'a complete link is left alone')
check(!panelSubscriptions('https://x.example.com/sub/abcdef').length && !panelSubscriptions('https://x.example.com/').length, "other panels' links are left alone")
check(/web page/.test(noLinksReason('<!DOCTYPE html><html>')) && /WireGuard/.test(noLinksReason('[{"protocol":"wireguard"}]')) && /no share links/.test(noLinksReason('hello')), 'the error says what was wrong')

async function routes() {
  console.log('Downloading by another route')
  const raw = Buffer.from(`vless://${UUID}@203.0.113.1:443?security=tls#x`).toString('base64')
  const asked: string[] = []
  const panelSite: Fetcher = async (url) => {
    asked.push(url)
    return url.includes('/sub/') ? new Response(raw) : new Response('<!DOCTYPE html><html></html>')
  }
  const found = await fetchSubscription(panel, panelSite)
  check(found.links.length === 1 && asked.length === 3, 'a given route is used for the panel and for both its subscriptions')
  const silent: Fetcher = () => Promise.reject(new Error('timed out'))
  const noAnswer = await fetchSubscription(panel, silent).catch((e) => e)
  check(!(noAnswer instanceof SubscriptionAnswer), 'no answer at all is told apart, so another route gets tried')
  const refused = await fetchSubscription('https://x.example.com/feed', async () => new Response('', { status: 403 })).catch((e) => e)
  check(refused instanceof SubscriptionAnswer && refused.message === 'HTTP 403', 'a refusal from the server is final')
  const empty = await fetchSubscription('https://x.example.com/feed', async () => new Response('hello')).catch((e) => e)
  check(empty instanceof SubscriptionAnswer, 'an answer with no configs is final')
}

void routes().then(() => {
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})
