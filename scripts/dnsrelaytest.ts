// DNS relay test, safe on a VPS: only loopback ports and DNS-over-HTTPS, no TUN, no system proxy.
// A TCP relay in front of a real resolver stops passing data a few seconds after each connection
// opens, the way the direct network does on the user's PC. sing-box asks through the DNS relay
// exactly as in a real connection, with its traffic bound to the real adapter.
// Usage: tsx scripts/dnsrelaytest.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerAddresses, DnsRelay, type DohServer } from '../src/main/dnsrelay'
import { freePort, networkInfo } from '../src/main/system'

let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A way to a real resolver that goes silent `stallAfterMs` after each connection (0: at once). */
function stallingWay(target: string, stallAfterMs: number): Promise<{ port: number; server: Server; connections: () => number }> {
  let connections = 0
  const server = createServer((c) => {
    connections++
    const up = connect(443, target)
    let dead = stallAfterMs === 0
    if (!dead) setTimeout(() => (dead = true), stallAfterMs)
    c.on('data', (d) => void (dead || up.write(d)))
    up.on('data', (d) => void (dead || c.write(d)))
    for (const s of [c, up]) {
      s.on('error', () => undefined)
      s.on('close', () => (c.destroy(), up.destroy()))
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server, connections: () => connections })))
}

function question(name: string, id = Math.floor(Math.random() * 65535)): Buffer {
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
  return Buffer.concat([Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])])
}

/** Plain DNS over TCP straight to the relay. */
function askRelay(port: number, q: Buffer): Promise<{ ms: number; id: number; rcode: number; ips: string[] }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const s = connect(port, '127.0.0.1')
    let got = Buffer.alloc(0)
    s.on('connect', () => {
      const size = Buffer.alloc(2)
      size.writeUInt16BE(q.length, 0)
      s.write(Buffer.concat([size, q]))
    })
    s.on('data', (d) => {
      got = Buffer.concat([got, d])
      if (got.length >= 2 && got.length >= 2 + got.readUInt16BE(0)) {
        s.destroy()
        resolve({ ms: performance.now() - t0, id: got.readUInt16BE(2), rcode: got[5] & 15, ips: answerAddresses(got.subarray(2)).map((a) => a.ip) })
      }
    })
    s.on('error', reject)
    setTimeout(() => (s.destroy(), reject(new Error('no answer in 15 s'))), 15000)
  })
}

function askUdp(port: number, name: string): Promise<number> {
  return new Promise((resolve) => {
    const s = createSocket('udp4')
    const t0 = performance.now()
    const done = (ms: number) => (s.close(), resolve(ms))
    const timer = setTimeout(() => done(-1), 15000)
    s.on('message', () => (clearTimeout(timer), done(performance.now() - t0)))
    s.send(question(name), port, '127.0.0.1')
  })
}

async function runSingBox(relayPort: number, boundTo: string | undefined): Promise<{ child: ChildProcess; dnsPort: number; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-dnsrelay-'))
  const dnsPort = await freePort()
  const config = {
    log: { level: 'error' },
    dns: { servers: [{ type: 'tcp', tag: 'dns-local', server: '127.0.0.1', server_port: relayPort }], final: 'dns-local', strategy: 'ipv4_only' },
    inbounds: [{ type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: dnsPort, network: 'udp' }],
    route: { rules: [{ inbound: ['dns-in'], action: 'hijack-dns' }], ...(boundTo ? { default_interface: boundTo } : { auto_detect_interface: true }) }
  }
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(config))
  const child = spawn(join(__dirname, '..', 'resources', 'core', 'sing-box.exe'), ['run', '-c', file], { windowsHide: true })
  await sleep(1500)
  return { child, dnsPort, dir }
}

void (async () => {
  const unique = (i: number) => `q${Date.now()}x${i}.cloudflare.com`
  const cloudflare: DohServer = { host: '1.1.1.1' }
  const google: DohServer = { host: '8.8.8.8' }
  const info = await networkInfo()

  console.log('Plain answers')
  const plain = new DnsRelay({ servers: [cloudflare, google] })
  const plainPort = await plain.start()
  const a = await askRelay(plainPort, question('www.example.com', 4242))
  check(a.id === 4242 && a.rcode === 0, `the answer comes back with the asker's ID (${Math.round(a.ms)} ms)`)
  const nx = await askRelay(plainPort, question(unique(0)))
  check(nx.rcode === 3 || nx.rcode === 0, `a name that doesn't exist is an answer, not a failure (rcode ${nx.rcode})`)

  console.log('Windows repeating a question')
  const before = plain.upstreamAsked
  const same = question(unique(1), 1)
  const copies = await Promise.all(Array.from({ length: 10 }, (_, i) => {
    const q = Buffer.from(same)
    q.writeUInt16BE(100 + i, 0)
    return askRelay(plainPort, q)
  }))
  check(copies.every((c, i) => c.id === 100 + i), 'each of 10 identical questions gets its own ID back')
  check(plain.upstreamAsked - before <= 1 + 1, `they went out as one (asked ${plain.upstreamAsked - before} time(s), one hedge allowed)`)

  console.log('Addresses that time out on the direct network')
  const multi = 'www.cloudflare.com'
  const before2 = await askRelay(plainPort, question(multi))
  check(before2.ips.length >= 2, `a name with several addresses: ${before2.ips.length}`)
  const cname = await askRelay(plainPort, question('www.github.com'))
  check(cname.ips.length >= 1, `addresses are read after a CNAME too: ${cname.ips.length}`)
  check(!plain.markUnreachable('203.0.113.77'), 'an address DNS never gave out does not clear the caches')
  check(plain.markUnreachable(before2.ips[0]), 'one DNS gave out does')
  const after = await askRelay(plainPort, question(multi))
  check(after.ips.length > 0 && !after.ips.includes(before2.ips[0]), `the next answer no longer offers it (${after.ips.length} addresses left in the answer)`)
  const single = (await askRelay(plainPort, question('one.one.one.one'))).ips
  for (const ip of single) plain.markUnreachable(ip)
  const onlyBad = await askRelay(plainPort, question('one.one.one.one'))
  check(onlyBad.rcode === 0 && onlyBad.ips.length > 0 && onlyBad.ms < 1500, `with nothing better the name still gets an answer, in ${Math.round(onlyBad.ms)} ms`)
  plain.stop()

  console.log('Lookups leave from the real adapter')
  const address = networkInterfaces()[info.interfaceAlias ?? '']?.find((i) => i.family === 'IPv4')?.address
  const bound = new DnsRelay({ servers: [cloudflare], localAddress: address })
  const bo = await askRelay(await bound.start(), question(unique(2)))
  check(bo.rcode === 0 || bo.rcode === 3, `answered from the adapter's address in ${Math.round(bo.ms)} ms (rcode ${bo.rcode}${bound.lastError ? `, ${bound.lastError}` : ''})`)
  bound.stop()
  const wrong = new DnsRelay({ servers: [cloudflare], localAddress: '203.0.113.9' })
  const wr = await askRelay(await wrong.start(), question(unique(3)))
  check(wr.rcode === 2, 'an address this PC does not have fails, so the setting really is used')
  wrong.stop()

  console.log('The first server goes silent every 3 s, as in the logs, 45 s through sing-box')
  const way = await stallingWay('1.1.1.1', 3000)
  const stalling = new DnsRelay({ servers: [{ host: '127.0.0.1', port: way.port, servername: 'cloudflare-dns.com' }, google, { host: '9.9.9.9' }] })
  const stallingPort = await stalling.start()
  const adapter = info.interfaceAlias
  const box = await runSingBox(stallingPort, adapter)
  console.log(`  sing-box bound to ${adapter}`)
  const pending: Promise<number>[] = []
  for (let i = 0; i < 45; i++) {
    pending.push(askUdp(box.dnsPort, unique(100 + i)))
    await sleep(1000)
  }
  const times = (await Promise.all(pending)).map(Math.round)
  const answered = times.filter((m) => m >= 0).sort((x, y) => x - y)
  console.log(`  times: ${times.join(' ')}`)
  check(answered.length === times.length, `all answered: ${answered.length} of ${times.length} (sing-box alone: 13 of 45)`)
  check(answered[answered.length - 1] < 1500, `slowest ${answered[answered.length - 1]} ms, median ${answered[answered.length >> 1]} ms (sing-box alone: over 10 s)`)
  box.child.kill()
  await sleep(300)
  rmSync(box.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  stalling.stop()
  way.server.close()

  console.log('Every direct server silent, the VPN still works')
  const [dead1, dead2] = await Promise.all([stallingWay('1.1.1.1', 0), stallingWay('8.8.8.8', 0)])
  const socksPort = await freePort()
  const socksDir = mkdtempSync(join(tmpdir(), 'bridge-dnsrelay-'))
  const socksFile = join(socksDir, 'config.json')
  writeFileSync(socksFile, JSON.stringify({ log: { level: 'error' }, inbounds: [{ type: 'socks', listen: '127.0.0.1', listen_port: socksPort }], outbounds: [{ type: 'direct', tag: 'direct' }] }))
  const socks = spawn(join(__dirname, '..', 'resources', 'core', 'sing-box.exe'), ['run', '-c', socksFile], { windowsHide: true })
  await sleep(1500)
  const logs: string[] = []
  const vpnOnly = new DnsRelay({ servers: [{ host: '127.0.0.1', port: dead1.port, servername: 'cloudflare-dns.com' }, { host: '127.0.0.1', port: dead2.port, servername: 'dns.google' }], proxyPort: () => socksPort, vpnServer: cloudflare, log: (t) => logs.push(t) })
  const vpnPort = await vpnOnly.start()
  const v = await askRelay(vpnPort, question(unique(200)))
  check(v.rcode === 0 || v.rcode === 3, `answered through the VPN in ${Math.round(v.ms)} ms (rcode ${v.rcode}${vpnOnly.lastError ? `, ${vpnOnly.lastError}` : ''})`)
  const v2 = await askRelay(vpnPort, question(unique(201)))
  check(v2.ms < v.ms + 500, `the next one, on the open connection: ${Math.round(v2.ms)} ms`)
  await sleep(2600)
  const v3 = await askRelay(vpnPort, question(unique(202)))
  check(v3.ms < 500, `once the direct servers are known to be silent it goes straight through the VPN: ${Math.round(v3.ms)} ms`)
  vpnOnly.stop()

  console.log('Nothing answers at all')
  const none = new DnsRelay({ servers: [{ host: '127.0.0.1', port: dead1.port, servername: 'cloudflare-dns.com' }, { host: '127.0.0.1', port: dead2.port, servername: 'dns.google' }] })
  const nonePort = await none.start()
  const n = await askRelay(nonePort, question(unique(300), 7))
  check(n.rcode === 2 && n.id === 7, `it says so after ${Math.round(n.ms)} ms instead of hanging (server failure)`)
  check(n.ms < 7000, 'within 7 s')
  none.stop()
  socks.kill()
  dead1.server.close()
  dead2.server.close()
  await sleep(300)
  rmSync(socksDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})()
