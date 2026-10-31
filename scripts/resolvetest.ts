// Safe test for server address resolution and pinning (only DNS lookups, nothing changes on the system).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withServerIp } from '../src/main/config'
import { parseLink } from '../src/main/parser'
import { isBogusAddress, ServerResolver } from '../src/main/resolve'

let failed = 0
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failed++
}

async function main() {
  console.log('Poisoned / bogus answers')
  for (const ip of ['10.10.34.34', '10.10.34.35', '192.168.1.1', '127.0.0.1', '198.18.0.5', '0.0.0.0']) check(isBogusAddress(ip), `${ip} rejected`)
  for (const ip of ['203.0.113.10', '104.16.0.1', '1.1.1.1']) check(!isBogusAddress(ip), `${ip} accepted`)

  console.log('Resolver')
  const dir = mkdtempSync(join(tmpdir(), 'bridge-resolve-'))
  const logs: string[] = []
  const resolver = new ServerResolver(join(dir, 'cache.json'), (t) => logs.push(t))
  const r = await resolver.resolve('example.com')
  check(!!r && !isBogusAddress(r.ip), `example.com -> ${r?.ip} (${r?.source})`)
  const ipLink = await resolver.resolve('104.16.0.1')
  check(ipLink?.ip === '104.16.0.1', 'IP address in link is used as-is')
  const none = await resolver.resolve('does-not-exist.invalid')
  check(!none, 'unknown host returns nothing (and is logged)')
  // A second resolver reading the same cache file falls back to the last good answer.
  const offline = new ServerResolver(join(dir, 'cache.json'), (t) => logs.push(t))
  const cached = (offline as unknown as { cache: Record<string, string> }).cache['example.com']
  check(cached === r?.ip, 'last good address is saved for later')
  rmSync(dir, { recursive: true, force: true })

  console.log('Pinning keeps SNI / Host')
  const ws = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@cdn.example.com:443?security=tls&type=ws&path=%2Fws#ws')
  const pinnedWs = withServerIp(ws.outbound, '1.2.3.4') as any
  check(pinnedWs.server === '1.2.3.4', 'server replaced by IP')
  check(pinnedWs.tls.server_name === 'cdn.example.com', 'TLS SNI keeps the domain')
  check(pinnedWs.transport.headers.Host === 'cdn.example.com', 'WebSocket Host keeps the domain')
  check((ws.outbound as any).server === 'cdn.example.com', 'original profile is not modified')
  const ss = parseLink('ss://' + Buffer.from('aes-256-gcm:pw').toString('base64url') + '@ss.example.com:8388#ss')
  check((withServerIp(ss.outbound, '5.6.7.8') as any).server === '5.6.7.8', 'Shadowsocks server replaced by IP')

  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  // Let the slower DNS lookups finish instead of exiting under them.
  process.exitCode = failed ? 1 : 0
}

void main()
