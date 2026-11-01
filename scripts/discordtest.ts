// Discord activity test, with a fake Discord: a local named-pipe server that speaks Discord's
// IPC protocol and records what Bridge sends. Safe anywhere (no network, no real Discord).
// Usage: tsx scripts/discordtest.ts
import { createServer, type Socket } from 'node:net'
import { decodeFrames, DISCORD_CLIENT_ID, DiscordPresence, encodeFrame, type DiscordActivity } from '../src/main/discord'

let failed = 0
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PIPE = `\\\\?\\pipe\\bridge-discordtest-${process.pid}`
const frames: { op: number; data: any }[] = []
let client: Socket | undefined
let closed = false
const server = createServer((s) => {
  client = s
  let buf: Buffer = Buffer.alloc(0)
  s.on('data', (chunk: Buffer) => {
    const r = decodeFrames(Buffer.concat([buf, chunk]))
    buf = r.rest
    for (const f of r.frames) {
      frames.push(f)
      // Like Discord: answer the handshake with READY.
      if (f.op === 0) s.write(encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'tester' } } }))
    }
  })
  s.on('close', () => (closed = true))
})
const activities = () => frames.filter((f) => f.op === 1 && f.data?.cmd === 'SET_ACTIVITY').map((f) => f.data.args.activity as DiscordActivity | null)

async function main() {
  await new Promise<void>((r) => server.listen(PIPE, r))
  const logs: string[] = []
  // Only pipe 0 exists, like a single Discord app; the others fail as they would.
  const presence = new DiscordPresence((t) => logs.push(t), DISCORD_CLIENT_ID, (n) => (n === 0 ? PIPE : `${PIPE}-none-${n}`))

  console.log('Connect')
  const a: DiscordActivity = { details: 'Protected', state: 'Per-App · Exit: Germany', timestamps: { start: Date.now() } }
  presence.update(a)
  presence.setEnabled(true)
  await sleep(500)
  check(frames[0]?.op === 0 && frames[0].data.client_id === DISCORD_CLIENT_ID && frames[0].data.v === 1, 'handshake with Bridge\'s application id')
  check(activities().length === 1 && activities()[0]?.details === 'Protected', 'the activity set before connecting is sent once Discord is ready')
  check(frames.find((f) => f.op === 1)?.data.args.pid === process.pid, 'tells Discord which process it is')
  check(logs.some((l) => /connected to Discord \(tester\)/.test(l)), 'logs the connection')

  console.log('Updates')
  presence.update({ ...a })
  await sleep(200)
  check(activities().length === 1, 'an unchanged activity is not resent')
  presence.update({ ...a, state: 'Per-App · Free WARP (Cloudflare)' })
  await sleep(200)
  check(activities().at(-1)?.state === 'Per-App · Free WARP (Cloudflare)', 'a changed activity is sent')
  client!.write(encodeFrame(3, { n: 7 }))
  await sleep(200)
  check(frames.some((f) => f.op === 4 && f.data?.n === 7), 'answers Discord\'s ping')
  presence.update(null)
  await sleep(200)
  check(activities().at(-1) === null, 'disconnecting clears the activity')

  console.log('Turn off')
  presence.update(a)
  await sleep(200)
  presence.setEnabled(false)
  await sleep(300)
  check(activities().at(-1) === null, 'turning it off clears the activity first')
  check(closed, 'and closes the connection to Discord')

  console.log('No Discord running')
  const lonely = new DiscordPresence((t) => logs.push(t), DISCORD_CLIENT_ID, (n) => `${PIPE}-absent-${n}`)
  let threw = false
  try {
    lonely.update(a)
    lonely.setEnabled(true)
    await sleep(500)
    lonely.dispose()
  } catch {
    threw = true
  }
  check(!threw, 'nothing breaks when Discord is closed')

  server.close()
  console.log(failed ? `\n${failed} failed` : '\nAll passed')
  process.exit(failed ? 1 : 0)
}

void main()
