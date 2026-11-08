// Answers sing-box's DNS questions on a local port, through several DNS-over-HTTPS servers.
// Every app's lookups share one DNS (Windows sends them all through one service), and sing-box's
// own DoH client waits up to 10 s on a connection that silently stopped passing data, so one
// stalled connection held up every app, on or off the VPN, again and again. Here a question that
// isn't answered within moments also goes to the next server, a stalled connection is thrown away
// at once, and identical questions (Windows repeats them every second) are asked only once.
import { createSocket } from 'node:dgram'
import { connect as http2Connect, constants as h2, type ClientHttp2Session } from 'node:http2'
import { createServer, type Server, type Socket } from 'node:net'
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls'
import { socksDialer } from './speedtest'

export interface DohServer {
  host: string
  port?: number
  /** Only for names other than the address itself; the public resolvers' certificates cover their IPs. */
  servername?: string
}

export interface DnsRelayOptions {
  servers: DohServer[]
  /** The real adapter's address, so these lookups skip the VPN adapter. */
  localAddress?: string
  /** Local SOCKS port into the VPN, the last resort when the direct network answers nothing. */
  proxyPort?: () => number | undefined
  /** Which server to ask through the VPN. Default: the first of `servers`. */
  vpnServer?: DohServer
  /**
   * The check before connecting found no DoH server answering directly. Questions then go through
   * the VPN at once instead of waiting for `servers` first; they are still asked, in case they come back.
   */
  directDown?: boolean
  /**
   * The network's own DNS server (plain, port 53), the very last resort when neither the direct
   * network nor the VPN answers. Iran's block page (10.10.34.x) from it is never passed on.
   * An IPv4 address, with ":port" when it isn't 53 (tests).
   */
  plainDns?: string
  log?: (text: string, level?: 'info' | 'warn') => void
}

/** When each next server is asked, in ms after the question came in. */
export const HEDGE_MS = [0, 300, 800]
const VIA_VPN_MS = 1500
/** How long after the VPN's turn the network's own DNS is asked. */
const PLAIN_AFTER_VPN_MS = 2000
/** A server that takes this long is on a dead connection, which gets replaced. */
const ATTEMPT_MS = 2500
const ANSWER_MS = 6000
/** How long a server that stalled goes to the back of the line. */
const PENALTY_MS = 20_000
const REPORT_EVERY_MS = 60_000
const HEADER_BYTES = 12
const SERVFAIL = 2
/** How long an address that timed out is avoided. */
const UNREACHABLE_MS = 5 * 60_000
const MAX_REMEMBERED = 20_000
/** How long an answer with only bad addresses waits for another server's. */
const OTHER_ANSWER_MS = 800
const TYPE_A = 1

function skipName(msg: Buffer, at: number): number {
  for (;;) {
    const size = msg[at]
    if (size === undefined) throw new RangeError('Name past the end')
    if (size === 0) return at + 1
    if ((size & 0xc0) === 0xc0) return at + 2
    at += size + 1
  }
}

/** Every IPv4 address in a DNS answer, with where it sits in the message. Empty if it can't be read. */
export function answerAddresses(msg: Buffer): { ip: string; offset: number }[] {
  const found: { ip: string; offset: number }[] = []
  try {
    const questions = msg.readUInt16BE(4)
    const answers = msg.readUInt16BE(6)
    let at = HEADER_BYTES
    for (let i = 0; i < questions; i++) at = skipName(msg, at) + 4
    for (let i = 0; i < answers; i++) {
      at = skipName(msg, at)
      const type = msg.readUInt16BE(at)
      const size = msg.readUInt16BE(at + 8)
      at += 10
      if (at + size > msg.length) throw new RangeError('Record past the end')
      if (type === TYPE_A && size === 4) found.push({ ip: `${msg[at]}.${msg[at + 1]}.${msg[at + 2]}.${msg[at + 3]}`, offset: at })
      at += size
    }
  } catch {
    return []
  }
  return found
}

interface Waiter {
  socket: Socket
  id: number
}

interface Question {
  waiters: Waiter[]
  timers: NodeJS.Timeout[]
  done: boolean
}

/** Iran's block page: what the network's DNS gives for blocked sites. */
function isBlockPage(ip: string): boolean {
  return ip.startsWith('10.10.34.')
}

interface Upstream {
  readonly name: string
  stalledUntil: number
  ask(query: Buffer): Promise<Buffer>
  reset(): void
  close(): void
}

/** Plain DNS over UDP to the network's own server, one socket per question. */
class PlainClient implements Upstream {
  stalledUntil = 0

  constructor(
    readonly name: string,
    private server: string,
    private localAddress?: string
  ) {}

  ask(query: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4')
      const id = Math.floor(Math.random() * 0x10000)
      const wire = Buffer.from(query)
      wire.writeUInt16BE(id, 0)
      let settled = false
      const done = (e: Error | undefined, answer?: Buffer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          socket.close()
        } catch {
          // Already closed after an error.
        }
        if (e) reject(e)
        else resolve(answer!)
      }
      const timer = setTimeout(() => done(new Error('No answer')), ATTEMPT_MS)
      socket.on('error', (e) => done(e))
      socket.on('message', (msg) => {
        if (msg.length < HEADER_BYTES || msg.readUInt16BE(0) !== id) return
        if (msg[2] & 0x02) return done(new Error('Answer too long for plain DNS'))
        if (answerAddresses(msg).some((a) => isBlockPage(a.ip))) return done(new Error('Censored answer (10.10.34.x)'))
        const answer = Buffer.from(msg)
        answer.writeUInt16BE(0, 0)
        done(undefined, answer)
      })
      const [host, port] = this.server.split(':')
      socket.bind({ port: 0, address: this.localAddress }, () => socket.send(wire, Number(port ?? 53), host))
    })
  }

  reset(): void {}

  close(): void {}
}

class DohClient implements Upstream {
  private session?: Promise<ClientHttp2Session>
  stalledUntil = 0

  constructor(
    readonly name: string,
    private open: () => Promise<ClientHttp2Session>
  ) {}

  private connect(): Promise<ClientHttp2Session> {
    if (this.session) return this.session
    const opening = this.open().then((s) => {
      const forget = () => {
        if (this.session === opening) this.session = undefined
      }
      s.once('close', forget)
      s.once('goaway', forget)
      s.once('error', forget)
      return s
    })
    opening.catch(() => {
      if (this.session === opening) this.session = undefined
    })
    return (this.session = opening)
  }

  /** Drops the connection, so the next question opens a new one instead of waiting on this one. */
  reset(): void {
    const old = this.session
    this.session = undefined
    void old?.then(
      (s) => s.destroy(),
      () => undefined
    )
  }

  async ask(query: Buffer): Promise<Buffer> {
    const session = await this.connect()
    return new Promise((resolve, reject) => {
      // Cloudflare answers HTTP 400 without the length.
      const req = session.request({ [h2.HTTP2_HEADER_METHOD]: 'POST', [h2.HTTP2_HEADER_PATH]: '/dns-query', [h2.HTTP2_HEADER_CONTENT_TYPE]: 'application/dns-message', [h2.HTTP2_HEADER_ACCEPT]: 'application/dns-message', [h2.HTTP2_HEADER_CONTENT_LENGTH]: query.length })
      const chunks: Buffer[] = []
      req.on('response', (headers) => {
        if (Number(headers[h2.HTTP2_HEADER_STATUS]) !== 200) reject(new Error(`HTTP ${headers[h2.HTTP2_HEADER_STATUS]}`))
      })
      req.on('data', (d: Buffer) => chunks.push(d))
      req.once('error', reject)
      req.once('close', () => {
        const body = Buffer.concat(chunks)
        if (body.length >= HEADER_BYTES) resolve(body)
        else reject(new Error('Empty answer'))
      })
      req.end(query)
    })
  }

  close(): void {
    this.reset()
  }
}

function tlsSession(authority: string, options: ConnectionOptions & { localAddress?: string }): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ ...options, ALPNProtocols: ['h2'] })
    const session = http2Connect(authority, { createConnection: () => tls })
    const fail = (e: Error) => {
      session.destroy()
      tls.destroy()
      reject(e)
    }
    const timer = setTimeout(() => fail(new Error('Connecting timed out')), ATTEMPT_MS)
    session.once('error', fail)
    session.once('connect', () => {
      clearTimeout(timer)
      session.off('error', fail)
      session.on('error', () => undefined)
      resolve(session)
    })
  })
}

export class DnsRelay {
  private server?: Server
  private direct: DohClient[]
  private viaVpn?: DohClient
  private plain?: PlainClient
  private questions = new Map<string, Question>()
  private sockets = new Set<Socket>()
  private watchdogs = new Set<NodeJS.Timeout>()
  private stats = { answered: 0, backup: 0, viaVpn: 0, plain: 0, failed: 0, slowest: 0, replaced: 0 }
  /** Addresses Direct traffic timed out on, until when they are avoided. */
  private unreachable = new Map<string, number>()
  /** Addresses DNS has given out. */
  private seen = new Set<string>()
  private reportTimer?: NodeJS.Timeout
  /** For tests and logs: how many questions went out, after joining identical ones. */
  upstreamAsked = 0
  lastError?: string

  constructor(private o: DnsRelayOptions) {
    this.direct = o.servers.map((s) => {
      const port = s.port ?? 443
      return new DohClient(s.host, () => tlsSession(`https://${s.servername ?? s.host}`, { host: s.host, port, servername: s.servername, localAddress: o.localAddress }))
    })
    const last = o.vpnServer ?? o.servers[0]
    if (o.proxyPort && last) {
      this.viaVpn = new DohClient('the VPN', async () => {
        const port = o.proxyPort?.()
        if (!port) throw new Error('Not connected yet')
        const raw = await socksDialer(port, last.host, last.port ?? 443)()
        return tlsSession(`https://${last.servername ?? last.host}`, { socket: raw, host: last.host, servername: last.servername })
      })
    }
    if (o.directDown) for (const c of this.direct) c.stalledUntil = Date.now() + PENALTY_MS
    if (o.plainDns) this.plain = new PlainClient(`your network's DNS ${o.plainDns}`, o.plainDns, o.localAddress)
  }

  /** Starts listening on a free local port and returns it. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((s) => this.serve(s))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        this.reportTimer = setInterval(() => this.report(), REPORT_EVERY_MS)
        this.reportTimer.unref()
        resolve((server.address() as { port: number }).port)
      })
    })
  }

  stop(): void {
    clearInterval(this.reportTimer)
    this.server?.close()
    this.server = undefined
    for (const s of this.sockets) s.destroy()
    for (const q of this.questions.values()) for (const t of q.timers) clearTimeout(t)
    for (const t of this.watchdogs) clearTimeout(t)
    this.questions.clear()
    for (const c of [...this.direct, this.viaVpn, this.plain]) c?.close()
  }

  /** DNS over TCP: each message starts with its 2-byte length. */
  private serve(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('data', (d) => {
      buffer = Buffer.concat([buffer, d])
      while (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
        const size = buffer.readUInt16BE(0)
        this.onQuery(buffer.subarray(2, 2 + size), socket)
        buffer = buffer.subarray(2 + size)
      }
    })
    socket.on('error', () => undefined)
    socket.once('close', () => this.sockets.delete(socket))
  }

  private onQuery(query: Buffer, socket: Socket): void {
    if (query.length < HEADER_BYTES) return
    const id = query.readUInt16BE(0)
    // Everything but the ID: the same question from another port gets the same answer.
    const key = query.subarray(2).toString('latin1')
    const asked = this.questions.get(key)
    if (asked) return void asked.waiters.push({ socket, id })
    const question: Question = { waiters: [{ socket, id }], timers: [], done: false }
    this.questions.set(key, question)
    // RFC 8484 asks for ID 0 on the wire; each waiter gets its own ID back.
    const wire = Buffer.from(query)
    wire.writeUInt16BE(0, 0)
    this.resolve(key, question, wire)
  }

  private resolve(key: string, question: Question, wire: Buffer): void {
    const t0 = performance.now()
    const now = Date.now()
    // Healthy servers first, in the order given; the sort is stable.
    const line = [...this.direct].sort((a, b) => Number(a.stalledUntil > now) - Number(b.stalledUntil > now))
    let failures = 0
    const vpn = this.viaVpn
    const plain = this.plain
    const attempts = Math.min(line.length, HEDGE_MS.length) + (vpn ? 1 : 0) + (plain ? 1 : 0)
    const asked = new Set<Upstream>()
    let pending = 0
    let held: { answer: Buffer; client: Upstream } | undefined
    const finish = (answer: Buffer | undefined, client?: Upstream) => {
      if (question.done) return
      question.done = true
      this.questions.delete(key)
      for (const t of question.timers) clearTimeout(t)
      const ms = performance.now() - t0
      this.stats.slowest = Math.max(this.stats.slowest, ms)
      if (!answer) this.stats.failed++
      else {
        this.stats.answered++
        if (client === vpn) this.stats.viaVpn++
        else if (client === plain) this.stats.plain++
        else if (client !== line[0]) this.stats.backup++
      }
      for (const w of question.waiters) this.reply(w, answer, wire)
    }
    const ask = (client: Upstream) => {
      if (question.done || asked.has(client)) return
      this.upstreamAsked++
      // Keeps running after another server answered: that's how a stalled connection gets noticed
      // when the backups are hiding it. The next question must not wait on it too.
      const watchdog = setTimeout(() => {
        client.stalledUntil = Date.now() + PENALTY_MS
        client.reset()
      }, ATTEMPT_MS)
      this.watchdogs.add(watchdog)
      const settled = () => {
        clearTimeout(watchdog)
        this.watchdogs.delete(watchdog)
      }
      asked.add(client)
      pending++
      client.ask(wire).then(
        (answer) => {
          settled()
          pending--
          client.stalledUntil = 0
          if (question.done) return
          const usable = this.avoidUnreachable(answer)
          if (usable) return finish(usable, client)
          // Every address in it is known to time out. Another server may give a different one.
          if (!held) {
            held = { answer, client }
            question.timers.push(setTimeout(() => finish(answer, client), OTHER_ANSWER_MS))
            for (const other of line) if (!asked.has(other)) ask(other)
          }
          if (!pending) finish(held.answer, held.client)
        },
        (e) => {
          settled()
          pending--
          this.lastError = `${client.name}: ${e instanceof Error ? e.message : e}`
          // A direct server that refuses at once (a reset connection) goes to the back of the line
          // too, not only one that stalls.
          if (client !== vpn && client !== plain) client.stalledUntil = Date.now() + PENALTY_MS
          if (held && !pending) return finish(held.answer, held.client)
          if (++failures >= attempts) return finish(undefined)
          // The whole direct network refuses: no reason to wait for the VPN's turn.
          if (vpn && !asked.has(vpn) && line.every((c) => c.stalledUntil > Date.now())) ask(vpn)
          // Everything asked so far failed: the network's own DNS is the last resort.
          else if (plain && vpn && asked.has(vpn) && !pending) ask(plain)
        }
      )
    }
    line.slice(0, HEDGE_MS.length).forEach((client, i) => {
      if (HEDGE_MS[i] === 0) ask(client)
      else question.timers.push(setTimeout(() => ask(client), HEDGE_MS[i]))
    })
    // With the whole direct network silent, there's no reason to wait for it first.
    const vpnAt = vpn ? (line.every((c) => c.stalledUntil > now) ? 0 : VIA_VPN_MS) : HEDGE_MS[HEDGE_MS.length - 1]
    if (vpn) question.timers.push(setTimeout(() => ask(vpn), vpnAt))
    if (plain) question.timers.push(setTimeout(() => ask(plain), vpnAt + PLAIN_AFTER_VPN_MS))
    question.timers.push(setTimeout(() => finish(undefined), ANSWER_MS))
  }

  /**
   * Bridge's log says this address timed out on the direct network. Answers stop offering it for a
   * while. Returns whether DNS gave it out, so looking it up again can lead somewhere else; an
   * address an app dialled by itself isn't helped by that.
   * Only addresses that Direct traffic already failed on count: testing every answer ahead of
   * time would show the ISP which blocked sites the apps on the VPN are looking up.
   */
  markUnreachable(ip: string): boolean {
    this.unreachable.set(ip, Date.now() + UNREACHABLE_MS)
    if (this.unreachable.size > MAX_REMEMBERED) this.unreachable.delete(this.unreachable.keys().next().value!)
    return this.seen.has(ip)
  }

  private isUnreachable(ip: string): boolean {
    const until = this.unreachable.get(ip)
    if (until === undefined) return false
    if (until > Date.now()) return true
    this.unreachable.delete(ip)
    return false
  }

  /**
   * The answer with addresses known to time out replaced by a working one from the same answer, or
   * undefined when it has nothing else to offer. They are overwritten rather than removed because
   * other records in the message may point at the bytes around them. Without this, an app sticks
   * to the bad address: the VPN adapter accepts every connection right away, so the app never sees
   * the failure that would make it try the next address.
   */
  private avoidUnreachable(answer: Buffer): Buffer | undefined {
    const addresses = answerAddresses(answer)
    if (this.seen.size > MAX_REMEMBERED) this.seen.clear()
    for (const a of addresses) this.seen.add(a.ip)
    const bad = addresses.filter((a) => this.isUnreachable(a.ip))
    if (!bad.length) return answer
    const good = addresses.find((a) => !this.isUnreachable(a.ip))
    if (!good) return undefined
    const fixed = Buffer.from(answer)
    for (const a of bad) answer.copy(fixed, a.offset, good.offset, good.offset + 4)
    this.stats.replaced += bad.length
    return fixed
  }

  private reply(w: Waiter, answer: Buffer | undefined, query: Buffer): void {
    if (w.socket.destroyed) return
    const body = Buffer.from(answer ?? query)
    body.writeUInt16BE(w.id, 0)
    // No answer: the question itself, marked as a response with "server failure".
    if (!answer) body.writeUInt16BE(0x8180 | SERVFAIL, 2)
    const size = Buffer.alloc(2)
    size.writeUInt16BE(body.length, 0)
    w.socket.write(Buffer.concat([size, body]))
  }

  /** One line a minute, only when lookups had trouble, so the logs say what the network is doing. */
  private report(): void {
    const s = this.stats
    this.stats = { answered: 0, backup: 0, viaVpn: 0, plain: 0, failed: 0, slowest: 0, replaced: 0 }
    if (!s.backup && !s.viaVpn && !s.plain && !s.failed && !s.replaced) return
    this.o.log?.(`DNS: in the last minute ${s.answered} answered, ${s.backup} by a backup server, ${s.viaVpn} through the VPN because the direct network didn't answer, ${s.plain ? `${s.plain} by your network's own DNS because the VPN didn't answer either, ` : ''}${s.failed} not answered, ${s.replaced} addresses that time out replaced; slowest ${Math.round(s.slowest)} ms${this.lastError ? ` (last problem: ${this.lastError})` : ''}`, s.failed || s.viaVpn ? 'warn' : 'info')
    this.lastError = undefined
  }
}
