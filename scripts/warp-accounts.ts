// Daily run in Bridge-configs: makes WARP starter accounts with the official Aether core, for
// Bridge users whose network blocks Cloudflare's WARP sign-up and who have no server of their own
// to make one through. Bridge connects with one of them only long enough to make the user's own
// account through that tunnel (see Core.useStarterAccount), so these are public and short-lived.
// Usage: node warp-accounts.cjs --aether <aether.exe> --count 60 --out <dir>
// Built into warp-accounts.cjs with `npm run bundle-warp-accounts`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WARP_IDENTITY_FILE, warpRegisterArgs, warpShareLink } from '../src/main/warp'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  const value = i >= 0 ? process.argv[i + 1] : fallback
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

const aether = arg('aether')
const count = Number(arg('count', '60'))
const out = arg('out', '.')
/** Cloudflare refuses sign-ups for a while after too many; stop instead of hammering it. */
const MAX_FAILURES_IN_A_ROW = 3

const links: string[] = []
let failuresInARow = 0
for (let i = 0; i < count && failuresInARow < MAX_FAILURES_IN_A_ROW; i++) {
  const dir = mkdtempSync(join(tmpdir(), 'warp-starter-'))
  try {
    const run = spawnSync(aether, warpRegisterArgs(join(dir, 'aether.toml')), { timeout: 60_000, encoding: 'utf8', windowsHide: true })
    const file = join(dir, WARP_IDENTITY_FILE)
    if (!existsSync(file)) {
      failuresInARow++
      console.log(`account ${i + 1}: failed (${(run.stderr || run.stdout || String(run.error ?? '')).trim().split(/\r?\n/).pop()})`)
      continue
    }
    failuresInARow = 0
    links.push(warpShareLink({ method: 'auto' }, readFileSync(file, 'utf8'), 'Free WARP'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`${links.length} of ${count} WARP starter accounts made`)
// A run that made none keeps yesterday's list, which still works.
if (links.length) writeFileSync(join(out, 'warp.txt'), links.join('\n') + '\n')
else process.exitCode = 1
