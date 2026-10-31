// Safe FakeIP test (no TUN, nothing changes on the system).
// With a VPN server that is DOWN, checks that:
//  1. DNS still answers instantly (with a fake IP), instead of waiting on the server
//  2. a Direct app connecting to that fake IP really reaches the internet
//  3. a VPN app connecting to that fake IP sends the *domain* to the VPN server
// DNS is queried through an extra local UDP inbound that stands in for TUN's DNS hijack.
import { spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfig, writeAppRuleSets } from '../src/main/config'
import { parseLink } from '../src/main/parser'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { networkInfo } from '../src/main/system'
import { isBogusAddress, pickDirectDns } from '../src/main/resolve'
import type { AppAction, AppRule } from '../src/shared/types'

const root = join(__dirname, '..')
const singBox = join(root, 'resources', 'core', 'sing-box.exe')
// Nothing listens on 127.0.0.1:9, so this "VPN server" is down.
const deadServer = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.1:9?security=none&type=tcp#Dead')
const self = process.execPath
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rule = (action: AppAction): AppRule[] => [{ id: '1', name: 'node.exe', path: self, action, enabled: true }]

function dnsQuery(port: number, name: string): Promise<{ ip?: string; ms: number }> {
  const start = Date.now()
  const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const qname = Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])])
  const packet = Buffer.concat([header, qname, Buffer.from([0x00, 0x01, 0x00, 0x01])]) // A, IN
  return new Promise((resolve) => {
    const sock = createSocket('udp4')
    const timer = setTimeout(() => {
      sock.close()
      resolve({ ms: Date.now() - start })
    }, 5000)
    sock.on('message', (msg) => {
      clearTimeout(timer)
      sock.close()
      // The first A record's 4 bytes are the last 4 bytes of a single-answer response.
      const ancount = msg.readUInt16BE(6)
      resolve({ ip: ancount ? [...msg.subarray(msg.length - 4)].join('.') : undefined, ms: Date.now() - start })
    })
    sock.send(packet, port, '127.0.0.1')
  })
}

function httpVia(proxyPort: number, ip: string): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: `http://${ip}/`, headers: { Host: 'example.com' }, timeout: 8000 }, (res) => {
      res.resume()
      resolve(res.statusCode || 0)
    })
    req.on('error', () => resolve(-1))
    req.on('timeout', () => req.destroy())
    req.end()
  })
}

let failed = 0
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failed++
}

async function run(dnsMode: 'real' | 'fakeip', localDns: Awaited<ReturnType<typeof pickDirectDns>>) {
  console.log(`DNS mode: ${dnsMode}`)
  const dir = mkdtempSync(join(tmpdir(), 'bridge-fakeip-'))
  const appRulesDir = join(dir, 'app-rules')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const dnsPort = port + 2
  const config = buildConfig({
    server: deadServer,
    settings: { ...DEFAULT_SETTINGS, mode: 'per-app', mixedPort: port, logLevel: 'debug', dnsMode },
    appRules: rule('direct'),
    clashApi: { port: port + 1, secret: 'x' },
    appRulesDir,
    localDns
  }) as { inbounds: Record<string, unknown>[]; route: { rules: Record<string, unknown>[] } }
  // Replace TUN with a plain local UDP DNS inbound that is hijacked the same way.
  config.inbounds = config.inbounds.filter((i) => i.type !== 'tun')
  config.inbounds.push({ type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: dnsPort, network: 'udp' })
  config.route.rules.splice(1, 0, { inbound: ['dns-in'], action: 'hijack-dns' })
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(config, null, 2))

  let out = ''
  const child = spawn(singBox, ['run', '-c', file, '-D', dir], { windowsHide: true })
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  await sleep(1500)
  const failedBefore = failed

  const q = await dnsQuery(dnsPort, 'example.com')
  if (dnsMode === 'fakeip') {
    check(!!q.ip && q.ip.startsWith('198.18.') && q.ms < 1000, `DNS answers instantly with a fake IP while the server is down (${q.ip}, ${q.ms} ms)`)
  } else {
    check(!!q.ip && !isBogusAddress(q.ip) && q.ms < 3000, `DNS answers with a real IP while the server is down (${q.ip}, ${q.ms} ms)`)
  }

  if (q.ip) {
    const from = out.length
    const code = await httpVia(port, q.ip)
    check(code >= 200 && code < 500, `Direct app reaches the real internet (HTTP ${code})`)
    const chunk = out.slice(from).replace(/\x1b\[[0-9;]*m/g, '')
    if (dnsMode === 'fakeip') check(/outbound\/direct\[direct\]: outbound connection to example\.com/.test(chunk), 'fake IP was turned back into the domain for the direct connection')
    else check(chunk.includes(`outbound/direct[direct]: outbound connection to ${q.ip}`), 'direct connection goes straight to the real IP')

    writeAppRuleSets(appRulesDir, rule('proxy'))
    await sleep(1500)
    const from2 = out.length
    await httpVia(port, q.ip)
    await sleep(500)
    const chunk2 = out.slice(from2).replace(/\x1b\[[0-9;]*m/g, '')
    check(/outbound\/vless\[proxy\]: outbound connection to /.test(chunk2), 'VPN app is sent through the VPN server')
  }

  await new Promise<void>((r) => {
    child.once('exit', () => r())
    child.kill()
  })
  if (failed > failedBefore) console.log(out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /dns|router|outbound|ERROR|FATAL/.test(l)).slice(-25).join('\n'))
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function main() {
  const localDns = await pickDirectDns((await networkInfo()).dnsServers, (t) => console.log('  [dns] ' + t))
  console.log(`direct DNS: ${localDns ? `${localDns.type} ${localDns.server}` : '(none found, using sing-box local)'}`)
  await run('real', localDns)
  await run('fakeip', localDns)
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
