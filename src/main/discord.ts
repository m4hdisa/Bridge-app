// Discord activity ("Rich Presence"): shows Bridge's connection status on the user's Discord
// profile. Talks to the Discord desktop app on this PC over its local named pipe
// (\\?\pipe\discord-ipc-N), so nothing goes over the internet. The protocol is small: each
// message is an opcode and a length (both little-endian int32) followed by JSON.
import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'

/** Bridge's application in the Discord developer portal; Discord shows its name ("Bridge"). Not a secret. */
export const DISCORD_CLIENT_ID = '1566522030793433279'

/** How often to look for Discord again while it isn't running. */
const RETRY_MS = 15_000

const enum Op {
  Handshake = 0,
  Frame = 1,
  Close = 2,
  Ping = 3,
  Pong = 4
}

/** What Discord shows under the user's name. See Discord's SET_ACTIVITY. */
export interface DiscordActivity {
  details?: string
  state?: string
  /** Milliseconds since the epoch; Discord counts up from it ("01:23 elapsed"). */
  timestamps?: { start?: number }
  /** Images: keys uploaded under Rich Presence → Art Assets, or https URLs. The small one sits on the large one's corner. */
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string }
  buttons?: { label: string; url: string }[]
}

export function encodeFrame(op: number, data: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(data))
  const head = Buffer.alloc(8)
  head.writeInt32LE(op, 0)
  head.writeInt32LE(json.length, 4)
  return Buffer.concat([head, json])
}

/** Splits complete frames off the front of `buf`; returns them and what is left. */
export function decodeFrames(buf: Buffer): { frames: { op: number; data: any }[]; rest: Buffer } {
  const frames: { op: number; data: any }[] = []
  while (buf.length >= 8) {
    const len = buf.readInt32LE(4)
    if (buf.length < 8 + len) break
    let data: unknown
    try {
      data = JSON.parse(buf.subarray(8, 8 + len).toString())
    } catch {
      data = undefined
    }
    frames.push({ op: buf.readInt32LE(0), data })
    buf = buf.subarray(8 + len)
  }
  return { frames, rest: buf }
}

export function discordPipe(n: number): string {
  return process.platform === 'win32' ? `\\\\?\\pipe\\discord-ipc-${n}` : `${process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'}/discord-ipc-${n}`
}

/**
 * Keeps one activity on Discord while enabled: connects when Discord is running (and again
 * whenever it restarts), resends the current activity after each connect, and clears it when
 * disabled. Errors only show up in the log; Discord being closed is normal.
 */
export class DiscordPresence {
  private enabled = false
  private socket?: Socket
  private ready = false
  private activity: DiscordActivity | null = null
  /** The activity Discord has now (JSON), so unchanged updates aren't resent. */
  private sent?: string
  private retry?: NodeJS.Timeout
  private connecting = false
  private warned = false

  constructor(
    private log: (text: string, level?: 'info' | 'warn') => void,
    private clientId = DISCORD_CLIENT_ID,
    private pipe = discordPipe
  ) {}

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) void this.connect()
    else {
      this.clearRetry()
      if (this.ready) this.send(null)
      this.close()
    }
  }

  /** The activity to show, or null to show none. Sent now if connected, else on the next connect. */
  update(activity: DiscordActivity | null): void {
    this.activity = activity
    if (this.ready) this.send(activity)
  }

  dispose(): void {
    this.setEnabled(false)
  }

  private send(activity: DiscordActivity | null): void {
    const json = JSON.stringify(activity)
    if (json === this.sent || !this.socket) return
    this.sent = json
    this.socket.write(encodeFrame(Op.Frame, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: randomUUID() }))
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.socket || !this.enabled) return
    this.connecting = true
    let socket: Socket | undefined
    // Discord takes the first free pipe of discord-ipc-0..9 (more than one when Canary / PTB run too).
    for (let n = 0; n < 10 && !socket; n++) socket = await this.open(this.pipe(n))
    this.connecting = false
    if (!this.enabled) {
      socket?.destroy()
      return
    }
    if (!socket) return this.scheduleRetry()
    this.socket = socket
    let buf: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = decodeFrames(Buffer.concat([buf, chunk]))
      buf = rest
      for (const f of frames) this.onFrame(f.op, f.data)
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.close()
      this.scheduleRetry()
    })
    socket.on('error', () => undefined)
    socket.write(encodeFrame(Op.Handshake, { v: 1, client_id: this.clientId }))
  }

  private open(path: string): Promise<Socket | undefined> {
    return new Promise((resolve) => {
      const s = connect(path)
      s.once('connect', () => {
        s.removeAllListeners('error')
        resolve(s)
      })
      s.once('error', () => {
        s.destroy()
        resolve(undefined)
      })
    })
  }

  private onFrame(op: number, data: any): void {
    if (op === Op.Ping) return void this.socket?.write(encodeFrame(Op.Pong, data))
    if (op === Op.Close) {
      this.log(`Discord activity: Discord closed the connection (${data?.message ?? data?.code ?? 'no reason given'})`, 'warn')
      this.socket?.destroy()
      return
    }
    if (op !== Op.Frame) return
    if (data?.evt === 'READY') {
      this.ready = true
      this.sent = undefined
      if (!this.warned) this.log(`Discord activity: connected to Discord${data.data?.user?.username ? ` (${data.data.user.username})` : ''}`)
      this.warned = true
      this.send(this.activity)
    } else if (data?.evt === 'ERROR') {
      this.log(`Discord activity: ${data.data?.message ?? 'Discord refused the activity'}`, 'warn')
    }
  }

  private close(): void {
    const s = this.socket
    this.socket = undefined
    this.ready = false
    this.sent = undefined
    s?.destroy()
  }

  private scheduleRetry(): void {
    if (!this.enabled || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.connect()
    }, RETRY_MS)
    this.retry.unref?.()
  }

  private clearRetry(): void {
    clearTimeout(this.retry)
    this.retry = undefined
  }
}
