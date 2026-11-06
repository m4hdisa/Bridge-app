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

// The Per-App driver (see src/main/perapp.ts), installed without the internet, since GitHub and
// Microsoft downloads are often blocked or slow from Iran: ProxiFyre, Windows Packet Filter (its
// EULA allows including it in free products, with the EULA) and the Visual C++ runtime ProxiFyre
// pins. All unmodified, checked against pinned hashes, and kept as .bin so the build never signs
// (and so changes) them. scripts/install-driver.ps1 installs them.
const PROXIFYRE_VERSION = '2.6.4'
const proxifyreDir = join(root, 'resources', 'proxifyre')
const DRIVER_FILES = [
  {
    file: `ProxiFyre-${PROXIFYRE_VERSION}-win-x64.msi.bin`,
    url: `https://github.com/wiresock/proxifyre/releases/download/v${PROXIFYRE_VERSION}/ProxiFyre-${PROXIFYRE_VERSION}-win-x64.msi`,
    sha256: 'ef64b295485cd16ad3e41a6b7d56e7ab46da2093ff64389edc17545157777de1'
  },
  {
    file: 'WindowsPacketFilter-3.6.2.1-x64.msi.bin',
    url: 'https://github.com/wiresock/ndisapi/releases/download/v3.6.2/Windows.Packet.Filter.3.6.2.1.x64.msi',
    sha256: '9c388c0b7f189f7fa98720bae2caecf7d64f30910838b80b438ecf8956b8502c'
  },
  {
    // The exact build ProxiFyre 2.6.4's own setup installs (its scripts/Build-Installer.ps1).
    file: 'VC_redist-14.44.35211-x64.exe.bin',
    url: 'https://download.visualstudio.microsoft.com/download/pr/0b44c2d1-8944-4834-a01a-c9a225f8088a/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe',
    sha256: 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b'
  }
]

async function fetchProxiFyre() {
  rmSync(proxifyreDir, { recursive: true, force: true })
  mkdirSync(proxifyreDir, { recursive: true })
  for (const { file, url, sha256 } of DRIVER_FILES) {
    console.log(`Downloading ${url}`)
    const bytes = await download(url)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) throw new Error(`${file}: checksum mismatch, got ${actual}, expected ${sha256}`)
    writeFileSync(join(proxifyreDir, file), bytes)
  }
  cpSync(join(root, 'scripts', 'install-driver.ps1'), join(proxifyreDir, 'install-driver.ps1'))
  // Windows Packet Filter's EULA must go with every copy: take it from the MSI itself.
  const eula = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$i = New-Object -ComObject WindowsInstaller.Installer; ` +
        `$db = $i.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$i,@('${join(proxifyreDir, DRIVER_FILES[1].file)}',0)); ` +
        `$v = $db.GetType().InvokeMember('OpenView','InvokeMethod',$null,$db,@("SELECT Text FROM Control WHERE Type='ScrollableText'")); ` +
        `$v.GetType().InvokeMember('Execute','InvokeMethod',$null,$v,$null); ` +
        `$r = $v.GetType().InvokeMember('Fetch','InvokeMethod',$null,$v,$null); ` +
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $r.GetType().InvokeMember('StringData','GetProperty',$null,$r,1)`
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  if (!eula.includes('Windows Packet Filter')) throw new Error('Could not read the Windows Packet Filter EULA from its MSI')
  writeFileSync(join(proxifyreDir, 'WindowsPacketFilter-EULA.rtf'), eula.trim())
  writeFileSync(join(proxifyreDir, 'ProxiFyre-LICENSE.txt'), await download(`https://raw.githubusercontent.com/wiresock/proxifyre/v${PROXIFYRE_VERSION}/LICENSE`))
  writeFileSync(
    join(proxifyreDir, 'SOURCE.txt'),
    [
      'The Per-App driver, installed by install-driver.ps1. Every file is the official one, unmodified; ".bin" is only',
      "added to the name so Bridge's build leaves it untouched.",
      '',
      `${DRIVER_FILES[0].file}: ProxiFyre ${PROXIFYRE_VERSION}, AGPL-3.0 (ProxiFyre-LICENSE.txt).`,
      `  Source code: https://github.com/wiresock/proxifyre/tree/v${PROXIFYRE_VERSION}`,
      `${DRIVER_FILES[1].file}: Windows Packet Filter 3.6.2.1 by NT KERNEL, freeware for non-commercial use,`,
      '  included in this free product as its EULA allows (WindowsPacketFilter-EULA.rtf). https://www.ntkernel.com/windows-packet-filter/',
      `${DRIVER_FILES[2].file}: Microsoft Visual C++ Redistributable 14.44.35211 (x64), redistributable under its Microsoft license.`,
      ''
    ].join('\r\n')
  )
  console.log(`Per-App driver files -> ${proxifyreDir}`)
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
await fetchProxiFyre()
await fetchRules()
if (!existsSync(join(coreDir, 'sing-box.exe'))) throw new Error('sing-box.exe missing after extraction')
if (!existsSync(join(xrayDir, 'xray.exe'))) throw new Error('xray.exe missing after extraction')
if (!existsSync(join(aetherDir, 'aether.exe'))) throw new Error('aether.exe missing after extraction')
if (!existsSync(join(aetherDir, 'pt', 'psiphon-tunnel-core.exe'))) throw new Error('psiphon-tunnel-core.exe missing after extraction')
