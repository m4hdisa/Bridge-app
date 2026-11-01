import { useEffect, useState, type ReactNode } from 'react'
import { Activity, AppWindow, ArrowDown, ArrowUp, Copy, Globe, MonitorCog, Plug, Plus, Power, RefreshCw, ShieldAlert, ShieldCheck, Split, TriangleAlert, Wifi, X, Zap } from 'lucide-react'
import { AUTO_SERVER, HEALTH_INTERVAL_MS, usesTun, type AppRule, type ConnectionMode, type CoreStatus, type HealthCheck, type ServerProfile } from '../../../shared/types'
import { api, connectionSummary, type PageProps } from '../App'
import { ago, bytes, duration, speed } from '../format'
import { SHIELD_PATH } from '../../../shared/logo'
import { cn } from '@/lib/utils'
import { AppIcon, CloudflareMark, EmptyState, Flag, LatencyPill, RouteBadge, StatusDot } from '@/components/common'
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

export function Home({ state, status, stats, run, go }: PageProps) {
  const [admin, setAdmin] = useState(true)
  const [, tick] = useState(0)
  useEffect(() => {
    void api.isAdmin().then(setAdmin)
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
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
            <AlertTitle>{mode.label} needs administrator rights</AlertTitle>
            <AlertDescription>
              <div className="flex w-full flex-wrap items-center justify-between gap-3">
                <span>Bridge creates a network adapter in this mode. Restart Bridge as administrator, or switch to System Proxy / Proxy only.</span>
                <Button size="sm" onClick={() => run(() => api.relaunchAsAdmin())}>
                  Restart as admin
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Connection hero, no box: the big power button with the status and key numbers under it
            on the left, the controls on the right. Columns follow the space the page really has (a
            container query), not the window size, and stack when it gets narrow. */}
        <section className="@container pt-4 pb-4">
          <div className="grid items-center gap-8 @min-[640px]:grid-cols-[20rem_minmax(0,1fr)] @min-[640px]:gap-8">
            <div className="flex min-w-0 flex-col items-center gap-4 text-center">
              <PowerButton status={status} disabled={busy || (!running && (!server || needsAdmin))} onClick={() => run(() => (running ? api.disconnect() : api.connect()))} />
              <div className="w-full min-w-0">
                <div className="flex items-center justify-center gap-2.5">
                  <StatusDot tone={summary.tone} pulse={busy} />
                  <span className="text-3xl font-semibold tracking-tight">{summary.label}</span>
                </div>
                <div className="text-muted-foreground mt-1.5 text-sm">
                  {running && status.startedAt ? (
                    <span className="tabular">Connected for {duration(Date.now() - status.startedAt)}</span>
                  ) : (
                    <span>{server ? 'Press the button to connect' : 'Add a server to get started'}</span>
                  )}
                </div>
                {running && (
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <div className="bg-card/70 flex w-fit max-w-full items-center gap-2.5 rounded-full border py-1.5 pr-4 pl-2.5 text-sm whitespace-nowrap">
                      {status.exit ? (
                        <>
                          {viaWarp ? (
                            <>
                              <CloudflareMark className="h-4 w-6" />
                              <span className="font-medium">Cloudflare</span>
                              <span className="text-muted-foreground">{status.exit.country}</span>
                            </>
                          ) : (
                            <>
                              <Flag code={status.exit.countryCode} className="h-4 w-6 shrink-0" />
                              <span className="font-medium">{status.exit.country}</span>
                            </>
                          )}
                          {status.exit.city && <span className="text-muted-foreground min-w-0 truncate">{status.exit.city}</span>}
                          <span className="text-muted-foreground font-mono text-xs">{status.exit.ip}</span>
                        </>
                      ) : (
                        <>
                          <Globe className="text-muted-foreground size-4 animate-pulse" />
                          <span className="text-muted-foreground">Finding your VPN location…</span>
                        </>
                      )}
                    </div>
                    <div className="bg-card/70 tabular flex items-center gap-3 rounded-full border px-3.5 py-1.5 text-sm whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <ArrowDown className="text-primary size-3.5" />
                        {stats ? speed(stats.downSpeed) : '—'}
                      </span>
                      <span className="text-muted-foreground flex items-center gap-1">
                        <ArrowUp className="size-3.5" />
                        {stats ? speed(stats.upSpeed) : '—'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Controls: one column, each with a small label, read top to bottom. */}
            <div className="mx-auto flex w-full max-w-xl flex-col gap-6 text-left">
              <ControlSection label="Mode">
                <ToggleGroup
                  type="single"
                  value={mode.id}
                  onValueChange={(v) => v && run(() => api.updateSettings({ mode: v as ConnectionMode }))}
                  className="grid w-full grid-cols-4 gap-1 p-1 @min-[640px]:grid-cols-2"
                >
                  {MODES.map(({ id, label, icon: Icon }) => (
                    <ToggleGroupItem key={id} value={id} className="h-9 w-full">
                      <Icon />
                      {label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{mode.help}</p>
              </ControlSection>

              <ControlSection
                label="Server"
                action={
                  <button className="text-muted-foreground hover:text-primary cursor-pointer text-xs font-medium" onClick={() => go('servers')}>
                    Manage servers →
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
                <ControlSection label="Apps on VPN">
                  <VpnAppsCard rules={state.appRules} onAdd={() => go('apps')} />
                </ControlSection>
              )}

              <div className="text-muted-foreground flex items-center gap-1.5 border-t pt-4 text-xs">
                <Plug className="size-3.5" />
                <span>Local SOCKS5 / HTTP proxy</span>
                <code className="bg-muted text-foreground ml-auto rounded px-1.5 py-0.5 font-mono">{proxyAddress}</code>
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
                  <TooltipContent>Copy address</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </section>

        {running && status.otherTunnels?.length ? <OtherTunnelsAlert tunnels={status.otherTunnels} /> : null}

        <HealthCard status={status} run={run} />

        <Card>
          <CardHeader>
            <CardTitle>Apps using the network</CardTitle>
            <CardDescription>Live, since you connected. Route shows where each app's traffic actually went.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {!stats || !stats.apps.length ? (
              <EmptyState
                icon={Activity}
                title={running ? 'No traffic yet' : 'Not connected'}
                description={running ? 'Apps appear here as soon as they open connections.' : 'Connect to see which apps use the network and where their traffic goes.'}
              />
            ) : (
              <div className="text-sm">
                <div className="text-muted-foreground grid grid-cols-[1fr_110px_70px_90px_90px] gap-3 border-b px-5 pb-2 text-xs font-medium">
                  <span>App</span>
                  <span>Route</span>
                  <span className="text-right">Open</span>
                  <span className="text-right">Down</span>
                  <span className="text-right">Up</span>
                </div>
                {stats.apps.map((a) => {
                  const icon = state.appRules.find((r) => r.path.toLowerCase() === a.path.toLowerCase())?.icon
                  return (
                    <div
                      key={a.path}
                      className={cn('hover:bg-muted/40 grid grid-cols-[1fr_110px_70px_90px_90px] items-center gap-3 border-b px-5 py-2 last:border-0', !a.connections && 'text-muted-foreground')}
                    >
                      <span className="flex min-w-0 items-center gap-2.5" title={a.path}>
                        <AppIcon src={icon} className="size-6" />
                        <span className="truncate">{a.name}</span>
                      </span>
                      <span>
                        <RouteBadge route={a.route} />
                      </span>
                      <span className="tabular text-right">{a.connections}</span>
                      <span className="tabular text-right">{bytes(a.download)}</span>
                      <span className="tabular text-right">{bytes(a.upload)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

/** The logo's shield (100 × 120 box, centred on (50, 60)). */
const SHIELD = SHIELD_PATH
/** The same shield grown around its centre, for the outlines that ripple out behind the button. */
const shieldAt = (scale: number) => `translate(50 60) scale(${scale}) translate(-50 -60)`

function PowerButton({ status, disabled, onClick }: { status: CoreStatus; disabled: boolean; onClick: () => void }) {
  const running = status.state === 'running'
  const busy = status.state === 'starting' || status.state === 'stopping'
  return (
    <div className="relative flex h-80 w-72 shrink-0 items-center justify-center">
      {/* Glow behind everything, only while connected. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 transition-opacity duration-700',
          'bg-[radial-gradient(ellipse_at_center,color-mix(in_oklch,var(--primary)_26%,transparent)_0%,color-mix(in_oklch,var(--primary)_7%,transparent)_45%,transparent_70%)]',
          running ? 'opacity-100' : 'opacity-0'
        )}
      />
      {/* Shield outlines rippling out, like rings. */}
      <svg viewBox="0 0 100 120" className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
        {[
          [1.62, running ? 'stroke-primary/15' : 'stroke-border/50'],
          [1.42, running ? 'stroke-primary/25 animate-pulse' : 'stroke-border/70'],
          [1.22, running ? 'stroke-primary/40' : 'stroke-border']
        ].map(([scale, tone]) => (
          <path
            key={scale}
            d={SHIELD}
            transform={shieldAt(Number(scale) * 0.62)}
            vectorEffect="non-scaling-stroke"
            className={cn('fill-none stroke-1 transition-colors duration-700', tone as string)}
          />
        ))}
      </svg>

      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={running ? 'Disconnect' : 'Connect'}
        className="group relative flex h-56 w-[11.7rem] cursor-pointer flex-col items-center justify-center gap-2 pb-5 outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg
          viewBox="0 0 100 120"
          className={cn('absolute inset-0 size-full overflow-visible transition-[filter] duration-500', running ? 'animate-shield-glow' : 'drop-shadow-[0_12px_24px_oklch(0_0_0/0.55)]')}
          aria-hidden
        >
          <defs>
            <linearGradient id="shield-on" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" />
              <stop offset="100%" stopColor="var(--primary-deep)" />
            </linearGradient>
            <linearGradient id="shield-shine" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="white" stopOpacity="0.28" />
              <stop offset="55%" stopColor="white" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={SHIELD}
            vectorEffect="non-scaling-stroke"
            fill={running ? 'url(#shield-on)' : undefined}
            className={cn(
              'transition-colors duration-300',
              running ? 'stroke-primary/60 stroke-1' : 'fill-card stroke-border group-hover:stroke-primary/60 group-focus-visible:stroke-primary stroke-[1.5]'
            )}
          />
          {/* A soft highlight on the upper half, so the shield reads as raised. */}
          <path d={SHIELD} fill="url(#shield-shine)" className={cn('transition-opacity duration-500', running ? 'opacity-100' : 'opacity-25')} />
          {/* A bright segment running around the edge while connecting / disconnecting. */}
          {busy && <path d={SHIELD} pathLength={100} vectorEffect="non-scaling-stroke" className="stroke-primary animate-shield-trace fill-none stroke-[3]" strokeLinecap="round" />}
        </svg>
        <Power
          className={cn('relative size-14 transition-[transform,color] duration-300 group-active:scale-90', running ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-primary')}
          strokeWidth={2.2}
        />
        <span className={cn('relative text-xs font-semibold tracking-[0.18em] uppercase transition-colors', running ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-primary')}>
          {running ? 'Disconnect' : busy ? (status.state === 'starting' ? 'Connecting' : 'Stopping') : 'Connect'}
        </span>
      </button>
    </div>
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
    <Alert variant="warning" className="pr-10">
      <TriangleAlert />
      <AlertTitle>Another VPN or game tool is active</AlertTitle>
      <AlertDescription>
        {key}. Bridge keeps its own traffic on your real adapter. Set apps that tool should carry (e.g. Discord for EZConnect) to “Other VPN” on the Apps page.
      </AlertDescription>
      <button
        onClick={close}
        aria-label="Close"
        className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-2.5 right-2.5 flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
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
        <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">{label}</span>
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
    <div className="bg-card/70 flex w-full items-center gap-4 rounded-xl border px-4 py-3 text-left">
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
        <div className="text-sm font-medium">{apps.length ? `${apps.length} app${apps.length > 1 ? 's' : ''} on VPN` : 'No apps on VPN yet'}</div>
        <div className="text-muted-foreground truncate text-xs">{apps.length ? apps.map((a) => a.name.replace(/\.exe$/i, '')).join(', ') : 'Everything uses your normal internet'}</div>
      </div>
      <Button size="sm" variant={apps.length ? 'secondary' : 'default'} onClick={onAdd}>
        <Plus />
        Add app
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
        Add a server
      </Button>
    )
  }
  const isWarp = (s: ServerProfile) => s.engine === 'aether'
  const groups = [
    { label: 'Free', items: servers.filter(isWarp) },
    ...subscriptions.map((s) => ({
      label: s.name || 'Subscription',
      items: servers.filter((x) => x.subscriptionId === s.id)
    })),
    {
      label: 'Manual',
      items: servers.filter((x) => !x.subscriptionId && !isWarp(x))
    }
  ].filter((g) => g.items.length)
  const picked = servers.find((s) => s.id === selectedId)

  return (
    <Select value={auto ? AUTO_SERVER : selectedId} onValueChange={onChange}>
      <SelectTrigger className="bg-card/70 h-12 w-full rounded-xl px-4">
        <SelectValue placeholder="Choose a server" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={AUTO_SERVER}>
            <span className="flex min-w-0 items-center gap-2">
              <Zap className="text-primary size-4 shrink-0" />
              <span className="font-medium">Auto</span>
              {auto && picked ? (
                <>
                  <span className="text-muted-foreground truncate">{picked.name}</span>
                  <LatencyPill ms={picked.latency} pinging={pinging?.includes(picked.id)} />
                </>
              ) : (
                <span className="text-muted-foreground truncate">Best ping, switches if a server fails</span>
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
                    <Badge variant="success">Free</Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="uppercase">
                        {s.protocol}
                      </Badge>
                      {s.engine === 'xray' && <Badge variant="warning">Xray</Badge>}
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

/** How many checks the sparklines remember. */
const HISTORY = 16

/** Re-renders every `ms` while `on`, for clocks and "3 s ago" labels. */
function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}

/** The last HISTORY results of one check (latency in ms, or null when it failed), reset on each new connection. */
function useHistory(check: HealthCheck | undefined, connectedAt?: number): (number | null)[] {
  const [history, setHistory] = useState<{
    at?: number
    items: (number | null)[]
    last?: number
  }>({ items: [] })
  useEffect(() => {
    setHistory((h) => {
      const fresh = h.at === connectedAt ? h : { at: connectedAt, items: [] }
      if (!check || check.checkedAt === fresh.last) return fresh
      return {
        at: connectedAt,
        last: check.checkedAt,
        items: [...fresh.items, check.ok ? (check.latency ?? 0) : null].slice(-HISTORY)
      }
    })
  }, [check, connectedAt])
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

/** Each state's colors, written out in full so Tailwind generates them. */
const TONE: Record<
  HealthTone,
  {
    label: string
    text: string
    stroke: string
    fill: string
    bar: string
    glow: string
  }
> = {
  idle: {
    label: 'Not connected',
    text: 'text-muted-foreground',
    stroke: 'stroke-muted-foreground',
    fill: 'fill-muted-foreground',
    bar: 'bg-muted-foreground/40',
    glow: 'from-muted/40'
  },
  checking: {
    label: 'Checking…',
    text: 'text-primary',
    stroke: 'stroke-primary',
    fill: 'fill-primary',
    bar: 'bg-primary',
    glow: 'from-primary/14'
  },
  good: {
    label: 'Fast',
    text: 'text-success',
    stroke: 'stroke-success',
    fill: 'fill-success',
    bar: 'bg-success',
    glow: 'from-success/12'
  },
  ok: {
    label: 'Good',
    text: 'text-warning',
    stroke: 'stroke-warning',
    fill: 'fill-warning',
    bar: 'bg-warning',
    glow: 'from-warning/12'
  },
  slow: {
    label: 'Slow',
    text: 'text-destructive',
    stroke: 'stroke-destructive',
    fill: 'fill-destructive',
    bar: 'bg-destructive',
    glow: 'from-destructive/12'
  },
  down: {
    label: 'Not answering',
    text: 'text-destructive',
    stroke: 'stroke-destructive',
    fill: 'fill-destructive',
    bar: 'bg-destructive',
    glow: 'from-destructive/16'
  }
}

function HealthCard({ status, run }: { status: CoreStatus; run: PageProps['run'] }) {
  const [checking, setChecking] = useState(false)
  const running = status.state === 'running'
  const h = status.health
  const now = useNow(running)
  const server = useHistory(running ? h?.server : undefined, status.startedAt)
  const internet = useHistory(running ? h?.internet : undefined, status.startedAt)
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
        <CardTitle>Connection health</CardTitle>
        <CardDescription>Real requests, checked on their own every {HEALTH_INTERVAL_MS / 1000} seconds.</CardDescription>
        <CardAction>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                disabled={!running || checking}
                onClick={checkNow}
                className="hover:bg-accent text-muted-foreground flex cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:hover:bg-transparent"
              >
                <CountdownRing fraction={running && left !== undefined && !checking ? left / (HEALTH_INTERVAL_MS / 1000) : running ? 1 : 0} spinning={running && (checking || left === undefined)} />
                <span className="tabular">{!running ? 'Paused' : checking || left === undefined ? 'Checking…' : `Next in ${left} s`}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{running ? 'Check now' : 'Connect to check'}</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <HealthTile icon={ShieldCheck} label="VPN server" hint="Apps on VPN" check={running ? h?.server : undefined} running={running} history={server} now={now} />
        <HealthTile icon={Wifi} label="Direct internet" hint="Apps set to Direct" check={running ? h?.internet : undefined} running={running} history={internet} now={now} />
        {running && h?.server?.ok === false && <p className="text-destructive text-xs sm:col-span-2">The VPN server isn't answering. Apps on VPN are offline; direct apps still work.</p>}
        {running && h?.internet?.ok === false && h?.server?.ok !== false && (
          <p className="text-destructive text-xs sm:col-span-2">Direct internet isn't answering. Apps set to Direct may be offline.</p>
        )}
      </CardContent>
    </Card>
  )
}

/** A small ring that empties as the next automatic check comes closer. */
function CountdownRing({ fraction, spinning }: { fraction: number; spinning: boolean }) {
  const c = 2 * Math.PI * 6
  return (
    <svg viewBox="0 0 16 16" className={cn('size-4 -rotate-90', spinning && 'animate-spin')} aria-hidden>
      <circle cx="8" cy="8" r="6" className="stroke-border fill-none" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        className="stroke-primary fill-none transition-[stroke-dashoffset] duration-1000 ease-linear"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={spinning ? c * 0.7 : c * (1 - fraction)}
      />
    </svg>
  )
}

function HealthTile(props: { icon: typeof Globe; label: string; hint: string; check?: HealthCheck; running: boolean; history: (number | null)[]; now: number }) {
  // `now` only makes this re-render each second, so "3 s ago" stays current.
  const { icon: Icon, label, hint, check, running, history } = props
  const tone = healthTone(check, running)
  const t = TONE[tone]
  return (
    <div className={cn('relative flex min-h-40 flex-col overflow-hidden rounded-xl border bg-gradient-to-br to-transparent p-4 transition-colors duration-500', t.glow)}>
      <RadarIllustration icon={Icon} tone={tone} />
      <div className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">{label}</div>
      <div className="mt-2 flex items-baseline gap-1">
        {tone === 'idle' || tone === 'checking' ? (
          <span className="text-muted-foreground text-3xl font-semibold">—</span>
        ) : tone === 'down' ? (
          <span className="text-destructive text-2xl font-semibold">Offline</span>
        ) : (
          <>
            <span className="tabular text-3xl font-semibold tracking-tight">{check?.latency}</span>
            <span className="text-muted-foreground text-sm">ms</span>
          </>
        )}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
        <span className={cn('font-medium', t.text)}>{t.label}</span>
        <span className="text-muted-foreground truncate">{tone === 'idle' ? `· ${hint}` : check ? `· ${check.ok ? ago(check.checkedAt) : check.error}` : ''}</span>
      </div>
      <Sparkline history={history} tone={tone} />
    </div>
  )
}

/** Concentric rings around the tile's icon, like a radar; they ripple while a check runs. */
function RadarIllustration({ icon: Icon, tone }: { icon: typeof Globe; tone: HealthTone }) {
  const t = TONE[tone]
  const live = tone !== 'idle'
  return (
    <div className="pointer-events-none absolute -top-6 -right-6 size-32" aria-hidden>
      <svg viewBox="0 0 128 128" className="absolute inset-0 size-full">
        {[58, 44, 30].map((r, i) => (
          <circle key={r} cx="64" cy="64" r={r} className={cn('fill-none transition-colors duration-500', t.stroke)} strokeWidth="1" strokeOpacity={0.14 + i * 0.1} />
        ))}
        {tone === 'checking' && <circle cx="64" cy="64" r="30" className={cn('animate-radar fill-none', t.stroke)} strokeWidth="1.5" />}
        <circle cx="64" cy="64" r="19" className={cn('transition-colors duration-500', t.fill)} fillOpacity={live ? 0.16 : 0.08} />
      </svg>
      <Icon className={cn('absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 transition-colors duration-500', t.text)} />
    </div>
  )
}

/** The last checks as bars: taller is slower, a short red bar is a failure, faint ones are still to come. */
function Sparkline({ history, tone }: { history: (number | null)[]; tone: HealthTone }) {
  const max = Math.max(300, ...history.map((v) => v ?? 0))
  const slots = Array.from({ length: HISTORY }, (_, i) => history[i - (HISTORY - history.length)])
  return (
    <div className="mt-auto flex h-9 items-end gap-1 pt-3" aria-hidden>
      {slots.map((v, i) => (
        <span
          key={i}
          className={cn(
            'flex-1 rounded-sm transition-[height] duration-500',
            v === undefined ? 'bg-muted-foreground/12' : v === null ? 'bg-destructive' : i === HISTORY - 1 ? TONE[tone].bar : 'bg-muted-foreground/35'
          )}
          style={{
            height: v === undefined ? '18%' : v === null ? '22%' : `${Math.max(14, (v / max) * 100)}%`
          }}
        />
      ))}
    </div>
  )
}
