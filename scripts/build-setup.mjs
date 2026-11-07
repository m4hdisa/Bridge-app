// Builds "Bridge Setup <version>.exe", the installer people download: Bridge's own window
// (native/setup) with the electron-builder installer appended inside it. The electron-builder one
// is published too, as "Bridge-Update-<version>.exe": latest.yml points at it, so updates stay
// exactly as they were. Run after electron-builder (npm run dist does). Needs Go 1.26 or newer.
import { execFileSync } from 'node:child_process'
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const dist = join(root, 'dist')
const inner = join(dist, `Bridge-Update-${version}.exe`)
const out = join(dist, `Bridge Setup ${version}.exe`)
if (!existsSync(inner)) throw new Error(`${inner} is missing; run electron-builder first`)

/** The size of an installed Bridge, so the window can show how far copying has got. */
function folderSize(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? folderSize(join(dir, e.name)) : statSync(join(dir, e.name)).size
  return n
}

const go = process.env.GO || 'go'
const program = join(dist, 'setup-program.exe')
console.log('Building Bridge Setup')
execFileSync(go, ['build', '-trimpath', '-ldflags', '-s -w -H windowsgui -buildid=', '-o', program, '.'], {
  cwd: join(root, 'native', 'setup'),
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  stdio: 'inherit'
})

// Its icon, manifest and details, with the same rcedit electron-builder uses for Bridge.exe.
const cache = process.env.ELECTRON_BUILDER_CACHE || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache')
const rcedit = readdirSync(join(cache, 'winCodeSign'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(cache, 'winCodeSign', e.name, 'rcedit-x64.exe'))
  .find((p) => existsSync(p))
if (!rcedit) throw new Error('rcedit-x64.exe not found in the electron-builder cache; run electron-builder once')
const icon = join(dist, '.icon-ico', 'icon.ico')
execFileSync(rcedit, [
  program,
  '--set-icon', icon,
  '--application-manifest', join(root, 'native', 'setup', 'setup.manifest'),
  '--set-file-version', version,
  '--set-product-version', version,
  '--set-version-string', 'FileDescription', 'Bridge Setup',
  '--set-version-string', 'ProductName', 'Bridge',
  '--set-version-string', 'LegalCopyright', 'GPL-3.0-or-later',
  '--set-version-string', 'OriginalFilename', `Bridge Setup ${version}.exe`
])

// [program][installer][meta][meta length][installer length]["BRSETUP1"], as native/setup/payload.go reads it.
const meta = Buffer.from(JSON.stringify({ version, unpacked: folderSize(join(dist, 'win-unpacked')) }))
const innerSize = statSync(inner).size
await pipeline(createReadStream(program), createWriteStream(out))
await pipeline(createReadStream(inner), createWriteStream(out, { flags: 'a' }))
const tail = Buffer.alloc(24)
tail.writeBigUInt64LE(BigInt(meta.length), 0)
tail.writeBigUInt64LE(BigInt(innerSize), 8)
tail.write('BRSETUP1', 16, 'ascii')
const fd = openSync(out, 'a')
writeSync(fd, meta)
writeSync(fd, tail)
closeSync(fd)
rmSync(program)
console.log(`${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`)
