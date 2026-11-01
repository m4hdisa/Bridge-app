import { useEffect, useId, useState, type ReactNode } from 'react'
import { AppWindow, ArrowRight, ArrowDown, ArrowUp, Copy, Globe, MonitorCog, Plug, Plus, Power, RefreshCw, ShieldAlert, ShieldCheck, Split, TriangleAlert, Wifi, X, Zap } from 'lucide-react'
import { AUTO_SERVER, HEALTH_INTERVAL_MS, usesTun, type AppRule, type ConnectionMode, type CoreStatus, type HealthCheck, type ServerProfile } from '../../../shared/types'
import { api, connectionSummary, type PageProps } from '../App'
import { ago, duration, speed } from '../format'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import { ConnectButton } from '@/components/ConnectButton'
import { AppsTable, busiestApps } from '@/components/AppsTable'
import { AppIcon, CloudflareMark, Flag, LatencyPill, StatusDot } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/misc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const MODES: {
  id: ConnectionMode
  label: string
  icon: typeof Split
  help: string
}[] = [
  {
    id: 'per-app',
    label: 'Per-App',
    icon: Split,
    help: 'Only the apps you pick on the Apps page use the VPN. Everything else uses your normal internet.'
  },
  {
    id: 'tun',
    label: 'Full VPN',
    icon: Globe,
    help: 'Every app uses the VPN, except apps you set to Direct, Other VPN or Block.'
  },
  {
    id: 'system-proxy',
    label: 'System Proxy',
    icon: MonitorCog,
    help: 'Sets the Windows proxy; browsers and apps that respect it use the VPN. No admin rights needed.'
  },
  {
    id: 'proxy-only',
    label: 'Proxy only',
    icon: Plug,
    help: 'Only runs a local SOCKS5 / HTTP proxy. Nothing on the system changes; point apps at it yourself. No admin rights needed.'
  }
]

/** A connecting step from the core (English, sometimes with a number or a method name in it), translated. */
function progressText(text: string): string {
  const trying = text.match(/^Finding a way through your network \(trying (\d+) at once\)$/)
  if (trying) return t('Finding a way through your network (trying {n} at once)', { n: trying[1] })
  const method = text.match(/^Connecting with (.+)$/)
  if (method) return t('Connecting with {method}', { method: t(method[1]) })
  return t(text)
}

/** How many apps the Dashboard lists; the Logs page has them all. */
const TOP_APPS = 5

export function Home({ state, status, stats, run, go }: PageProps) {
  const [admin, setAdmin] = useState(true)
  const [, tick] = useState(0)
  useEffect(() => {
    void api.isAdmin().then(setAdmin)
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const running = status.state === 'running'
  const busy = status.state === 'starting' || status.state === 'stopping'
  const mode = MODES.find((m) => m.id === state.settings.mode)!
  const server = state.servers.find((s) => s.id === state.selectedServerId)
  const viaWarp = state.servers.find((s) => s.id === (status.serverId ?? state.selectedServerId))?.engine === 'aether'
  const needsAdmin = usesTun(state.settings.mode) && !admin
  const proxyAddress = `127.0.0.1:${status.proxyPort ?? state.settings.mixedPort}`
  const summary = connectionSummary(status)

  return (
    <>
      <div className="flex flex-col gap-4">
        {needsAdmin && (
          <Alert variant="primary">
            <ShieldAlert />
            <AlertTitle>{t('{mode} needs administrator rights', { mode: t(mode.label) })}</AlertTitle>
            <AlertDescription>
              <div className="flex w-full flex-wrap items-center justify-between gap-3">
                <span>{t('Bridge creates a network adapter in this mode. Restart Bridge as administrator, or switch to System Proxy / Proxy only.')}</span>
                <Button size="sm" onClick={() => run(() => api.relaunchAsAdmin())}>
                  {t('Restart as admin')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Connection hero, no box: the big power button with the status and key numbers under it
            on the left, the controls on the right. Columns follow the space the page really has (a
            container query), not the window size, and stack when it gets narrow. */}
        <section className="@container pb-2">
          <div className="grid items-center gap-8 @min-[640px]:grid-cols-[20rem_minmax(0,1fr)] @min-[640px]:gap-8">
            <div className="flex min-w-0 flex-col items-center gap-4 text-center">
              <ConnectButton
                state={running ? 'on' : busy ? 'busy' : 'off'}
                label={running ? t('Disconnect') : status.state === 'starting' ? t('Connecting…') : status.state === 'stopping' ? t('Stopping…') : t('Connect')}
                disabled={busy || (!running && (!server || needsAdmin))}
                onClick={() => run(() => (running ? api.disconnect() : api.connect()))}
              />
              <div className="flex w-full min-w-0 flex-col items-center gap-4">
                <div>
                  {/* One line, the dot beside the words: longer labels ("Server not responding") get a smaller size instead of wrapping. */}
                  <div className="flex items-center justify-center gap-2.5 whitespace-nowrap">
                    <StatusDot tone={summary.tone} pulse={busy} />
                    <span className={cn('font-semibold tracking-[-0.025em]', summary.label.length > 14 ? 'text-2xl' : 'text-3xl')}>{summary.label}</span>
                  </div>
                  <div className="text-muted-foreground mt-1.5 max-w-xs text-sm text-balance">
                    {running && status.startedAt ? (
                      <span className="tabular">{t('Connected for {time}', { time: duration(Date.now() - status.startedAt) })}</span>
                    ) : status.state === 'starting' ? (
                      // What connecting is doing now, and for how long: a WARP connect can take a while.
                      <span>
                        {status.progress ? progressText(status.progress) : t('Connecting')}
                        {status.connectingAt && <span className="tabular text-muted-foreground/70"> · {Math.max(0, Math.round((Date.now() - status.connectingAt) / 1000))} s</span>}
                      </span>
                    ) : (
                      <span>{server ? t('Press the button to connect') : t('Add a server to get started')}</span>
                    )}
                  </div>
                </div>
                {running && <ConnectionPanel status={status} viaWarp={viaWarp} down={stats?.downSpeed} up={stats?.upSpeed} />}
              </div>
            </div>

            {/* Controls: one column, each with a small label, read top to bottom. */}
            <div className="mx-auto flex w-full max-w-xl flex-col gap-6 text-start">
              <ControlSection label={t('Mode')}>
                <ToggleGroup
                  type="single"
                  value={mode.id}
                  onValueChange={(v) => v && run(() => api.updateSettings({ mode: v as ConnectionMode }))}
                  className="grid w-full grid-cols-2 gap-1 p-1"
                >
                  {MODES.map(({ id, label, icon: Icon }) => (
                    <ToggleGroupItem key={id} value={id} className="h-9 w-full">
                      <Icon />
                      {t(label)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{t(mode.help)}</p>
              </ControlSection>

              <ControlSection
                label={t('Server')}
                action={
                  <button className="text-muted-foreground hover:text-brand cursor-pointer text-xs font-medium" onClick={() => go('servers')}>
                    {t('Manage servers →')}
                  </button>
                }
              >
                <ServerPicker
                  servers={state.servers}
                  pinging={state.pinging}
                  subscriptions={state.subscriptions}
                  auto={state.settings.autoServer}
                  selectedId={state.selectedServerId}
                  onChange={(id) => run(() => api.selectServer(id))}
                  onManage={() => go('servers')}
                />
              </ControlSection>

              {state.settings.mode === 'per-app' && (
                <ControlSection label={t('Apps on VPN')}>
                  <VpnAppsCard rules={state.appRules} onAdd={() => go('apps')} />
                </ControlSection>
              )}

              <div className="text-muted-foreground flex items-center gap-1.5 border-t pt-4 text-xs">
                <Plug className="size-3.5" />
                <span>{t('Local SOCKS5 / HTTP proxy')}</span>
                <code className="bg-muted text-foreground ms-auto rounded px-1.5 py-0.5 font-mono">{proxyAddress}</code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6"
                      onClick={() =>
                        run(
                          () => navigator.clipboard.writeText(proxyAddress),
                          () => `Copied ${proxyAddress}`
                        )
                      }
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('Copy address')}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </section>

        {status.state === 'stopped' && status.error && <ConnectError error={status.error} onRetry={() => run(() => api.connect())} onLogs={() => go('logs')} />}

        {running && status.otherTunnels?.length ? <OtherTunnelsAlert tunnels={status.otherTunnels} /> : null}

        <HealthCard status={status} run={run} />

        <Card>
          <CardHeader>
            <CardTitle>{t('Apps using the network')}</CardTitle>
            <CardDescription>{t('The busiest ones since you connected, and where their traffic went.')}</CardDescription>
            {(stats?.apps.length ?? 0) > TOP_APPS && (
              <CardAction>
                <Button variant="ghost" size="sm" onClick={() => go('logs', 'apps')}>
                  {t('All {n} apps', { n: stats!.apps.length })}
                  <ArrowRight />
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="px-0">
            <AppsTable apps={stats ? busiestApps(stats.apps).slice(0, TOP_APPS) : undefined} rules={state.appRules} running={running} />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

/** Where traffic exits and how fast it moves, as one panel under the connect button. */
function ConnectionPanel({ status, viaWarp, down, up }: { status: CoreStatus; viaWarp: boolean; down?: number; up?: number }) {
  const exit = status.exit
  return (
    <div className="bg-card/60 w-full max-w-[19rem] overflow-hidden rounded-xl border text-start text-sm shadow-[inset_0_1px_0_oklch(1_0_0/4%)]">
      <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5">
        {exit ? (
          <>
            {viaWarp ? <CloudflareMark className="h-4 w-6" /> : <Flag code={exit.countryCode} className="h-4 w-6 shrink-0" />}
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate font-medium">{viaWarp ? t('Cloudflare WARP') : exit.country}</div>
              <div className="text-muted-foreground truncate text-xs">{viaWarp ? t('Exit in {country}', { country: exit.country }) : (exit.city ?? t('Exit location'))}</div>
            </div>
            <span className="text-muted-foreground font-mono text-xs">{exit.ip}</span>
          </>
        ) : (
          <>
            <Globe className="text-muted-foreground size-4 animate-pulse" />
            <span className="text-muted-foreground">{t('Finding where your traffic exits…')}</span>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 border-t">
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <ArrowDown className="text-brand size-4" />
          <div className="leading-tight">
            <div className="tabular font-medium">{down !== undefined ? speed(down) : '-'}</div>
            <div className="text-muted-foreground text-xs">{t('Download')}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-s px-3.5 py-2.5">
          <ArrowUp className="text-muted-foreground size-4" />
          <div className="leading-tight">
            <div className="tabular font-medium">{up !== undefined ? speed(up) : '-'}</div>
            <div className="text-muted-foreground text-xs">{t('Upload')}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Why the last connect failed, until the next try. */
function ConnectError({ error, onRetry, onLogs }: { error: string; onRetry: () => void; onLogs: () => void }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{t('Couldn\'t connect')}</AlertTitle>
      <AlertDescription>
        <p className="line-clamp-3">{error}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={onRetry}>
            {t('Try again')}
          </Button>
          <Button size="sm" variant="outline" onClick={onLogs}>
            {t('Open logs')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

const DISMISSED_TUNNELS_KEY = 'bridge.dismissedTunnels'

/** The "another VPN is active" note. Closing it hides it until a different set of tools is active. */
function OtherTunnelsAlert({ tunnels }: { tunnels: string[] }) {
  const key = tunnels.join(', ')
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_TUNNELS_KEY) === key
    } catch {
      return false
    }
  })
  if (dismissed) return null
  const close = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_TUNNELS_KEY, key)
    } catch {
      // Hidden for now; it comes back next time.
    }
  }
  return (
    <Alert variant="warning" className="pe-10">
      <TriangleAlert />
      <AlertTitle>{t('Another VPN or game tool is active')}</AlertTitle>
      <AlertDescription>
        {t('{tools}. Bridge keeps its own traffic on your real adapter. Set apps that tool should carry (e.g. Discord for EZConnect) to “Other VPN” on the Apps page.', { tools: key })}
      </AlertDescription>
      <button
        onClick={close}
        aria-label={t('Close')}
        className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-2.5 end-2.5 flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
      >
        <X className="size-4" />
      </button>
    </Alert>
  )
}

function ControlSection({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

/** The apps that use the VPN in Per-App mode: their icons, names, and a way to add more. */
function VpnAppsCard({ rules, onAdd }: { rules: AppRule[]; onAdd: () => void }) {
  const apps = rules.filter((r) => r.enabled && r.action === 'proxy')
  const shown = apps.slice(0, 5)
  const extra = apps.length - shown.length
  return (
    <div className="bg-card/70 flex w-full items-center gap-4 rounded-xl border px-4 py-3 text-start">
      <div className="flex shrink-0 items-center -space-x-2.5">
        {shown.map((a) => (
          <AppIcon key={a.id} src={a.icon} className="ring-card size-9 rounded-lg ring-2" />
        ))}
        {extra > 0 && <span className="bg-muted ring-card text-muted-foreground flex size-9 items-center justify-center rounded-lg text-xs font-medium ring-2">+{extra}</span>}
        {!apps.length && (
          <span className="text-muted-foreground flex size-9 items-center justify-center rounded-lg border border-dashed">
            <AppWindow className="size-4" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{apps.length ? t(apps.length > 1 ? '{n} apps on VPN' : '{n} app on VPN', { n: apps.length }) : t('No apps on VPN yet')}</div>
        <div className="text-muted-foreground truncate text-xs">{apps.length ? apps.map((a) => a.name.replace(/\.exe$/i, '')).join(', ') : t('Everything uses your normal internet')}</div>
      </div>
      <Button size="sm" variant={apps.length ? 'secondary' : 'default'} onClick={onAdd}>
        <Plus />
        {t('Add app')}
      </Button>
    </div>
  )
}

function ServerPicker({
  servers,
  pinging,
  subscriptions,
  auto,
  selectedId,
  onChange,
  onManage
}: {
  servers: ServerProfile[]
  pinging?: string[]
  subscriptions: PageProps['state']['subscriptions']
  /** Auto (best ping) is on; selectedId is then the server it picked. */
  auto: boolean
  selectedId?: string
  onChange: (id: string) => void
  onManage: () => void
}) {
  if (!servers.length) {
    return (
      <Button variant="outline" onClick={onManage} className="w-fit">
        {t('Add a server')}
      </Button>
    )
  }
  const isWarp = (s: ServerProfile) => s.engine === 'aether'
  const groups = [
    { label: t('Free'), items: servers.filter(isWarp) },
    ...subscriptions.map((s) => ({
      label: s.name || t('Subscription'),
      items: servers.filter((x) => x.subscriptionId === s.id)
    })),
    {
      label: t('Manual'),
      items: servers.filter((x) => !x.subscriptionId && !isWarp(x))
    }
  ].filter((g) => g.items.length)
  const picked = servers.find((s) => s.id === selectedId)

  return (
    <Select value={auto ? AUTO_SERVER : selectedId} onValueChange={onChange}>
      <SelectTrigger className="bg-card/70 h-12 w-full rounded-xl px-4">
        <SelectValue placeholder={t('Choose a server')} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={AUTO_SERVER}>
            <span className="flex min-w-0 items-center gap-2">
              <Zap className="text-brand size-4 shrink-0" />
              <span className="font-medium">{t('Auto')}</span>
              {auto && picked ? (
                <>
                  <span className="text-muted-foreground truncate">{picked.name}</span>
                  <LatencyPill ms={picked.latency} pinging={pinging?.includes(picked.id)} />
                </>
              ) : (
                <span className="text-muted-foreground truncate">{t('Best ping, switches if a server fails')}</span>
              )}
            </span>
          </SelectItem>
        </SelectGroup>
        {groups.map((g) => (
          <SelectGroup key={g.label}>
            <SelectLabel>{g.label}</SelectLabel>
            {g.items.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex min-w-0 items-center gap-2">
                  {isWarp(s) && <CloudflareMark className="h-3 w-4" />}
                  <span className="truncate">{s.name}</span>
                  {isWarp(s) ? (
                    <Badge variant="success">{t('Free')}</Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="uppercase">
                        {s.protocol}
                      </Badge>
                      {s.engine === 'xray' && <Badge variant="warning">{t('Xray')}</Badge>}
                      <LatencyPill ms={s.latency} pinging={pinging?.includes(s.id)} />
                    </>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

/** How many checks the charts show (30 at one every 20 s: the last 10 minutes). */
const HISTORY = 30

/** Re-renders every `ms` while `on`, for clocks and "3 s ago" labels. */
function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [on, ms])
  return now
}

interface History {
  at?: number
  items: (number | null)[]
  last?: number
}

/** Chart history outside the component, so it survives leaving the Dashboard and coming back. */
const histories = new Map<string, History>()

/** The last HISTORY results of one check (latency in ms, or null when it failed), reset on each new connection. */
function useHistory(name: string, check: HealthCheck | undefined, connectedAt?: number): (number | null)[] {
  const [history, setHistory] = useState<History>(() => histories.get(name) ?? { items: [] })
  useEffect(() => {
    setHistory((h) => {
      const fresh = h.at === connectedAt ? h : { at: connectedAt, items: [] }
      if (!check || check.checkedAt === fresh.last) return fresh
      const next = {
        at: connectedAt,
        last: check.checkedAt,
        items: [...fresh.items, check.ok ? (check.latency ?? 0) : null].slice(-HISTORY)
      }
      histories.set(name, next)
      return next
    })
  }, [name, check, connectedAt])
  return history.at === connectedAt ? history.items : []
}

type HealthTone = 'idle' | 'checking' | 'good' | 'ok' | 'slow' | 'down'

function healthTone(check: HealthCheck | undefined, running: boolean): HealthTone {
  if (!running) return 'idle'
  if (!check) return 'checking'
  if (!check.ok) return 'down'
  const ms = check.latency ?? 0
  return ms < 300 ? 'good' : ms < 800 ? 'ok' : 'slow'
}

/** Each state's label and color (written out in full so Tailwind generates them); the chart draws in currentColor. */
const TONE: Record<HealthTone, { label: string; text: string }> = {
  idle: { label: 'Not connected', text: 'text-muted-foreground' },
  checking: { label: 'Checking…', text: 'text-brand' },
  good: { label: 'Fast', text: 'text-success' },
  ok: { label: 'Good', text: 'text-warning' },
  slow: { label: 'Slow', text: 'text-destructive' },
  down: { label: 'Not answering', text: 'text-destructive' }
}

function HealthCard({ status, run }: { status: CoreStatus; run: PageProps['run'] }) {
  const [checking, setChecking] = useState(false)
  const running = status.state === 'running'
  const h = status.health
  const now = useNow(running)
  const server = useHistory('server', running ? h?.server : undefined, status.startedAt)
  const internet = useHistory('internet', running ? h?.internet : undefined, status.startedAt)
  const last = Math.max(h?.server?.checkedAt ?? 0, h?.internet?.checkedAt ?? 0)
  // Undefined while a check is due or running: the next result can arrive a moment after the timer.
  const secs = last ? Math.ceil((last + HEALTH_INTERVAL_MS - now) / 1000) : 0
  const left = secs > 0 ? secs : undefined
  const checkNow = async () => {
    setChecking(true)
    await run(() => api.checkHealth())
    setChecking(false)
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Connection health')}</CardTitle>
        <CardDescription>{t('A real request every {n} seconds, through the VPN and around it.', { n: HEALTH_INTERVAL_MS / 1000 })}</CardDescription>
        <CardAction>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                disabled={!running || checking}
                onClick={checkNow}
                className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2 text-xs transition-colors disabled:cursor-default disabled:hover:text-muted-foreground"
              >
                <CountdownRing fraction={running && left !== undefined && !checking ? left / (HEALTH_INTERVAL_MS / 1000) : running ? 1 : 0} spinning={running && (checking || left === undefined)} />
                <span className="tabular">{!running ? t('Paused') : checking || left === undefined ? t('Checking…') : t('Next in {n} s', { n: left })}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{running ? t('Check now') : t('Connect to check')}</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-6 sm:grid-cols-2 sm:gap-0 sm:divide-x">
          <HealthColumn icon={ShieldCheck} label={t('VPN server')} hint={t('Apps on VPN')} check={running ? h?.server : undefined} running={running} history={server} now={now} className="sm:pe-6" />
          <HealthColumn icon={Wifi} label={t('Direct internet')} hint={t('Apps set to Direct')} check={running ? h?.internet : undefined} running={running} history={internet} now={now} className="sm:ps-6" />
        </div>
        {running && h?.server?.ok === false && <p className="text-destructive text-xs">{t('The VPN server isn\'t answering. Apps on VPN are offline; direct apps still work.')}</p>}
        {running && h?.internet?.ok === false && h?.server?.ok !== false && <p className="text-destructive text-xs">{t('Direct internet isn\'t answering. Apps set to Direct may be offline.')}</p>}
      </CardContent>
    </Card>
  )
}

/** A small ring that empties as the next automatic check comes closer. */
function CountdownRing({ fraction, spinning }: { fraction: number; spinning: boolean }) {
  const c = 2 * Math.PI * 6
  return (
    <svg viewBox="0 0 16 16" className={cn('size-3.5 -rotate-90', spinning && 'animate-spin')} aria-hidden>
      <circle cx="8" cy="8" r="6" className="stroke-border fill-none" strokeWidth="2.5" />
      <circle
        cx="8"
        cy="8"
        r="6"
        className="stroke-brand fill-none transition-[stroke-dashoffset] duration-1000 ease-linear"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={spinning ? c * 0.7 : c * (1 - fraction)}
      />
    </svg>
  )
}

function HealthColumn(props: { icon: typeof Globe; label: string; hint: string; check?: HealthCheck; running: boolean; history: (number | null)[]; now: number; className?: string }) {
  // \`now\` only makes this re-render each second, so "3s ago" stays current.
  const { icon: Icon, label, hint, check, running, history, className } = props
  const tone = healthTone(check, running)
  const look = TONE[tone]
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Icon className="text-muted-foreground size-4" />
            {label}
          </div>
          <div className="mt-1 truncate text-xs">
            <span className={cn('font-medium', look.text)}>{t(look.label)}</span>
            <span className="text-muted-foreground"> · {tone === 'idle' ? hint : check ? (check.ok ? ago(check.checkedAt) : check.error) : t('first check')}</span>
          </div>
        </div>
        <div className="shrink-0 text-end leading-none">
          {check?.ok ? (
            <>
              <span className="tabular text-2xl font-semibold tracking-[-0.02em]">{check.latency}</span>
              <span className="text-muted-foreground ms-1 text-xs">{t('ms')}</span>
            </>
          ) : (
            <span className="text-muted-foreground tabular text-2xl font-semibold">-</span>
          )}
        </div>
      </div>
      <LatencyChart history={history} className={look.text} />
    </div>
  )
}

/**
 * The last checks as a line (higher is slower) with a soft fill under it. A failed check breaks
 * the line and leaves a short red mark on the baseline. Newest on the right.
 */
function LatencyChart({ history, className }: { history: (number | null)[]; className?: string }) {
  const id = useId()
  // Spread the first few checks across the chart, then keep the last HISTORY of them.
  const W = Math.max(8, history.length) - 1
  const H = 40
  const max = Math.max(300, ...history.map((v) => v ?? 0)) * 1.15
  const offset = W + 1 - history.length
  const y = (v: number) => H - 2 - (v / max) * (H - 6)
  // Unbroken runs of successful checks, as [x, y] points.
  const runs: [number, number][][] = []
  history.forEach((v, i) => {
    if (v === null) return runs.push([])
    if (!runs.length) runs.push([])
    runs[runs.length - 1].push([offset + i, y(v)])
  })
  const lines = runs.filter((r) => r.length)
  const lastIndex = history.length - 1
  const lastValue = history[lastIndex]
  return (
    <div className={cn('relative h-14', className)} aria-hidden>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
        <defs>
          <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={H} x2={W} y2={H} className="stroke-border" vectorEffect="non-scaling-stroke" />
        {lines.map((pts, k) =>
          pts.length > 1 ? (
            <g key={k}>
              <path d={`M${pts[0][0]} ${H} ${pts.map(([px, py]) => `L${px} ${py}`).join(' ')} L${pts[pts.length - 1][0]} ${H} Z`} fill={`url(#${id}-area)`} />
              <polyline points={pts.map(([px, py]) => `${px},${py}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          ) : (
            // A lone reading between failures: a round dot (a zero-length line with a round cap stays round).
            <line key={k} x1={pts[0][0]} y1={pts[0][1]} x2={pts[0][0] + 0.001} y2={pts[0][1]} stroke="currentColor" strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          )
        )}
        {history.map((v, i) =>
          v === null ? <line key={i} x1={offset + i} y1={H} x2={offset + i} y2={H - 7} className="stroke-destructive" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null
        )}
      </svg>
      {/* The newest reading, as a dot (outside the stretched SVG so it stays round). */}
      {lastValue !== undefined && lastValue !== null && (
        <span
          className="ring-card absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2"
          style={{ left: `${((offset + lastIndex) / W) * 100}%`, top: `${(y(lastValue) / H) * 100}%` }}
        />
      )}
      {!history.length && <span className="text-muted-foreground/60 absolute inset-x-0 bottom-2 text-center text-[11px]">{t('The chart fills in as checks come in')}</span>}
    </div>
  )
}
