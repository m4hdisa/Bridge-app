// Builds sing-box JSON configs (written for sing-box 1.14).
import { join } from 'node:path'
import type { AppRule, ServerProfile, Settings } from '../shared/types'

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
}

type Json = Record<string, unknown>

/** Case-insensitive exact match on a Windows exe path. */
export function processPathRegex(path: string): string {
  return '(?i)^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
}

function appRule(rules: AppRule[], action: AppRule['action']): string[] {
  return rules.filter((r) => r.enabled && r.action === action).map((r) => processPathRegex(r.path))
}

function remoteDnsServer(url: string): Json {
  const u = new URL(url)
  const server: Json = { type: 'https', tag: 'dns-remote', server: u.hostname.replace(/^\[|\]$/g, ''), detour: 'proxy' }
  if (u.port) server.server_port = Number(u.port)
  if (u.pathname && u.pathname !== '/dns-query') server.path = u.pathname
  // A DoH server given by name needs a resolver for its own hostname.
  if (!/^[\d.:]+$/.test(String(server.server))) server.domain_resolver = 'dns-local'
  return server
}

export function buildConfig(o: BuildOptions): Json {
  const { settings, appRules } = o
  const useTun = settings.mode !== 'system-proxy'
  const iranRules = settings.bypassIran && o.rulesDir

  const blockApps = appRule(appRules, 'block')
  const directApps = appRule(appRules, 'direct')
  const proxyApps = appRule(appRules, 'proxy')

  const inbounds: Json[] = [
    { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: settings.mixedPort }
  ]
  if (useTun) {
    inbounds.unshift({
      type: 'tun',
      tag: 'tun-in',
      interface_name: 'Bridge',
      address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
      mtu: 9000,
      auto_route: true,
      strict_route: true,
      stack: 'mixed'
    })
  }

  const dnsRules: Json[] = []
  const routeRules: Json[] = [
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    { ip_is_private: true, outbound: 'direct' }
  ]
  if (blockApps.length) routeRules.push({ process_path_regex: blockApps, action: 'reject' })
  if (directApps.length) routeRules.push({ process_path_regex: directApps, outbound: 'direct' })
  if (settings.bypassIran) {
    dnsRules.push({ domain_suffix: ['.ir'], server: 'dns-local' })
    routeRules.push({ domain_suffix: ['.ir'], outbound: 'direct' })
    if (iranRules) {
      dnsRules.push({ rule_set: ['geosite-ir'], server: 'dns-local' })
      routeRules.push({ rule_set: ['geosite-ir', 'geoip-ir'], outbound: 'direct' })
    }
  }
  if (settings.mode === 'per-app' && proxyApps.length) {
    routeRules.push({ process_path_regex: proxyApps, outbound: 'proxy' })
  }

  const route: Json = {
    rules: routeRules,
    final: settings.mode === 'per-app' ? 'direct' : 'proxy',
    auto_detect_interface: true,
    default_domain_resolver: 'dns-local',
    find_process: blockApps.length + directApps.length + proxyApps.length > 0
  }
  if (iranRules) {
    route.rule_set = [
      { type: 'local', tag: 'geoip-ir', format: 'binary', path: join(o.rulesDir!, 'geoip-ir.srs') },
      { type: 'local', tag: 'geosite-ir', format: 'binary', path: join(o.rulesDir!, 'geosite-ir.srs') }
    ]
  }

  const experimental: Json = {
    clash_api: { external_controller: `127.0.0.1:${o.clashApi.port}`, secret: o.clashApi.secret }
  }
  if (o.cacheFile) experimental.cache_file = { enabled: true, path: o.cacheFile }

  return {
    log: { level: settings.logLevel, timestamp: true },
    dns: {
      servers: [remoteDnsServer(settings.remoteDns), { type: 'local', tag: 'dns-local' }],
      rules: dnsRules,
      final: 'dns-remote',
      strategy: 'ipv4_only'
    },
    inbounds,
    outbounds: [
      { ...o.server.outbound, tag: 'proxy' },
      { type: 'direct', tag: 'direct' }
    ],
    route,
    experimental
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
      ...servers.map((s) => ({ ...s.outbound, tag: s.id }))
    ],
    route: { final: 'direct', default_domain_resolver: 'dns-local' },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${clashApi.port}`, secret: clashApi.secret }
    }
  }
}
