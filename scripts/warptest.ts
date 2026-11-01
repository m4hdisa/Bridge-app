// Free WARP test. Offline part: the Aether command lines and log parsing. Live part (safe on a
// VPS): starts Bridge's core in proxy-only mode (no TUN, no system proxy) with the WARP
// server, sends real HTTPS and UDP traffic through the local proxy, checks cancelling a
// start, reconnecting with the saved WARP account and creating the account through one of
// the user's own servers, then stops. Needs internet access.
// Usage: tsx scripts/warptest.ts [--offline]
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { parseLink } from '../src/main/parser'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { GOOL_RETRY_MS, isWarpConfig, newWarpConfig, newWarpServer, parseWarpLine, WARP_IDENTITY_FILE, WARP_REGISTER_TRIES, WARP_STATE_FILE, waitForGool, warpArgs, warpExitCountry, warpGateway, warpMethods, warpReady } from '../src/main/warp'

const root = join(__dirname, '..')
let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}

function offline() {
  console.log('Command lines and logs')
  check(warpMethods({ method: 'auto' }).join(',') === 'gool,h3,h2,h2-fragment,h2-ipv6', `auto races ${warpMethods({ method: 'auto' }).join(', ')}`)
  check(warpMethods({ method: 'wireguard' }).join(',') === 'wireguard', 'a chosen method runs alone')
  const args = warpArgs('h2-ipv6', 1234, 'C:\\data\\aether.toml')
  check(args.includes('--h2') && args.includes('-6') && args.join(' ').includes('--bind 127.0.0.1:1234'), `h2-ipv6 args: ${args.join(' ')}`)
  check(!args.includes('--exit-loc'), 'plain methods accept any exit')
  const gool = warpArgs('gool', 1234, 'C:\\data\\aether.toml').join(' ')
  check(gool.includes('--gool --h2') && gool.includes('--exit-loc !IR'), `gool refuses Iranian exits: ${gool}`)
  check(warpExitCountry('[+] masque exit: 104.28.214.161, IR via FRA, 316ms to cloudflare, warp on') === 'IR', 'exit country read from the log')
  check(!warpReady('[+] socks5 server listening on 127.0.0.1:52859', 21819), "gool's internal port is not taken for the real one")
  const line = parseWarpLine('[2026-11-01T13:44:28.292Z INFO  aether::socks] [+] socks5 server listening on 127.0.0.1:21819')
  check(line.level === 'info' && line.text.startsWith('[+] socks5') && warpReady(line.text, 21819), 'ready line parsed')
  check(parseWarpLine('[2026-11-01T13:44:28.292Z WARN  aether] [-] gateway lost').level === 'warn', 'warn level parsed')
  const now = Date.now()
  check(waitForGool({}, now), 'Auto waits for Gool when it has no history')
  check(!waitForGool({ goolMissedAt: now - 60_000 }, now), "Auto doesn't wait for Gool right after a miss")
  check(warpGateway('[+] using cloudflare edge 162.159.198.131:443') === '162.159.198.131:443', 'gateway read from the log')
  const peerArgs = warpArgs('gool', 1234, 'C:\\data\\aether.toml', '162.159.198.131:443').join(' ')
  check(peerArgs.includes('--peer 162.159.198.131:443'), `a saved config names its gateway: ${peerArgs}`)
  const cfg = newWarpConfig({ method: 'h2', peer: '162.159.198.183:443', exit: 'IR', readyMs: 6800 })
  check(isWarpConfig(cfg) && !isWarpConfig(newWarpServer()) && warpMethods(cfg.warp).join() === 'h2', `saved config: ${cfg.name}`)
  check(waitForGool({ goolMissedAt: now - GOOL_RETRY_MS }, now), `Auto waits for Gool again after ${GOOL_RETRY_MS / 3_600_000} h`)
}

function curlTrace(port: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-m', '15', '-x', `http://127.0.0.1:${port}`, 'https://www.cloudflare.com/cdn-cgi/trace'], (_e, out) => resolve(String(out || '')))
  })
}

/** One DNS query for example.com to 1.1.1.1, as UDP through the local SOCKS5 proxy (UDP ASSOCIATE). */
function udpDnsViaSocks(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tcp = connect({ host: '127.0.0.1', port })
    const udp = createSocket('udp4')
    const done = (ok: boolean) => {
      tcp.destroy()
      udp.close()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), 10000)
    let step = 0
    tcp.on('connect', () => tcp.write(Buffer.from([5, 1, 0])))
    tcp.on('data', (d) => {
      if (step++ === 0) return tcp.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]))
      const relayPort = d.readUInt16BE(8)
      const query = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex')
      const header = Buffer.from([0, 0, 0, 1, 1, 1, 1, 1, 0, 53])
      udp.on('message', (m) => {
        clearTimeout(timer)
        done(m.length > 10 + 12 && m.subarray(10, 12).toString('hex') === 'abcd')
      })
      udp.send(Buffer.concat([header, query]), relayPort, '127.0.0.1')
    })
    tcp.on('error', () => done(false))
  })
}

function aetherProcesses(): number {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq aether.exe', '/NH']).toString().split('\n').filter((l) => /aether\.exe/i.test(l)).length
  } catch {
    return -1
  }
}

async function live() {
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-warptest-'))
  const core = new Core({
    singBox: join(root, 'resources', 'core', 'sing-box.exe'),
    aether: join(root, 'resources', 'aether', 'aether.exe'),
    rulesDir: join(root, 'resources', 'rules'),
    dataDir,
    manageSystemProxy: false
  })
  const port = 20000 + Math.floor(Math.random() * 20000)
  const settings = { ...DEFAULT_SETTINGS, mode: 'proxy-only' as const, mixedPort: port }
  const warp = newWarpServer()
  const before = aetherProcesses()

  console.log('Connect (proxy-only mode, nothing on the system changes)')
  const t0 = Date.now()
  await core.start(warp, settings, [])
  check(core.status.state === 'running', `running after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const won = core.logs.find((l) => /Free WARP connected with/.test(l.text))?.text
  check(!!won, won || 'no "connected with" line')
  check(/Gool/.test(won || ''), 'Auto picked Gool (foreign exit)')
  check(existsSync(join(dataDir, 'warp', WARP_IDENTITY_FILE)), 'WARP account saved')
  check(aetherProcesses() === before + 1, 'only the winning aether.exe is left running')
  const trace = await curlTrace(port)
  check(/warp=(on|plus)/.test(trace), `HTTPS through WARP: ${trace.match(/ip=\S+|loc=\S+|warp=\S+/g)?.join(' ') || 'no answer'}`)
  check(await udpDnsViaSocks(port), 'UDP (DNS) through WARP')
  await core.checkHealth()
  check(!!core.status.health?.server?.ok, `health check through WARP: ${core.status.health?.server?.latency ?? core.status.health?.server?.error} ms`)
  check((await core.testLatency([warp], settings.testUrl)).size === 0, 'latency test skips the WARP server')
  await core.stop()
  check(core.status.state === 'stopped' && aetherProcesses() === before, 'stopped, aether.exe gone')

  console.log('Disconnect while connecting')
  const starting = core.start(warp, settings, []).then(
    () => 'resolved',
    (e) => `threw ${e}`
  )
  await new Promise((r) => setTimeout(r, 800))
  await core.stop()
  const outcome = await starting
  check(outcome === 'resolved' && core.status.state === 'stopped' && !core.status.error, `start ended quietly (${outcome}, ${core.status.state})`)
  await new Promise((r) => setTimeout(r, 500))
  check(aetherProcesses() === before, 'no aether.exe left behind')

  console.log('Reconnect with the saved account')
  const mark = core.logs.length
  await core.start(warp, settings, [])
  check(core.status.state === 'running', 'running again')
  check(!core.logs.slice(mark).some((l) => /creating a WARP account/.test(l.text)), 'no new WARP account was made')
  const stateFile = join(dataDir, 'warp', WARP_STATE_FILE)
  check(!JSON.parse(readFileSync(stateFile, 'utf8')).goolMissedAt, 'Gool connected, so no miss is remembered')
  await core.stop()

  console.log('Reconnect right after Gool missed')
  writeFileSync(stateFile, JSON.stringify({ goolMissedAt: Date.now() }))
  const mark2 = core.logs.length
  const t1 = Date.now()
  await core.start(warp, settings, [])
  check(core.status.state === 'running', `running after ${((Date.now() - t1) / 1000).toFixed(1)} s`)
  check(core.logs.slice(mark2).some((l) => /Gool didn't get through recently/.test(l.text)), 'Auto took the first way that works, without waiting')
  check(!core.logs.slice(mark2).some((l) => /waiting up to/.test(l.text)), 'no 30 s wait for Gool')

  console.log('Find configs')
  let refused = ''
  await core.findWarpConfigs().catch((e) => (refused = String(e)))
  check(/Disconnect first/.test(refused), 'refused while connected')
  await core.stop()
  const t2 = Date.now()
  const found = await core.findWarpConfigs()
  check(found.length > 0, `${found.length} found in ${((Date.now() - t2) / 1000).toFixed(1)} s: ${found.map((f) => `${f.method}@${f.peer} ${f.exit ?? '?'}`).join(', ')}`)
  check(
    found.every((f) => (f.method === 'h2-ipv6' ? /^\[[0-9a-f:]+\]:\d+$/i : /^\d+\.\d+\.\d+\.\d+:\d+$/).test(f.peer)),
    'each config has a gateway of its own kind (IPv6 for the IPv6 method)'
  )
  check(found.every((f) => !!f.exit), 'each config knows its exit country')
  check(aetherProcesses() === before, 'no aether.exe left after finding configs')

  console.log('Connect with a saved config')
  const best = found.find((f) => f.method === 'gool') ?? found[0]
  if (best) {
    const config = newWarpConfig(best)
    const mark3 = core.logs.length
    const t3 = Date.now()
    await core.start(config, settings, [])
    check(core.status.state === 'running', `running after ${((Date.now() - t3) / 1000).toFixed(1)} s`)
    check(core.logs.slice(mark3).some((l) => l.text.includes(`saved gateway ${best.peer}`)), 'used the saved gateway, no scan')
    check(!core.logs.slice(mark3).some((l) => /scan mode=/.test(l.text)), 'Aether did not scan')
    check(/warp=(on|plus)/.test(await curlTrace(port)), 'HTTPS through WARP')
    await core.stop()
  }

  console.log('A saved gateway that stopped answering')
  const dead = newWarpConfig({ method: 'h2', peer: '192.0.2.1:443', readyMs: 0 })
  let moved: string | undefined
  core.onWarpPeer = (_id, peer) => (moved = peer)
  const mark4 = core.logs.length
  await core.start(dead, settings, [])
  check(core.status.state === 'running', 'still connects (scanned for another gateway)')
  check(core.logs.slice(mark4).some((l) => /saved gateway didn't answer/.test(l.text)), 'logged the dead gateway')
  check(!!moved && moved !== '192.0.2.1:443', `the config was updated to ${moved}`)
  await core.stop()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/**
 * The WARP account made through one of the user's own servers (for networks that block
 * Cloudflare's WARP service). A local shadowsocks server stands in for the user's server, and
 * only the "through your own server" way is tried.
 */
async function viaOwnServer() {
  console.log('Account through your own server')
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-warptest-via-'))
  const ssPort = 20000 + Math.floor(Math.random() * 20000)
  const ssConfig = join(dataDir, 'ss-server.json')
  writeFileSync(
    ssConfig,
    JSON.stringify({
      log: { level: 'info' },
      inbounds: [{ type: 'shadowsocks', listen: '127.0.0.1', listen_port: ssPort, method: 'aes-128-gcm', password: 'bridge-test' }],
      outbounds: [{ type: 'direct' }]
    })
  )
  let ssLog = ''
  const ss = spawn(join(root, 'resources', 'core', 'sing-box.exe'), ['run', '-c', ssConfig], { windowsHide: true })
  ss.stdout.on('data', (d) => (ssLog += d))
  ss.stderr.on('data', (d) => (ssLog += d))
  await new Promise((r) => setTimeout(r, 1000))

  const tries = WARP_REGISTER_TRIES.splice(0)
  WARP_REGISTER_TRIES.push(...tries.filter((t) => t.via))
  const core = new Core({
    singBox: join(root, 'resources', 'core', 'sing-box.exe'),
    aether: join(root, 'resources', 'aether', 'aether.exe'),
    rulesDir: join(root, 'resources', 'rules'),
    dataDir,
    manageSystemProxy: false
  })
  const own = parseLink(`ss://${Buffer.from('aes-128-gcm:bridge-test').toString('base64')}@127.0.0.1:${ssPort}#My server`)
  const port = 20000 + Math.floor(Math.random() * 20000)
  const settings = { ...DEFAULT_SETTINGS, mode: 'proxy-only' as const, mixedPort: port }

  // No own server: a clear error.
  const noServer = await core.start(newWarpServer(), settings, []).then(
    () => '',
    (e) => String(e)
  )
  check(/could not create a WARP account/.test(noServer) && /your own servers/.test(noServer), 'without an own server: clear error')

  core.warpHelper = () => own
  await core.start(newWarpServer(), settings, [])
  check(core.logs.some((l) => /using "My server" to reach/.test(l.text)), 'the account went through the own server')
  check(/cloudflare/i.test(ssLog), 'the own server carried the WARP API call')
  check(existsSync(join(dataDir, 'warp', WARP_IDENTITY_FILE)) && core.status.state === 'running', 'account created and WARP connected')
  check(/warp=(on|plus)/.test(await curlTrace(port)), 'HTTPS through WARP')
  await core.stop()
  WARP_REGISTER_TRIES.splice(0, WARP_REGISTER_TRIES.length, ...tries)
  await new Promise<void>((r) => {
    ss.once('exit', () => r())
    ss.kill()
  })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function main() {
  offline()
  if (!process.argv.includes('--offline')) {
    await live()
    await viaOwnServer()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
