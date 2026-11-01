// Safe check that per-app rules match the calling process and that changing them
// applies live (no restart). Builds a Per-App config, removes the TUN inbound (so
// nothing changes on the system), and sends requests from this node.exe through
// the local proxy while rewriting the app rule-set files.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildConfig, writeAppRuleSets } from '../src/main/config'
import { parseLink } from '../src/main/parser'
import { DEFAULT_SETTINGS } from '../src/main/store'
import type { AppAction, AppRule } from '../src/shared/types'

const root = join(__dirname, '..')
const singBox = join(root, 'resources', 'core', 'sing-box.exe')
const fake = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.1:9?security=none&type=tcp#Fake')
const self = process.execPath
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rule = (path: string, action: AppAction): AppRule[] => [{ id: '1', name: 'node.exe', path, action, enabled: true }]

const EXPECT: Record<AppAction | 'none', RegExp> = {
  proxy: /outbound\/vless\[proxy\]/,
  direct: /outbound\/direct\[direct\]/,
  other: /outbound\/direct\[direct-other\]/,
  block: /reject|blocked/i,
  none: /outbound\/direct\[direct\]/
}

function viaProxy(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: 'http://example.com/', headers: { Host: 'example.com' }, timeout: 4000 }, (res) => {
      res.resume()
      resolve()
    })
    req.on('error', () => resolve())
    req.on('timeout', () => req.destroy())
    req.end()
  })
}

async function main() {
  console.log(`process: ${self}`)
  const dir = mkdtempSync(join(tmpdir(), 'bridge-match-'))
  const appRulesDir = join(dir, 'app-rules')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const config = buildConfig({
    server: fake,
    settings: { ...DEFAULT_SETTINGS, mode: 'per-app', mixedPort: port, logLevel: 'debug' },
    appRules: rule(self, 'proxy'),
    clashApi: { port: port + 1, secret: 'x' },
    appRulesDir
  }) as { inbounds: { type: string }[] }
  config.inbounds = config.inbounds.filter((i) => i.type !== 'tun')
  // Stands in for the TUN adapter: a plain inbound that follows the app rules. (Bridge's own
  // local proxy, mixed-in, always uses the VPN in Per-App mode.)
  const testPort = port + 2
  config.inbounds.push({ type: 'mixed', tag: 'test-in', listen: '127.0.0.1', listen_port: testPort } as { type: string })
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(config, null, 2))

  let out = ''
  const child = spawn(singBox, ['run', '-c', file, '-D', dir], { windowsHide: true })
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const pid = child.pid
  await sleep(1500)

  let failed = 0
  // Each step: optionally rewrite the rules (live), send a request, check the route it took.
  const steps: { label: string; rules?: AppRule[]; expect: keyof typeof EXPECT; viaLocalProxy?: boolean }[] = [
    { label: 'starts with "Use VPN" -> proxy', expect: 'proxy' },
    { label: 'live change to Direct -> direct', rules: rule(self, 'direct'), expect: 'direct' },
    { label: 'live change to Other VPN -> other tool\'s adapter', rules: rule(self, 'other'), expect: 'other' },
    { label: 'live change to Block -> rejected', rules: rule(self, 'block'), expect: 'block' },
    { label: 'live change, different case path -> proxy', rules: rule(self.toUpperCase(), 'proxy'), expect: 'proxy' },
    { label: 'live change, other app only -> this app direct', rules: rule('C:\\Other\\app.exe', 'proxy'), expect: 'none' },
    { label: 'live change, rule disabled -> direct', rules: [{ ...rule(self, 'proxy')[0], enabled: false }], expect: 'none' },
    { label: "unlisted app using Bridge's local proxy -> proxy", rules: rule('C:\\Other\\app.exe', 'proxy'), expect: 'proxy', viaLocalProxy: true },
    { label: "app set to Direct using Bridge's local proxy -> direct", rules: rule(self, 'direct'), expect: 'direct', viaLocalProxy: true }
  ]
  for (const step of steps) {
    if (step.rules) {
      writeAppRuleSets(appRulesDir, step.rules)
      await sleep(1500)
    }
    const from = out.length
    await viaProxy(step.viaLocalProxy ? port : testPort)
    await sleep(500)
    const chunk = out.slice(from).replace(/\x1b\[[0-9;]*m/g, '')
    const ok = EXPECT[step.expect].test(chunk) && (step.expect === 'block' || !/reject/i.test(chunk))
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${step.label}`)
    if (!ok) {
      failed++
      console.log(chunk.split('\n').filter((l) => /router|outbound|reject|rule-set|ERROR/.test(l)).slice(0, 8).map((l) => '       ' + l).join('\n'))
    }
  }

  // An app that updated itself into a new version folder (Discord's "app-1.0.x", Store apps)
  // must still match the rule saved for the old folder.
  const oldExe = join(dir, 'Discord', 'app-1.0.9187', 'node.exe')
  const newExe = join(dir, 'Discord', 'app-1.0.9203', 'node.exe')
  mkdirSync(dirname(newExe), { recursive: true })
  copyFileSync(self, newExe)
  writeAppRuleSets(appRulesDir, rule(oldExe, 'proxy'))
  await sleep(1500)
  {
    const from = out.length
    const script = `require('http').request({ host: '127.0.0.1', port: ${testPort}, path: 'http://example.com/', headers: { Host: 'example.com' }, timeout: 4000 }, (r) => { r.resume(); process.exit(0) }).on('error', () => process.exit(0)).on('timeout', () => process.exit(0)).end()`
    await new Promise<void>((r) => spawn(newExe, ['-e', script], { windowsHide: true }).once('exit', () => r()))
    await sleep(500)
    const ok = EXPECT.proxy.test(out.slice(from).replace(/\x1b\[[0-9;]*m/g, ''))
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} app updated into a new version folder -> still proxy`)
    if (!ok) failed++
  }

  const restarted = child.exitCode !== null || child.pid !== pid
  console.log(`  ${restarted ? 'FAIL' : 'ok  '} same sing-box process the whole time (no restart)`)
  if (restarted) failed++

  await new Promise<void>((r) => {
    child.once('exit', () => r())
    child.kill()
  })
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
