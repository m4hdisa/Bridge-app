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
  // The WARP engine, the Psiphon client it chains into for an exit outside Iran, and their
  // licenses. The Tor helper in pt\ is not used.
  cpSync(join(work, 'aether.exe'), join(aetherDir, 'aether.exe'))
  mkdirSync(join(aetherDir, 'pt'), { recursive: true })
  cpSync(join(work, 'pt', 'psiphon-tunnel-core.exe'), join(aetherDir, 'pt', 'psiphon-tunnel-core.exe'))
  cpSync(join(work, 'LICENSES', 'psiphon-tunnel-core-LICENSE.txt'), join(aetherDir, 'pt', 'psiphon-tunnel-core-LICENSE.txt'))
  cpSync(join(work, 'LICENSES', 'psiphon-tunnel-core-THIRD-PARTY-NOTICES.txt'), join(aetherDir, 'pt', 'psiphon-tunnel-core-THIRD-PARTY-NOTICES.txt'))
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
      'pt\\psiphon-tunnel-core.exe comes unmodified from the same Aether release: Psiphon, GPL-3.0 (see pt\\psiphon-tunnel-core-LICENSE.txt),',
      'source code: https://github.com/Psiphon-Labs/psiphon-tunnel-core',
      ''
    ].join('\r\n')
  )
  rmSync(work, { recursive: true, force: true })
  console.log(`Aether ${AETHER_VERSION} -> ${aetherDir}`)
}

// Per-App (see src/main/perapp.ts): Bridge's own bridge-perapp.exe, built here from native/perapp,
// and the Windows Packet Filter driver it uses, installed without the internet since GitHub and
// Microsoft downloads are often blocked or slow from Iran. Windows Packet Filter's EULA allows
// including it in free products, with the EULA. The MSI is unmodified, checked against a pinned
// hash, and kept as .bin so the build never signs (and so changes) it. scripts/install-driver.ps1
// installs it.
const perAppDir = join(root, 'resources', 'perapp')
const DRIVER_MSI = {
  file: 'WindowsPacketFilter-3.6.2.1-x64.msi.bin',
  url: 'https://github.com/wiresock/ndisapi/releases/download/v3.6.2/Windows.Packet.Filter.3.6.2.1.x64.msi',
  sha256: '9c388c0b7f189f7fa98720bae2caecf7d64f30910838b80b438ecf8956b8502c'
}

/** Go 1.26 or newer, from GO (the go.exe to use) or PATH. */
function goTool() {
  const go = process.env.GO || 'go'
  try {
    execFileSync(go, ['version'], { stdio: 'ignore' })
  } catch {
    throw new Error('Building bridge-perapp.exe needs Go 1.26 or newer (https://go.dev/dl/); put it on PATH or set GO to its go.exe')
  }
  return go
}

async function fetchPerApp() {
  rmSync(perAppDir, { recursive: true, force: true })
  mkdirSync(perAppDir, { recursive: true })
  console.log(`Downloading ${DRIVER_MSI.url}`)
  const bytes = await download(DRIVER_MSI.url)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== DRIVER_MSI.sha256) throw new Error(`${DRIVER_MSI.file}: checksum mismatch, got ${actual}, expected ${DRIVER_MSI.sha256}`)
  writeFileSync(join(perAppDir, DRIVER_MSI.file), bytes)
  cpSync(join(root, 'scripts', 'install-driver.ps1'), join(perAppDir, 'install-driver.ps1'))
  console.log('Building bridge-perapp.exe')
  execFileSync(goTool(), ['build', '-trimpath', '-ldflags', '-s -w -buildid=', '-o', join(perAppDir, 'bridge-perapp.exe'), '.'], {
    cwd: join(root, 'native', 'perapp'),
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
    stdio: 'inherit'
  })
  // Windows Packet Filter's EULA must go with every copy: take it from the MSI itself.
  const eula = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$i = New-Object -ComObject WindowsInstaller.Installer; ` +
        `$db = $i.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$i,@('${join(perAppDir, DRIVER_MSI.file)}',0)); ` +
        `$v = $db.GetType().InvokeMember('OpenView','InvokeMethod',$null,$db,@("SELECT Text FROM Control WHERE Type='ScrollableText'")); ` +
        `$v.GetType().InvokeMember('Execute','InvokeMethod',$null,$v,$null); ` +
        `$r = $v.GetType().InvokeMember('Fetch','InvokeMethod',$null,$v,$null); ` +
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $r.GetType().InvokeMember('StringData','GetProperty',$null,$r,1)`
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  if (!eula.includes('Windows Packet Filter')) throw new Error('Could not read the Windows Packet Filter EULA from its MSI')
  writeFileSync(join(perAppDir, 'WindowsPacketFilter-EULA.rtf'), eula.trim())
  writeFileSync(
    join(perAppDir, 'SOURCE.txt'),
    [
      'Per-App, installed by install-driver.ps1.',
      '',
      'bridge-perapp.exe: part of Bridge (GPL-3.0-or-later), source in native/perapp. Built on ndisapi-go',
      '  (github.com/wiresock/ndisapi-go, MIT, Copyright (c) 2024 Vadim Smirnov), socks5 (github.com/wzshiming/socks5,',
      '  MIT, Copyright (c) 2020 wzshiming) and golang.org/x/sys (BSD-3-Clause, Copyright 2009 The Go Authors).',
      `${DRIVER_MSI.file}: Windows Packet Filter 3.6.2.1 by NT KERNEL, freeware for non-commercial use, unmodified`,
      "  (\".bin\" is only added to the name so Bridge's build leaves it untouched), included in this free product",
      '  as its EULA allows (WindowsPacketFilter-EULA.rtf). https://www.ntkernel.com/windows-packet-filter/',
      ''
    ].join('\r\n')
  )
  console.log(`Per-App files -> ${perAppDir}`)
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
await fetchPerApp()
await fetchRules()
if (!existsSync(join(coreDir, 'sing-box.exe'))) throw new Error('sing-box.exe missing after extraction')
if (!existsSync(join(xrayDir, 'xray.exe'))) throw new Error('xray.exe missing after extraction')
if (!existsSync(join(aetherDir, 'aether.exe'))) throw new Error('aether.exe missing after extraction')
if (!existsSync(join(aetherDir, 'pt', 'psiphon-tunnel-core.exe'))) throw new Error('psiphon-tunnel-core.exe missing after extraction')
if (!existsSync(join(perAppDir, 'bridge-perapp.exe'))) throw new Error('bridge-perapp.exe missing after the build')
