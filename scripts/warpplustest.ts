// WARP+ key test. Offline part: key format, identity file and answers. Live part (safe on a VPS, no
// TUN or system proxy): makes a new free WARP account and sends Cloudflare a key that can't be real,
// which must be refused and leave the account free. A real key can only be tried by its owner.
// Usage: tsx scripts/warpplustest.ts [--offline]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { WARP_IDENTITY_FILE } from '../src/main/warp'
import { accountInfo, apiErrorText, getWarpAccount, isWarpKey, warpCredentials, warpDeviceCount } from '../src/main/warpplus'

const root = join(__dirname, '..')
let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}

function offline() {
  console.log('Key format and answers')
  check(isWarpKey('a1B2c3D4-e5F6g7H8-i9J0k1L2'), 'three groups of eight')
  for (const bad of ['', 'abc', 'a1B2c3D4-e5F6g7H8', 'a1B2c3D4-e5F6g7H8-i9J0k1L2-x', 'a1B2c3D4 e5F6g7H8 i9J0k1L2', '../../a1B2c3-e5F6g7H8-i9J0k1L2']) check(!isWarpKey(bad), `refuses "${bad}"`)
  const cred = warpCredentials('device_id = "d-1"\naccess_token = "t-1"\ncert_pem = """\nAAAA\n"""\n')
  check(cred.deviceId === 'd-1' && cred.token === 't-1', 'reads the account file')
  let threw = false
  try {
    warpCredentials('device_id = "d-1"\n')
  } catch {
    threw = true
  }
  check(threw, 'an incomplete account file is an error')
  check(!accountInfo({ account_type: 'free', warp_plus: true } as object).plus, "free is not WARP+, even though Cloudflare's answer says warp_plus")
  check(accountInfo({ account_type: 'unlimited' }).plus && accountInfo({ account_type: 'limited' }).plus, 'unlimited and limited are')
  check(accountInfo({ account_type: 'free', premium_data: 1000 }).plus && !accountInfo({ account_type: 'team' }).plus, 'data left counts, and a Zero Trust account is not WARP+')
  check(apiErrorText('{"errors":[{"code":1,"message":"Invalid license"}]}') === 'Invalid license' && apiErrorText('<html>') === undefined, "Cloudflare's reason is read when it gives one")
}

async function live() {
  console.log('Live: a new free account and a key that cannot be real')
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-plus-'))
  const core = new Core({ singBox: join(root, 'resources/core/sing-box.exe'), xray: join(root, 'resources/xray/xray.exe'), aether: join(root, 'resources/aether/aether.exe'), rulesDir: join(root, 'resources/rules'), dataDir })
  const fake = 'ZZZZZZZZ-00000000-ZZZZZZZZ'
  const lines: string[] = []
  core.on('log', (l: { text: string }) => lines.push(l.text))
  let message = ''
  try {
    await core.setWarpKey(fake)
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  console.log(`  answer: ${message}`)
  check(message.startsWith('Cloudflare refused this key'), "Cloudflare's API answers Bridge, and refuses the key")
  check(!message.includes(fake) && !lines.some((l) => l.includes(fake)), 'the key is in no message or log line')
  const identityFile = join(dataDir, 'warp', WARP_IDENTITY_FILE)
  const account = await getWarpAccount(warpCredentials(readFileSync(identityFile, 'utf8')))
  console.log(`  account type: ${account.accountType}`)
  check(!account.plus && !!account.license, 'the account stays free and still has its own key')

  console.log('Live: the key of another free account')
  const otherDir = mkdtempSync(join(tmpdir(), 'bridge-plus-'))
  const other = new Core({ singBox: join(root, 'resources/core/sing-box.exe'), xray: join(root, 'resources/xray/xray.exe'), aether: join(root, 'resources/aether/aether.exe'), rulesDir: join(root, 'resources/rules'), dataDir: otherDir })
  const otherLines: string[] = []
  other.on('log', (l: { text: string }) => otherLines.push(l.text))
  let answer = ''
  try {
    await other.setWarpKey(account.license!)
  } catch (e) {
    answer = e instanceof Error ? e.message : String(e)
  }
  console.log(`  answer: ${answer}`)
  console.log(`  log: ${otherLines.filter((l) => l.includes('reports account type')).join(' | ')}`)
  check(answer.startsWith('This key has no WARP+ on it'), 'a free key is refused, and the message says why')
  check(!answer.includes(account.license!) && !otherLines.some((l) => l.includes(account.license!)), 'the key is in no message or log line')
  const owner = warpCredentials(readFileSync(identityFile, 'utf8'))
  const devices = await warpDeviceCount(owner)
  console.log(`  devices on the key's account: ${devices}`)
  check(devices === 1, 'failed tries leave no device on the key')
  const after = await getWarpAccount(warpCredentials(readFileSync(join(otherDir, 'warp', WARP_IDENTITY_FILE), 'utf8')))
  check(after.license !== account.license, 'the account it was tried on has its own key back')
  await core.stop().catch(() => undefined)
  await other.stop().catch(() => undefined)
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(otherDir, { recursive: true, force: true })
}

async function main() {
  offline()
  if (!process.argv.includes('--offline')) await live()
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
