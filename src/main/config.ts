// Builds sing-box JSON configs (written for sing-box 1.14).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeOutbound } from './parser'
import type { DirectDns } from './resolve'
import { usesTun, type AppAction, type AppRule, type ServerProfile, type Settings } from '../shared/types'

export interface ClashApi {
  port: number
  secret: string
}

export interface BuildOptions {
  server: ServerProfile
  settings: Settings
  appRules: AppRule[]
  clashApi: ClashApi
  /** Folder containing geoip-ir.srs / geosite-ir.srs, or undefined if they are not available. */
  rulesDir?: string
  /** sing-box cache file (remembers rule-sets, fake-ip, etc). */
  cacheFile?: string
  /** Folder holding the per-app rule-set files written by writeAppRuleSets(). */
  appRulesDir: string
  /** How Direct traffic resolves names (see pickDirectDns). Falls back to sing-box's "local" resolver. */
  localDns?: DirectDns
  /** Local port of Bridge's DNS relay (see dnsrelay.ts), which then answers instead of `localDns`. */
  dnsRelayPort?: number
  /** Exe paths whose traffic always goes direct, e.g. Bridge's own xray.exe. */
  bypassProcesses?: string[]
  /**
   * Bind outgoing traffic to this adapter (the real Wi-Fi / Ethernet) instead of letting
   * sing-box pick one, so it never leaves through another tool's tunnel.
   */
  defaultInterface?: string
  /** Adapter of another VPN tool (e.g. "Ezconnect Virtual Adapter") for apps set to "Other VPN". */
  otherInterface?: string
  /**
   * Local SOCKS port whose traffic always goes through the VPN, whatever the mode or app
   * rules. Bridge uses it for its own checks (e.g. looking up the VPN's exit location).
   */
  probePort?: number
  /**
   * Leave IPv6 off the TUN adapter because this network has none. With it on, Windows and apps
   * believe IPv6 works and try it first, but Direct and "Other VPN" traffic can't leave over
   * IPv6 here, so those connections fail (Discord's voice never got past this next to EZConnect).
   */
  noIpv6?: boolean
  /**
   * Other servers to keep ready next to `server`: with them, "proxy" is a selector, so switching
   * servers while connected is one Clash API call instead of a restart that drops everything.
   */
  alternates?: ServerProfile[]
  /**
   * Per-App through ProxiFyre instead of TUN: the chosen apps reach sing-box through this SOCKS
   * inbound and apps set to Block through `blockPort`; nothing else on the system is touched.
   */
  redirect?: { ports: number[]; user: string; password: string; blockPort: number }
  /** Where Windows' DNS is pointed while redirecting (see perapp.ts): a loopback address, port 53. */
  dnsListen?: { address: string; port: number }
}

/** The SOCKS inbound the Per-App driver hands one app on the VPN to (see perapp.ts appSlots). */
export function appsInbound(slot: number): string {
  return `apps-in-${slot}`
}

/** The selector's tag for one server; "proxy" itself always means whichever server is selected. */
export function serverTag(id: string): string {
  return `server-${id}`
}

type Json = Record<string, unknown>

/**
 * Source ports the speed test uses to go through the VPN adapter like an app would. They are
 * below Windows' range for normal outgoing connections (49152 and up), so no app gets them.
 */
export const SPEED_TEST_PORTS = { first: 45800, last: 45899 }
const DEFAULT_TUN_MTU = 9000

const APP_ACTIONS: AppAction[] = ['block', 'direct', 'other', 'proxy']
/** A regex no exe path can match, so an empty rule-set file is still valid. */
const NEVER_MATCH = '^:no-app:$'

/**
 * Points an outbound at an already-resolved IP while keeping the original domain
 * where the server or CDN needs it (TLS SNI, WebSocket/HTTP Host), so sing-box
 * never has to resolve the server name itself.
 */
export function withServerIp<T extends Record<string, unknown>>(outbound: T, ip: string): T {
  const host = outbound.server
  if (typeof host !== 'string' || host === ip) return outbound
  const o = structuredClone(outbound) as Record<string, any>
  o.server = ip
  if (o.tls?.enabled && !o.tls.server_name) o.tls.server_name = host
  const t = o.transport
  if (t?.type === 'ws' && !t.headers?.Host) t.headers = { ...t.headers, Host: host }
  if (t?.type === 'http' && !t.host) t.host = [host]
  if (t?.type === 'httpupgrade' && !t.host) t.host = host
  return o as T
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Case-insensitive match on a Windows exe path. Version numbers in folder names match any
 * version, so a rule keeps working after the app updates itself into a new folder: Discord /
 * Slack ("app-1.0.9187"), Microsoft Store apps ("WhatsAppDesktop_2.2442.6.0_x64__..."), and
 * plain version folders ("\120.0.6099.110\"). The exe name itself must still match exactly.
 */
export function processPathRegex(path: string): string {
  const parts = path.split('\\')
  const exe = escapeRegex(parts.pop() || '')
  const dirs = parts.map((dir) => dir.split(/\d+(?:\.\d+)+/).map(escapeRegex).join('[0-9.]+'))
  return '(?i)^' + [...dirs, exe].join('\\\\') + '$'
}

function appRule(rules: AppRule[], action: AppAction): string[] {
  return rules.filter((r) => r.enabled && r.action === action).map((r) => processPathRegex(r.path))
}

function appRuleSetPath(dir: string, action: AppAction): string {
  return join(dir, `apps-${action}.json`)
}

/**
 * Writes one rule-set file per action (block / direct / proxy). sing-box reloads
 * local rule-sets when their file changes, so app rules apply without a restart
 * (a restart would tear down TUN and cut the whole system's connection).
 */
export function writeAppRuleSets(dir: string, rules: AppRule[]): void {
  mkdirSync(dir, { recursive: true })
  for (const action of APP_ACTIONS) {
    const paths = appRule(rules, action)
    const text = JSON.stringify({ version: 3, rules: [{ process_path_regex: paths.length ? paths : [NEVER_MATCH] }] }, null, 2)
    const file = appRuleSetPath(dir, action)
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
  }
}

/**
 * DNS design (TUN modes). Windows resolves names for every app through one service
 * (svchost), so DNS can't be routed per app. TUN hijacks those queries and answers them:
 *  - "fakeip" (default): every A/AAAA query gets an instant fake IP; sing-box maps it back to
 *    the domain when the app connects, so the VPN server looks up the site itself. Fast, but
 *    tools that work by IP see only 198.18.x.x and break (EZConnect lost Discord this way).
 *  - "real": with real IPs from a clean DNS-over-HTTPS resolver (dns-local, direct, port 443).
 *    No Iranian DNS poisoning, no dependency on the VPN server, and other tools that pick
 *    traffic by IP keep working.
 */
function buildDns(o: BuildOptions, useTun: boolean, iranRules: boolean): Json {
  const local: Json = o.dnsRelayPort
    ? { type: 'tcp', tag: 'dns-local', server: '127.0.0.1', server_port: o.dnsRelayPort }
    : o.localDns
      ? { type: o.localDns.type, tag: 'dns-local', server: o.localDns.server }
      : { type: 'local', tag: 'dns-local' }
  const rules: Json[] = []
  if (o.settings.bypassIran) {
    rules.push({ domain_suffix: ['.ir'], server: 'dns-local' })
    if (iranRules) rules.push({ rule_set: ['geosite-ir'], server: 'dns-local' })
  }
  const servers: Json[] = [local]
  if (useTun && o.settings.dnsMode === 'fakeip') {
    servers.push({ type: 'fakeip', tag: 'dns-fake', inet4_range: '198.18.0.0/15' })
    rules.push({ query_type: ['A', 'AAAA'], server: 'dns-fake' })
  }
  // An answer just past its TTL (a few seconds, on many CDNs) is used at once and refreshed behind
  // the scenes, so sites people keep using never wait on a lookup.
  return { servers, rules, final: 'dns-local', strategy: 'ipv4_only', optimistic: { enabled: true, timeout: '1h' } }
}

/** Builds the config and writes the app rule-set files it points to. */
export function buildConfig(o: BuildOptions): Json {
  const { settings } = o
  const useTun = usesTun(settings.mode) && !o.redirect
  const iranRules = settings.bypassIran && o.rulesDir
  writeAppRuleSets(o.appRulesDir, o.appRules)

  const inbounds: Json[] = [
    { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: settings.mixedPort }
  ]
  if (o.probePort) inbounds.push({ type: 'socks', tag: 'probe-in', listen: '127.0.0.1', listen_port: o.probePort })
  if (o.redirect) {
    const users = [{ username: o.redirect.user, password: o.redirect.password }]
    inbounds.push(
      ...o.redirect.ports.map((port, i) => ({ type: 'socks', tag: appsInbound(i), listen: '127.0.0.1', listen_port: port, users })),
      { type: 'socks', tag: 'block-in', listen: '127.0.0.1', listen_port: o.redirect.blockPort, users }
    )
  }
  if (o.dnsListen) inbounds.push({ type: 'direct', tag: 'dns-in', listen: o.dnsListen.address, listen_port: o.dnsListen.port })
  if (useTun) {
    inbounds.unshift({
      type: 'tun',
      tag: 'tun-in',
      interface_name: 'Bridge',
      address: o.noIpv6 ? ['172.19.0.1/30'] : ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
      mtu: settings.tunMtu >= 1280 && settings.tunMtu <= DEFAULT_TUN_MTU ? settings.tunMtu : DEFAULT_TUN_MTU,
      auto_route: true,
      // Two half routes instead of a default route (OpenVPN's "def1" trick): they are more
      // specific, so all traffic still enters the TUN, but Windows' real default route stays
      // on Wi-Fi / Ethernet. Tools that look up "the" default route to find the internet
      // (EZConnect / WireSock, WireGuard clients) then still find the real adapter instead of
      // Bridge's gateway-less tunnel; with a 0.0.0.0/0 route they failed to connect.
      route_address: o.noIpv6 ? ['0.0.0.0/1', '128.0.0.0/1'] : ['0.0.0.0/1', '128.0.0.0/1', '::/1', '8000::/1'],
      // Strict mode blocks port 53 outside the adapter, so without DNS-over-HTTPS Direct apps couldn't resolve names.
      strict_route: settings.strictRoute && o.localDns?.type === 'https',
      stack: settings.tunStack
    })
  }

  const routeRules: Json[] = [
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    ...(o.dnsListen ? [{ inbound: ['dns-in'], action: 'hijack-dns' }] : []),
    ...(o.redirect ? [{ inbound: ['block-in'], action: 'reject' }] : []),
    ...(o.probePort ? [{ inbound: ['probe-in'], outbound: 'proxy' }] : []),
    ...(useTun ? [{ inbound: ['tun-in'], source_port_range: [`${SPEED_TEST_PORTS.first}:${SPEED_TEST_PORTS.last}`], outbound: 'proxy' }] : []),
    { ip_is_private: true, outbound: 'direct' }
  ]
  if (o.bypassProcesses?.length) routeRules.push({ process_path_regex: o.bypassProcesses.map(processPathRegex), outbound: 'direct' })
  // App rules live in rule-set files (always present, possibly empty) so they can change while connected.
  routeRules.push({ rule_set: ['apps-block'], action: 'reject' })
  routeRules.push({ rule_set: ['apps-direct'], outbound: 'direct' })
  routeRules.push({ rule_set: ['apps-other'], outbound: 'direct-other' })
  if (settings.bypassIran) {
    routeRules.push({ domain_suffix: ['.ir'], outbound: 'direct' })
    if (iranRules) routeRules.push({ rule_set: ['geosite-ir', 'geoip-ir'], outbound: 'direct' })
  }
  if (o.redirect) routeRules.push({ inbound: o.redirect.ports.map((_, i) => appsInbound(i)), outbound: 'proxy' })
  if (settings.mode === 'per-app') {
    routeRules.push({ rule_set: ['apps-proxy'], outbound: 'proxy' })
    // Apps pointed at Bridge's local proxy on purpose (e.g. Telegram's proxy setting) want
    // the VPN even when they aren't in the app list. Apps set to Direct / Block still win.
    routeRules.push({ inbound: ['mixed-in'], outbound: 'proxy' })
  }

  const ruleSets: Json[] = APP_ACTIONS.map((action) => ({
    type: 'local',
    tag: `apps-${action}`,
    format: 'source',
    path: appRuleSetPath(o.appRulesDir, action)
  }))
  if (iranRules) {
    ruleSets.push(
      { type: 'local', tag: 'geoip-ir', format: 'binary', path: join(o.rulesDir!, 'geoip-ir.srs') },
      { type: 'local', tag: 'geosite-ir', format: 'binary', path: join(o.rulesDir!, 'geosite-ir.srs') }
    )
  }

  const route: Json = {
    rules: routeRules,
    rule_set: ruleSets,
    final: settings.mode === 'per-app' ? 'direct' : 'proxy',
    default_domain_resolver: 'dns-local',
    find_process: true
  }
  if (o.defaultInterface) route.default_interface = o.defaultInterface
  else route.auto_detect_interface = true

  const experimental: Json = {
    clash_api: { external_controller: `127.0.0.1:${o.clashApi.port}`, secret: o.clashApi.secret }
  }
  // store_fakeip keeps fake IP mappings across reconnects, so apps that cached one keep working.
  if (o.cacheFile) experimental.cache_file = { enabled: true, path: o.cacheFile, store_fakeip: useTun && settings.dnsMode === 'fakeip' }

  return {
    log: { level: settings.logLevel, timestamp: true },
    dns: buildDns(o, useTun, !!iranRules),
    inbounds,
    outbounds: [
      ...serverOutbounds(o.server, o.alternates),
      { type: 'direct', tag: 'direct' },
      // Apps set to "Other VPN" leave through the other tool's adapter, so that tool
      // (e.g. EZConnect) carries them; without one they simply go direct.
      o.otherInterface ? { type: 'direct', tag: 'direct-other', bind_interface: o.otherInterface } : { type: 'direct', tag: 'direct-other' }
    ],
    route,
    experimental
  }
}

/**
 * The VPN server as "proxy". With alternates, "proxy" is a selector over all of them; switching
 * closes only the connections that went through the old server, never Direct ones.
 */
function serverOutbounds(server: ServerProfile, alternates: ServerProfile[] = []): Json[] {
  const others = alternates.filter((s) => s.id !== server.id)
  if (!others.length) return [{ ...normalizeOutbound(server.outbound), tag: 'proxy' }]
  const members = [server, ...others]
  return [
    { type: 'selector', tag: 'proxy', outbounds: members.map((s) => serverTag(s.id)), default: serverTag(server.id), interrupt_exist_connections: true },
    ...members.map((s) => ({ ...normalizeOutbound(s.outbound), tag: serverTag(s.id) }))
  ]
}

/** A plain local SOCKS proxy into one server, nothing else: used to create the WARP account through it. */
export function buildHelperConfig(server: ServerProfile, port: number, clashApi: ClashApi): Json {
  return {
    log: { level: 'warn', timestamp: true },
    dns: { servers: [{ type: 'local', tag: 'dns-local' }] },
    inbounds: [{ type: 'socks', tag: 'helper-in', listen: '127.0.0.1', listen_port: port }],
    outbounds: [{ ...normalizeOutbound(server.outbound), tag: 'proxy' }],
    route: { final: 'proxy', default_domain_resolver: 'dns-local', auto_detect_interface: true },
    experimental: { clash_api: { external_controller: `127.0.0.1:${clashApi.port}`, secret: clashApi.secret } }
  }
}

/**
 * A config with every server as its own outbound and no inbounds, used only to
 * run real latency tests through the Clash API.
 */
export function buildTestConfig(servers: ServerProfile[], clashApi: ClashApi): Json {
  return {
    log: { level: 'warn', timestamp: true },
    dns: { servers: [{ type: 'local', tag: 'dns-local' }] },
    outbounds: [
      { type: 'direct', tag: 'direct' },
      ...servers.map((s) => ({ ...normalizeOutbound(s.outbound), tag: s.id }))
    ],
    // auto_detect_interface keeps the test's traffic off the running VPN's TUN adapter.
    route: { final: 'direct', default_domain_resolver: 'dns-local', auto_detect_interface: true },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${clashApi.port}`, secret: clashApi.secret }
    }
  }
}
