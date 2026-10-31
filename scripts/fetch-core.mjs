// Downloads the sing-box core, the Xray core and the Iran routing rule-sets into resources/.
// Usage: node scripts/fetch-core.mjs [sing-box version] [xray version]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SING_BOX_VERSION = process.argv[2] || '1.14.4'
// Xray runs only the configs sing-box can't (xhttp, VLESS Encryption, ...).
const XRAY_VERSION = process.argv[3] || '26.10.21'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const coreDir = join(root, 'resources', 'core')
const xrayDir = join(root, 'resources', 'xray')
const rulesDir = join(root, 'resources', 'rules')

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
  execFileSync('tar', ['-xf', zipPath, '-C', work])
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
  execFileSync('tar', ['-xf', zipPath, '-C', work])
  rmSync(xrayDir, { recursive: true, force: true })
  mkdirSync(xrayDir, { recursive: true })
  // Only the engine itself; Bridge does its routing in sing-box, so no geo data files.
  for (const file of ['xray.exe', 'LICENSE']) cpSync(join(work, file), join(xrayDir, file))
  rmSync(work, { recursive: true, force: true })
  console.log(`Xray ${XRAY_VERSION} -> ${xrayDir}`)
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
await fetchRules()
if (!existsSync(join(coreDir, 'sing-box.exe'))) throw new Error('sing-box.exe missing after extraction')
if (!existsSync(join(xrayDir, 'xray.exe'))) throw new Error('xray.exe missing after extraction')
