import { useCallback, useEffect, useState } from 'react'
import { AppWindow, ArrowDown, ArrowUp, Gauge, ScrollText, Server, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { AppState, CoreStatus, LogLine, TrafficStats } from '../../shared/types'
import { errorMessage, speed } from './format'
import { cn } from '@/lib/utils'
import { Flag, StatusDot, type Tone } from '@/components/common'
import { Toaster } from '@/components/ui/misc'
import { TooltipProvider } from '@/components/ui/tooltip'
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
export function connectionSummary(status: CoreStatus): { tone: Tone; label: string } {
  if (status.state === 'running') {
    if (status.health?.server?.ok === false) return { tone: 'warning', label: 'Server not responding' }
    return { tone: 'success', label: 'Protected' }
  }
  if (status.state === 'starting') return { tone: 'primary', label: 'Connecting…' }
  if (status.state === 'stopping') return { tone: 'primary', label: 'Disconnecting…' }
  return { tone: 'muted', label: 'Not connected' }
}

export function App() {
  const [page, setPage] = useState<Page>('home')
  const [state, setState] = useState<AppState>()
  const [status, setStatus] = useState<CoreStatus>({ state: 'stopped' })
  const [stats, setStats] = useState<TrafficStats>()
  const [logs, setLogs] = useState<LogLine[]>([])

  useEffect(() => {
    void api.getState().then(setState)
    void api.getStatus().then(setStatus)
    void api.getLogs().then(setLogs)
    const offs = [
      api.onState(setState),
      api.onStatus((s) => {
        setStatus(s)
        if (s.state === 'stopped') setStats(undefined)
        if (s.error) toast.error(s.error)
      }),
      api.onStats(setStats),
      api.onLog((l) => setLogs((prev) => [...prev.slice(-999), l]))
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

  const props: PageProps = { state, status, stats, logs, run, go: setPage }
  const summary = connectionSummary(status)
  const server = state.servers.find((s) => s.id === (status.serverId ?? state.selectedServerId))

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full">
        <aside className="bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col border-r px-3 py-4">
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg shadow-[0_0_24px_-4px] shadow-primary/60">
              <BridgeMark className="size-5" />
            </span>
            <div className="leading-tight">
              <div className="font-semibold tracking-tight">Bridge</div>
              <div className="text-muted-foreground text-[11px]">Per-app VPN</div>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={cn(
                  'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-foreground flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors',
                  page === id && 'bg-sidebar-accent text-foreground'
                )}
              >
                <Icon className={cn('size-4', page === id && 'text-primary')} />
                {label}
              </button>
            ))}
          </nav>

          <button
            onClick={() => setPage('home')}
            className="bg-card hover:border-primary/40 mt-auto flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-left transition-colors"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusDot tone={summary.tone} pulse={summary.tone === 'primary'} />
              {summary.label}
            </div>
            <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              {status.state === 'running' && status.exit && <Flag code={status.exit.countryCode} className="h-3 w-4" />}
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

/** The Bridge logo: an arch over a deck. */
export function BridgeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className={className}>
      <path d="M4 16a8 8 0 0 1 16 0" />
      <path d="M2.5 16h19" />
    </svg>
  )
}
