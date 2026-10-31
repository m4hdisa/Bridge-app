// Safe core test: starts sing-box with only a local proxy on 127.0.0.1 (no TUN, no
// system proxy change), checks the Clash API, sends a request through the local proxy,
// runs the latency test flow, then stops. Safe to run on a VPS.
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { parseLink } from '../src/main/parser'
import { DEFAULT_SETTINGS } from '../src/main/store'
import type { TrafficStats } from '../src/shared/types'

const root = join(__dirname, '..')
const dataDir = mkdtempSync(join(tmpdir(), 'bridge-coretest-'))
const core = new Core({
  singBox: join(root, 'resources', 'core', 'sing-box.exe'),
  xray: join(root, 'resources', 'xray', 'xray.exe'),
  rulesDir: join(root, 'resources', 'rules'),
  dataDir,
  manageSystemProxy: false
})

// A fake server: connecting through it will fail, which is expected.
const fake = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.1:9?security=none&type=tcp#Fake')
const port = 20000 + Math.floor(Math.random() * 20000)

let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}

/** Sends an HTTP proxy request to the local mixed inbound; we only care that the proxy answered. */
function viaProxy(): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: 'http://example.com/', headers: { Host: 'example.com' }, timeout: 8000 }, (res) => {
      res.resume()
      resolve(res.statusCode || 0)
    })
    req.on('error', () => resolve(-1))
    req.on('timeout', () => req.destroy())
    req.end()
  })
}

async function main() {
  const statuses: string[] = []
  let stats: TrafficStats | undefined
  core.on('status', (s) => statuses.push(s.state))
  core.on('stats', (s) => (stats = s))

  console.log('Start (system-proxy mode, system proxy NOT changed)')
  await core.start(fake, { ...DEFAULT_SETTINGS, mode: 'system-proxy', mixedPort: port, logLevel: 'debug' }, [])
  check(core.status.state === 'running', 'core is running')
  check(statuses.join(',') === 'starting,running', `status events: ${statuses.join(',')}`)

  await viaProxy()
  // The fake server is unreachable, so we only check that the request reached sing-box and was routed to it.
  check(core.logs.some((l) => /example\.com/.test(l.text) && /outbound\/vless\[proxy\]|proxy/.test(l.text)), 'request through local proxy was routed to the proxy outbound')
  await new Promise((r) => setTimeout(r, 2500))
  check(stats !== undefined, 'traffic stats arrive from the Clash API')

  await core.checkHealth()
  const h = core.status.health
  check(h?.server?.ok === false && !!h.server.error, `health: dead VPN server reported as down (${h?.server?.error})`)
  check(h?.internet?.ok === true, `health: direct internet reported as up (${h?.internet?.latency} ms)`)

  console.log('Stop')
  await core.stop()
  check(core.status.state === 'stopped', 'core stopped')
  check(statuses.at(-1) === 'stopped', 'stopped status event')

  console.log('Latency test flow')
  const results = await core.testLatency([fake], DEFAULT_SETTINGS.testUrl)
  check(results.get(fake.id) === -1, `fake server reports timeout (${results.get(fake.id)})`)

  // A server sing-box refuses to load must not break the test for the others.
  const broken = { ...fake, id: 'broken', name: 'Broken', outbound: { ...fake.outbound, flow: 'not-a-real-flow' } }
  const fake2 = { ...fake, id: 'fake2', name: 'Fake 2' }
  const mixed = await core.testLatency([fake, broken, fake2], DEFAULT_SETTINGS.testUrl)
  check(mixed.size === 3 && mixed.get('broken') === -1, `broken server skipped, others still tested (${[...mixed.entries()].map(([k, v]) => `${k.slice(0, 6)}=${v}`).join(' ')})`)
  check(core.logs.some((l) => /skipping "Broken"/.test(l.text)), 'skip is explained in the log')

  console.log('Xray server (proxy-only mode)')
  const xrayServer = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.1:9?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=dLN2Ibq5VLAB9qG5RveB10JA-pJctpgW7BT7_cfC6Sw&sid=6ba8&type=xhttp&path=%2Fx#Fake-XHTTP')
  check(xrayServer.engine === 'xray', 'xhttp server is assigned to the Xray core')
  const xrayPort = port + 7
  await core.start(xrayServer, { ...DEFAULT_SETTINGS, mode: 'proxy-only', mixedPort: xrayPort, logLevel: 'debug' }, [])
  check(core.status.state === 'running', 'connected with Xray behind sing-box')
  check(core.logs.some((l) => /Using Xray core for Fake-XHTTP/.test(l.text)), 'xray.exe started with a local SOCKS port')
  const before = core.logs.length
  await new Promise<void>((resolve) => {
    const req = request({ host: '127.0.0.1', port: xrayPort, method: 'GET', path: 'http://example.com/', headers: { Host: 'example.com' }, timeout: 6000 }, (res) => {
      res.resume()
      resolve()
    })
    req.on('error', () => resolve())
    req.on('timeout', () => req.destroy())
    req.end()
  })
  await new Promise((r) => setTimeout(r, 500))
  check(core.logs.slice(before).some((l) => /outbound\/socks\[proxy\]/.test(l.text)), 'traffic goes sing-box -> SOCKS hop into Xray')
  await core.stop()
  check(core.status.state === 'stopped', 'stopped (xray.exe stopped too)')
  const xr = await core.testLatency([xrayServer, fake], DEFAULT_SETTINGS.testUrl)
  check(xr.get(xrayServer.id) === -1 && xr.get(fake.id) === -1, 'latency test handles Xray and sing-box servers together')

  const errors = core.logs.filter((l) => l.level === 'error' && !/127\.0\.0\.1:9|connection refused|actively refused/i.test(l.text))
  check(!errors.some((l) => /FATAL|deprecated/i.test(l.text)), 'no fatal or deprecation errors in core log')
  const warnings = core.logs.filter((l) => /deprecated/i.test(l.text))
  if (warnings.length) console.log(warnings.map((w) => '    ' + w.text).join('\n'))
}

main()
  .catch((e) => {
    failed++
    console.log('  FAIL', e)
    console.log(core.logs.slice(-20).map((l) => '    ' + l.text).join('\n'))
  })
  .finally(async () => {
    await core.stop().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
    process.exit(failed ? 1 : 0)
  })
