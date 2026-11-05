// Binding the user's own WARP+ key to Bridge's WARP account, through the same Cloudflare API the
// 1.1.1.1 app uses. Aether has no option for this. The key goes to Cloudflare only and is never
// saved or logged: afterwards it belongs to the account.
import { request } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { socksDialer } from './speedtest'

/** The names and client version Aether itself uses for this API. */
const API_HOSTS = ['api.devices.cloudflare.com', 'api.cloudflareclient.com']
const API_VERSION = 'v0a4471'
const CLIENT_VERSION = 'a-6.35-4471'
const TIMEOUT_MS = 15_000

/** Cloudflare answered, and said no. Trying another way to reach it won't change that. */
export class WarpApiError extends Error {}

export interface WarpCredentials {
  deviceId: string
  token: string
}

export interface WarpAccountInfo {
  accountType: string
  plus: boolean
  license?: string
  /** WARP+ data left on the account, in bytes. */
  premiumData: number
}

/** WARP+ keys are three groups of eight letters and digits. */
export function isWarpKey(key: string): boolean {
  return /^[A-Za-z0-9]{8}-[A-Za-z0-9]{8}-[A-Za-z0-9]{8}$/.test(key)
}

/** The two fields of Aether's identity file that the API needs. */
export function warpCredentials(identity: string): WarpCredentials {
  const field = (name: string) => identity.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
  const deviceId = field('device_id')
  const token = field('access_token')
  if (!deviceId || !token) throw new Error('The WARP account file is incomplete')
  return { deviceId, token }
}

/** Ignores warp_plus, which Cloudflare also answers true for a free account. */
export function accountInfo(body: { account_type?: string; license?: string; premium_data?: number }): WarpAccountInfo {
  const accountType = body.account_type ?? 'free'
  const premiumData = Number(body.premium_data) || 0
  return { accountType, plus: premiumData > 0 || !['free', 'team'].includes(accountType), license: body.license, premiumData }
}

/** Cloudflare's reason from an error answer, if it gave one. */
export function apiErrorText(body: string): string | undefined {
  try {
    const message = (JSON.parse(body) as { errors?: { message?: string }[] }).errors?.[0]?.message
    return message || undefined
  } catch {
    return undefined
  }
}

function open(host: string, port?: number): Promise<TLSSocket> {
  const options = { servername: host, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' as const, maxVersion: 'TLSv1.2' as const }
  if (!port) return Promise.resolve(tlsConnect({ host, port: 443, ...options }))
  return socksDialer(port, host)().then((socket) => tlsConnect({ socket, ...options }))
}

function callHost(host: string, cred: WarpCredentials, method: string, data: string | undefined, port: number | undefined, under: string): Promise<{ status: number; body: string }> {
  return open(host, port).then(
    (socket) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host,
            method,
            path: `/${API_VERSION}/reg/${encodeURIComponent(cred.deviceId)}/account${under}`,
            createConnection: () => socket,
            headers: {
              'User-Agent': 'okhttp/3.12.1',
              'CF-Client-Version': CLIENT_VERSION,
              Authorization: `Bearer ${cred.token}`,
              ...(data ? { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(data) } : {})
            }
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (d) => (body += d))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
            res.on('error', reject)
          }
        )
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timed out')))
        req.on('error', reject)
        socket.once('error', reject)
        req.end(data)
      })
  )
}

/** Tries each of the API's names. An answer from Cloudflare ends it, even a refusal; only silence moves on. */
async function call(cred: WarpCredentials, method: string, data: string | undefined, port?: number, under = ''): Promise<string> {
  let lastError: unknown
  for (const host of API_HOSTS) {
    try {
      const { status, body } = await callHost(host, cred, method, data, port, under)
      if (status >= 200 && status < 300) return body
      // Refused before reaching the API: the other name may be served.
      if (status === 403 && !apiErrorText(body)) {
        lastError = new Error(`HTTP ${status}`)
        continue
      }
      throw new WarpApiError(apiErrorText(body) ?? `HTTP ${status}`)
    } catch (e) {
      if (e instanceof WarpApiError) throw e
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function getWarpAccount(cred: WarpCredentials, port?: number): Promise<WarpAccountInfo> {
  return accountInfo(JSON.parse(await call(cred, 'GET', undefined, port)))
}

/** How many devices are on the account. */
export async function warpDeviceCount(cred: WarpCredentials, port?: number): Promise<number> {
  return (JSON.parse(await call(cred, 'GET', undefined, port, '/devices')) as unknown[]).length
}

export async function putWarpLicense(cred: WarpCredentials, license: string, port?: number): Promise<void> {
  await call(cred, 'PUT', JSON.stringify({ license }), port)
}
