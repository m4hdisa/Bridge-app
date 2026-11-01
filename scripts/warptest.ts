// Free WARP test. Offline part: the Aether command lines and log parsing. Live part (safe on a
// VPS): starts Bridge's core in proxy-only mode (no TUN, no system proxy) with the WARP
// server, sends real HTTPS and UDP traffic through the local proxy, checks cancelling a
// start and reconnecting with the saved WARP account, then stops. Needs internet access.
// Usage: tsx scripts/warptest.ts [--offline]
import { execFile, execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { newWarpServer, parseWarpLine, WARP_IDENTITY_FILE, WARP_READY, warpArgs, warpMethods } from '../src/main/warp'

const root = join(__dirname, '..')
let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}

function offline() {
  console.log('Command lines and logs')
  check(warpMethods({ method: 'auto' }).join(',') === 'h3,h2,h2-fragment,h2-ipv6', `auto races ${warpMethods({ method: 'auto' }).join(', ')}`)
  check(warpMethods({ method: 'wireguard' }).join(',') === 'wireguard', 'a chosen method runs alone')
  const args = warpArgs('h2-ipv6', 1234, 'C:\\data\\aether.toml')
  check(args.includes('--h2') && args.includes('-6') && args.join(' ').includes('--bind 127.0.0.1:1234'), `h2-ipv6 args: ${args.join(' ')}`)
  check(args.join(' ').includes('--exit-loc !IR'), 'Iranian exits are refused')
  const line = parseWarpLine('[2026-11-01T13:44:28.292Z INFO  aether::socks] [+] socks5 server listening on 127.0.0.1:21819')
  check(line.level === 'info' && line.text.startsWith('[+] socks5') && WARP_READY.test(line.text), 'ready line parsed')
  check(parseWarpLine('[2026-11-01T13:44:28.292Z WARN  aether] [-] gateway lost').level === 'warn', 'warn level parsed')
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
  await core.stop()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function main() {
  offline()
  if (!process.argv.includes('--offline')) await live()
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
