// Downloads the sing-box core, the Xray core, the Aether core (free WARP server) and the Iran
// routing rule-sets into resources/.
// Usage: node scripts/fetch-core.mjs [sing-box version] [xray version] [aether version]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SING_BOX_VERSION = process.argv[2] || '1.14.4'
// Xray runs only the configs sing-box can't (xhttp, VLESS Encryption, ...).
const XRAY_VERSION = process.argv[3] || '26.10.21'
// Aether runs the built-in free WARP server (Cloudflare WARP over MASQUE / WireGuard).
const AETHER_VERSION = process.argv[4] || '2.4.0'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const coreDir = join(root, 'resources', 'core')
const xrayDir = join(root, 'resources', 'xray')
const aetherDir = join(root, 'resources', 'aether')
const rulesDir = join(root, 'resources', 'rules')

// Windows' own bsdtar reads .zip; a GNU tar earlier in PATH (Git Bash) does not.
const SYSTEM_TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const TAR = existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar'

const RULE_SETS = {
  'geoip-ir.srs': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-ir.srs',
  'geosite-ir.srs': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-ir.srs'
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchCore() {
  const name = `sing-box-${SING_BOX_VERSION}-windows-amd64`
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/${name}.zip`
  console.log(`Downloading ${url}`)
  const zip = await download(url)
  const work = join(tmpdir(), `bridge-core-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const zipPath = join(work, 'core.zip')
  writeFileSync(zipPath, zip)
  execFileSync(TAR, ['-xf', zipPath, '-C', work])
  const extracted = join(work, name)
  rmSync(coreDir, { recursive: true, force: true })
  mkdirSync(coreDir, { recursive: true })
  for (const file of readdirSync(extracted)) cpSync(join(extracted, file), join(coreDir, file))
  rmSync(work, { recursive: true, force: true })
  console.log(`sing-box ${SING_BOX_VERSION} -> ${coreDir}`)
}

async function fetchXray() {
  const url = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-windows-64.zip`
  console.log(`Downloading ${url}`)
  const zip = await download(url)
  const work = join(tmpdir(), `bridge-xray-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const zipPath = join(work, 'xray.zip')
  writeFileSync(zipPath, zip)
  execFileSync(TAR, ['-xf', zipPath, '-C', work])
  rmSync(xrayDir, { recursive: true, force: true })
  mkdirSync(xrayDir, { recursive: true })
  // Only the engine itself; Bridge does its routing in sing-box, so no geo data files.
  for (const file of ['xray.exe', 'LICENSE']) cpSync(join(work, file), join(xrayDir, file))
  rmSync(work, { recursive: true, force: true })
  console.log(`Xray ${XRAY_VERSION} -> ${xrayDir}`)
}

async function fetchAether() {
  const url = `https://github.com/CluvexStudio/Aether/releases/download/v${AETHER_VERSION}/aether-windows-x86_64.zip`
  console.log(`Downloading ${url}`)
  const zip = await download(url)
  const expected = (await download(`${url}.sha256`)).toString().trim().split(/\s+/)[0].toLowerCase()
  const actual = createHash('sha256').update(zip).digest('hex')
  if (actual !== expected) throw new Error(`Aether checksum mismatch: got ${actual}, release says ${expected}`)
  const work = join(tmpdir(), `bridge-aether-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const zipPath = join(work, 'aether.zip')
  writeFileSync(zipPath, zip)
  execFileSync(TAR, ['-xf', zipPath, '-C', work])
  rmSync(aetherDir, { recursive: true, force: true })
  mkdirSync(aetherDir, { recursive: true })
  // Only the WARP engine and its licenses; the Tor / Psiphon helpers in pt\ are not used.
  cpSync(join(work, 'aether.exe'), join(aetherDir, 'aether.exe'))
  cpSync(join(work, 'LICENSES', 'aether-LICENSE.txt'), join(aetherDir, 'LICENSE'))
  cpSync(join(work, 'LICENSES', 'THIRD-PARTY-NOTICES.txt'), join(aetherDir, 'THIRD-PARTY-NOTICES.txt'))
  // AGPL-3.0: point to the exact source of this binary.
  writeFileSync(
    join(aetherDir, 'SOURCE.txt'),
    [
      `Aether ${AETHER_VERSION} by CluvexStudio, licensed under AGPL-3.0 (see LICENSE).`,
      `Source code: https://github.com/CluvexStudio/Aether/tree/v${AETHER_VERSION}`,
      'Project channel: https://t.me/CluvexStudio',
      'Bridge runs this aether.exe unmodified, as a separate program, for its free WARP server.',
      ''
    ].join('\r\n')
  )
  rmSync(work, { recursive: true, force: true })
  console.log(`Aether ${AETHER_VERSION} -> ${aetherDir}`)
}

async function fetchRules() {
  mkdirSync(rulesDir, { recursive: true })
  for (const [file, url] of Object.entries(RULE_SETS)) {
    console.log(`Downloading ${url}`)
    writeFileSync(join(rulesDir, file), await download(url))
  }
  console.log(`rule-sets -> ${rulesDir}`)
}

await fetchCore()
await fetchXray()
await fetchAether()
await fetchRules()
if (!existsSync(join(coreDir, 'sing-box.exe'))) throw new Error('sing-box.exe missing after extraction')
if (!existsSync(join(xrayDir, 'xray.exe'))) throw new Error('xray.exe missing after extraction')
if (!existsSync(join(aetherDir, 'aether.exe'))) throw new Error('aether.exe missing after extraction')
