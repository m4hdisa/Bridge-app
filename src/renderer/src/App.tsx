import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { AppWindow, ArrowDown, ArrowUp, Download, Gauge, PanelLeftClose, PanelLeftOpen, ScrollText, Server, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState, CoreStatus, LogLine, TrafficStats, UpdateStatus } from '../../shared/types'
import { errorMessage, speed } from './format'
import { cn } from '@/lib/utils'
import { BridgeLogo, CloudflareMark, Flag, StatusDot, type Tone } from '@/components/common'
import { Toaster } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Home } from './pages/Home'
import { Servers } from './pages/Servers'
import { Apps } from './pages/Apps'
import { Logs } from './pages/Logs'
import { SettingsPage } from './pages/Settings'

export const api = window.bridge

export type Page = 'home' | 'servers' | 'apps' | 'logs' | 'settings'

export interface PageProps {
  state: AppState
  status: CoreStatus
  stats?: TrafficStats
  logs: LogLine[]
  update: UpdateStatus
  /** Runs an action; shows its error, or the success message if given, as a toast. */
  run: <T>(fn: () => Promise<T>, success?: (r: T) => string | undefined) => Promise<void>
  go: (page: Page) => void
}

const NAV: { id: Page; label: string; icon: typeof Gauge }[] = [
  { id: 'home', label: 'Dashboard', icon: Gauge },
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'apps', label: 'Apps', icon: AppWindow },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

/** One place that turns core status into what the user sees: a tone and a short label. */
export function connectionSummary(status: CoreStatus): {
  tone: Tone
  label: string
} {
  if (status.state === 'running') {
    if (status.health?.server?.ok === false) return { tone: 'warning', label: 'Server not responding' }
    return { tone: 'success', label: 'Protected' }
  }
  if (status.state === 'starting') return { tone: 'primary', label: 'Connecting…' }
  if (status.state === 'stopping') return { tone: 'primary', label: 'Disconnecting…' }
  return { tone: 'muted', label: 'Not connected' }
}

const COLLAPSED_KEY = 'bridge.sidebarCollapsed'

/** The sidebar's collapsed state, remembered in this window's storage (a convenience only). */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        // Not remembered; it still toggles.
      }
      return !c
    })
  }, [])
  // Ctrl+B, as in editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])
  return [collapsed, toggle]
}

/** In the collapsed sidebar, a label shows as a tooltip to the right instead. */
function SideTip({ show, label, children }: { show: boolean; label: ReactNode; children: ReactElement }) {
  if (!show) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

export function App() {
  const [page, setPage] = useState<Page>('home')
  const [collapsed, toggleCollapsed] = useCollapsed()
  const [state, setState] = useState<AppState>()
  const [status, setStatus] = useState<CoreStatus>({ state: 'stopped' })
  const [stats, setStats] = useState<TrafficStats>()
  const [logs, setLogs] = useState<LogLine[]>([])
  const [update, setUpdate] = useState<UpdateStatus>({
    state: 'idle',
    current: ''
  })

  useEffect(() => {
    void api.getState().then(setState)
    void api.getStatus().then(setStatus)
    void api.getLogs().then(setLogs)
    void api.getUpdate().then(setUpdate)
    const offs = [
      api.onState(setState),
      api.onStatus((s) => {
        setStatus(s)
        if (s.state === 'stopped') setStats(undefined)
        if (s.error) toast.error(s.error)
      }),
      api.onStats(setStats),
      api.onLogs((lines) => setLogs((prev) => [...prev, ...lines].slice(-1000))),
      api.onUpdate(setUpdate)
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const run = useCallback<PageProps['run']>(async (fn, success) => {
    try {
      const r = await fn()
      const msg = success?.(r)
      if (msg) toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [])

  if (!state) return <div className="text-muted-foreground p-10">Loading…</div>

  const props: PageProps = {
    state,
    status,
    stats,
    logs,
    update,
    run,
    go: setPage
  }
  const summary = connectionSummary(status)
  const server = state.servers.find((s) => s.id === (status.serverId ?? state.selectedServerId))

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full">
        <aside className={cn('bg-sidebar border-sidebar-border flex shrink-0 flex-col overflow-hidden border-r py-4 transition-[width] duration-200 ease-out', collapsed ? 'w-16 px-2' : 'w-56 px-3')}>
          <div className={cn('mb-6 flex items-center gap-2.5', collapsed ? 'flex-col px-0' : 'px-2')}>
            <BridgeLogo className="size-8 drop-shadow-[0_4px_14px_color-mix(in_oklch,var(--primary)_40%,transparent)]" />
            {!collapsed && (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="font-semibold tracking-tight">Bridge</div>
                <div className="text-muted-foreground text-[11px]">Per-app VPN</div>
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
                >
                  {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{collapsed ? 'Expand' : 'Collapse'} (Ctrl+B)</TooltipContent>
            </Tooltip>
          </div>

          <nav className="flex flex-col gap-0.5">
            {NAV.map(({ id, label, icon: Icon }) => (
              <SideTip key={id} show={collapsed} label={label}>
                <button
                  onClick={() => setPage(id)}
                  aria-label={label}
                  className={cn(
                    'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-foreground flex h-9 cursor-pointer items-center gap-3 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-2.5',
                    page === id && 'bg-sidebar-accent text-foreground'
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', page === id && 'text-primary')} />
                  {!collapsed && label}
                </button>
              </SideTip>
            ))}
          </nav>

          <div className="mt-auto flex flex-col gap-2">
            <UpdateCard update={update} run={run} collapsed={collapsed} />
            {collapsed ? (
              <SideTip
                show
                label={
                  <span>
                    {summary.label}
                    {server ? ` · ${server.name}` : ''}
                    {status.state === 'running' && stats ? ` · ↓ ${speed(stats.downSpeed)}` : ''}
                  </span>
                }
              >
                <button
                  onClick={() => setPage('home')}
                  aria-label={summary.label}
                  className="bg-card hover:border-primary/40 flex h-11 cursor-pointer items-center justify-center rounded-lg border transition-colors"
                >
                  <StatusDot tone={summary.tone} pulse={summary.tone === 'primary'} />
                </button>
              </SideTip>
            ) : (
              <button onClick={() => setPage('home')} className="bg-card hover:border-primary/40 flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-left transition-colors">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <StatusDot tone={summary.tone} pulse={summary.tone === 'primary'} />
                  {summary.label}
                </div>
                <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                  {status.state === 'running' && status.exit && (server?.engine === 'aether' ? <CloudflareMark className="h-3 w-4" /> : <Flag code={status.exit.countryCode} className="h-3 w-4" />)}
                  <span className="truncate">{status.state === 'running' && status.exit ? `${status.exit.country} · ${server?.name ?? ''}` : server ? server.name : 'No server selected'}</span>
                </div>
                {status.state === 'running' && (
                  <div className="tabular mt-1.5 grid grid-cols-2 gap-2 border-t pt-2 text-xs">
                    <span className="flex items-center gap-1" title="Download speed">
                      <ArrowDown className="text-primary size-3.5" />
                      {stats ? speed(stats.downSpeed) : '—'}
                    </span>
                    <span className="flex items-center gap-1" title="Upload speed">
                      <ArrowUp className="text-muted-foreground size-3.5" />
                      {stats ? speed(stats.upSpeed) : '—'}
                    </span>
                  </div>
                )}
              </button>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-8 py-7">
            {page === 'home' && <Home {...props} />}
            {page === 'servers' && <Servers {...props} />}
            {page === 'apps' && <Apps {...props} />}
            {page === 'logs' && <Logs {...props} />}
            {page === 'settings' && <SettingsPage {...props} />}
          </div>
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  )
}

/** Shown in the sidebar while a new Bridge version is available, downloading or installing. */
function UpdateCard({ update, run, collapsed }: { update: UpdateStatus; run: PageProps['run']; collapsed: boolean }) {
  const u = update.update
  if (!u || !['available', 'downloading', 'installing'].includes(update.state)) return null
  const pct = Math.round((update.progress ?? 0) * 100)
  if (collapsed) {
    const busy = update.state !== 'available'
    return (
      <SideTip show label={busy ? `Updating to Bridge ${u.version}… ${pct}%` : `Bridge ${u.version} is available: install and restart`}>
        <button
          disabled={busy}
          onClick={() => run(() => api.installUpdate())}
          aria-label="Install update"
          className="border-primary/30 bg-primary/8 text-primary relative flex h-10 cursor-pointer items-center justify-center rounded-lg border disabled:cursor-default"
        >
          <Download className={cn('size-4', busy && 'animate-pulse')} />
          <span className="bg-primary absolute top-1.5 right-1.5 size-2 rounded-full" />
        </button>
      </SideTip>
    )
  }
  return (
    <div className="border-primary/30 bg-primary/8 rounded-lg border p-3 text-xs">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Download className="text-primary size-4" />
        Update available
      </div>
      <div className="text-muted-foreground mt-0.5 flex items-center justify-between gap-2">
        <span>Bridge {u.version}</span>
        <button className="hover:text-primary cursor-pointer underline-offset-2 hover:underline" onClick={() => run(() => api.openUpdatePage())}>
          What's new
        </button>
      </div>
      {update.state === 'available' ? (
        <Button size="sm" className="mt-2.5 w-full" onClick={() => run(() => api.installUpdate())}>
          Install and restart
        </Button>
      ) : (
        <>
          <Progress value={pct} className="mt-2.5" />
          <div className="text-muted-foreground tabular mt-1.5">{update.state === 'installing' ? 'Installing, Bridge will reopen…' : `Downloading… ${pct}%`}</div>
        </>
      )}
    </div>
  )
}
