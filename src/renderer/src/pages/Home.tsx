import { useEffect, useState, type ReactNode } from 'react'
import { Activity, AppWindow, ArrowDown, ArrowUp, Copy, Globe, MonitorCog, Plug, Plus, Power, RefreshCw, ShieldAlert, Split, TriangleAlert, Wifi, Zap } from 'lucide-react'
import { AUTO_SERVER, usesTun, type AppRule, type ConnectionMode, type CoreStatus, type HealthCheck, type ServerProfile } from '../../../shared/types'
import { api, connectionSummary, type PageProps } from '../App'
import { ago, bytes, duration, speed } from '../format'
import { cn } from '@/lib/utils'
import { AppIcon, EmptyState, Flag, LatencyPill, RouteBadge, StatusDot } from '@/components/common'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/misc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const MODES: { id: ConnectionMode; label: string; icon: typeof Split; help: string }[] = [
  { id: 'per-app', label: 'Per-App', icon: Split, help: 'Only the apps you pick on the Apps page use the VPN. Everything else uses your normal internet.' },
  { id: 'tun', label: 'Full VPN', icon: Globe, help: 'Every app uses the VPN, except apps you set to Direct, Other VPN or Block.' },
  { id: 'system-proxy', label: 'System Proxy', icon: MonitorCog, help: 'Sets the Windows proxy; browsers and apps that respect it use the VPN. No admin rights needed.' },
  { id: 'proxy-only', label: 'Proxy only', icon: Plug, help: 'Only runs a local SOCKS5 / HTTP proxy. Nothing on the system changes; point apps at it yourself. No admin rights needed.' }
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
              <PowerButton
                status={status}
                disabled={busy || (!running && (!server || needsAdmin))}
                onClick={() => run(() => (running ? api.disconnect() : api.connect()))}
              />
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
                          <Flag code={status.exit.countryCode} className="h-4 w-6 shrink-0" />
                          <span className="font-medium">{status.exit.country}</span>
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
                <ToggleGroup type="single" value={mode.id} onValueChange={(v) => v && run(() => api.updateSettings({ mode: v as ConnectionMode }))} className="grid w-full grid-cols-4 gap-1 p-1 @min-[640px]:grid-cols-2">
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
                <ServerPicker servers={state.servers} subscriptions={state.subscriptions} auto={state.settings.autoServer} selectedId={state.selectedServerId} onChange={(id) => run(() => api.selectServer(id))} onManage={() => go('servers')} />
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
                    <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => run(() => navigator.clipboard.writeText(proxyAddress), () => `Copied ${proxyAddress}`)}>
                      <Copy className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Copy address</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </section>

        {running && status.otherTunnels?.length ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>Another VPN or game tool is active</AlertTitle>
            <AlertDescription>
              {status.otherTunnels.join(', ')}. Bridge keeps its own traffic on your real adapter. Set apps that tool should carry (e.g. Discord for EZConnect) to
              “Other VPN” on the Apps page.
            </AlertDescription>
          </Alert>
        ) : null}

        <HealthCard status={status} run={run} />

        <Card>
          <CardHeader>
            <CardTitle>Apps using the network</CardTitle>
            <CardDescription>Live, since you connected. Route shows where each app's traffic actually went.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {!stats || !stats.apps.length ? (
              <EmptyState icon={Activity} title={running ? 'No traffic yet' : 'Not connected'} description={running ? 'Apps appear here as soon as they open connections.' : 'Connect to see which apps use the network and where their traffic goes.'} />
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
                    <div key={a.path} className={cn('hover:bg-muted/40 grid grid-cols-[1fr_110px_70px_90px_90px] items-center gap-3 border-b px-5 py-2 last:border-0', !a.connections && 'text-muted-foreground')}>
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

function PowerButton({ status, disabled, onClick }: { status: CoreStatus; disabled: boolean; onClick: () => void }) {
  const running = status.state === 'running'
  const busy = status.state === 'starting' || status.state === 'stopping'
  return (
    <div className="relative flex size-72 shrink-0 items-center justify-center">
      {/* Glow behind everything, only while connected. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 rounded-full transition-opacity duration-700',
          'bg-[radial-gradient(circle,oklch(0.705_0.187_48/0.28)_0%,oklch(0.705_0.187_48/0.08)_45%,transparent_70%)]',
          running ? 'opacity-100' : 'opacity-0'
        )}
      />
      {/* Concentric rings. */}
      <span className={cn('absolute size-72 rounded-full border transition-colors duration-700', running ? 'border-primary/15' : 'border-border/50')} />
      <span className={cn('absolute size-62 rounded-full border transition-colors duration-700', running ? 'border-primary/25 animate-pulse' : 'border-border/70')} />
      <span className={cn('absolute size-52 rounded-full border transition-colors duration-700', running ? 'border-primary/40' : 'border-border')} />
      {/* Spinning arc while connecting / disconnecting. */}
      {busy && <span className="border-t-primary border-r-primary/40 absolute size-52 animate-spin rounded-full border-2 border-transparent" />}

      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={running ? 'Disconnect' : 'Connect'}
        className={cn(
          'group relative flex size-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-full transition-all duration-300 outline-none focus-visible:ring-4 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          running
            ? 'from-primary to-[oklch(0.62_0.19_40)] text-primary-foreground animate-halo bg-gradient-to-b'
            : 'bg-card text-muted-foreground hover:text-primary border shadow-[inset_0_2px_10px_oklch(0_0_0/0.5),0_10px_30px_-10px_oklch(0_0_0/0.8)] hover:border-primary/50'
        )}
      >
        <Power className="size-14 transition-transform group-active:scale-90" strokeWidth={2.2} />
        <span className="text-xs font-semibold tracking-[0.18em] uppercase">
          {running ? 'Disconnect' : busy ? (status.state === 'starting' ? 'Connecting' : 'Stopping') : 'Connect'}
        </span>
      </button>
    </div>
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
        <div className="text-muted-foreground truncate text-xs">
          {apps.length ? apps.map((a) => a.name.replace(/\.exe$/i, '')).join(', ') : 'Everything uses your normal internet'}
        </div>
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
  subscriptions,
  auto,
  selectedId,
  onChange,
  onManage
}: {
  servers: ServerProfile[]
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
    ...subscriptions.map((s) => ({ label: s.name || 'Subscription', items: servers.filter((x) => x.subscriptionId === s.id) })),
    { label: 'Manual', items: servers.filter((x) => !x.subscriptionId && !isWarp(x)) }
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
                    <LatencyPill ms={picked.latency} />
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
                  <span className="truncate">{s.name}</span>
                  {isWarp(s) ? (
                    <Badge variant="success">Free</Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="uppercase">
                        {s.protocol}
                      </Badge>
                      {s.engine === 'xray' && <Badge variant="warning">Xray</Badge>}
                      <LatencyPill ms={s.latency} />
                    </>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
    </Select>
  )
}

function HealthCard({ status, run }: { status: CoreStatus; run: PageProps['run'] }) {
  const [checking, setChecking] = useState(false)
  const running = status.state === 'running'
  const h = status.health
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection health</CardTitle>
        <CardDescription>Real requests, every 20 seconds.</CardDescription>
        <CardAction>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!running || checking}
                onClick={async () => {
                  setChecking(true)
                  await run(() => api.checkHealth())
                  setChecking(false)
                }}
              >
                <RefreshCw className={cn(checking && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Check now</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <HealthRow icon={Globe} label="VPN server" check={running ? h?.server : undefined} idle={!running} />
          <HealthRow icon={Wifi} label="Direct internet" check={running ? h?.internet : undefined} idle={!running} />
        </div>
        {running && h?.server?.ok === false && (
          <p className="text-destructive text-xs">The VPN server isn't answering. Apps on VPN are offline; direct apps still work.</p>
        )}
        {running && h?.internet?.ok === false && h?.server?.ok !== false && <p className="text-destructive text-xs">Direct internet isn't answering. Apps set to Direct may be offline.</p>}
      </CardContent>
    </Card>
  )
}

function HealthRow({ icon: Icon, label, check, idle }: { icon: typeof Globe; label: string; check?: HealthCheck; idle: boolean }) {
  const tone = idle ? 'muted' : !check ? 'primary' : check.ok ? 'success' : 'destructive'
  return (
    <div className="bg-muted/30 flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <Icon className="text-muted-foreground size-4" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-muted-foreground truncate text-xs">
          {idle ? 'Connect to check' : !check ? 'Checking…' : check.ok ? `Responding · ${ago(check.checkedAt)}` : check.error}
        </div>
      </div>
      {check?.ok ? <LatencyPill ms={check.latency} /> : <StatusDot tone={tone} pulse={tone === 'primary'} />}
    </div>
  )
}

