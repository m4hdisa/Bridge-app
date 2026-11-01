import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Download, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { AppWindow, GearSix, GlobeHemisphereWest, Scroll, SquaresFour, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'
import type { AppState, CoreStatus, LogLine, TrafficStats, UpdateStatus } from '../../shared/types'
import { errorMessage, speed } from './format'
import { cn } from '@/lib/utils'
import { isRtl, setLanguage, t } from './i18n'
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
  /** Opens a page; `tab` picks one of its tabs (the Logs page: "apps"). */
  go: (page: Page, tab?: string) => void
  /** The tab the page was opened on, if any. */
  tab?: string
}

/** The sidebar's pages. Phosphor icons: outline normally, filled for the page you're on (Lucide has no filled set). */
const NAV: { id: Page; label: string; icon: PhosphorIcon }[] = [
  { id: 'home', label: 'Dashboard', icon: SquaresFour },
  { id: 'servers', label: 'Servers', icon: GlobeHemisphereWest },
  { id: 'apps', label: 'Apps', icon: AppWindow },
  { id: 'logs', label: 'Logs', icon: Scroll },
  { id: 'settings', label: 'Settings', icon: GearSix }
]

/** One place that turns core status into what the user sees: a tone and a short label. */
export function connectionSummary(status: CoreStatus): {
  tone: Tone
  label: string
} {
  if (status.state === 'running') {
    if (status.health?.server?.ok === false) return { tone: 'warning', label: t('Server not responding') }
    return { tone: 'success', label: t('Protected') }
  }
  if (status.state === 'starting') return { tone: 'primary', label: t('Connecting…') }
  if (status.state === 'stopping') return { tone: 'primary', label: t('Disconnecting…') }
  return { tone: 'muted', label: t('Not connected') }
}

const COLLAPSED_KEY = 'bridge.sidebarCollapsed'

/** The sidebar's collapsed state, remembered in this window's storage (a convenience only). */
/** Below this window width the sidebar collapses on its own, to leave the page room. */
const NARROW = '(max-width: 960px)'

/**
 * The sidebar's collapsed state: the user's choice, remembered in this window's storage (a
 * convenience only), except in a narrow window, where it starts collapsed and can be opened for
 * the moment without changing that choice.
 */
function useCollapsed(): [boolean, () => void] {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches)
  const [narrowOpen, setNarrowOpen] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const onChange = () => {
      setNarrow(mq.matches)
      setNarrowOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = useCallback(() => {
    if (window.matchMedia(NARROW).matches) return setNarrowOpen((o) => !o)
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
  return [narrow ? !narrowOpen : collapsed, toggle]
}

/** In the collapsed sidebar, a label shows as a tooltip to the right instead. */
function SideTip({ show, label, children }: { show: boolean; label: ReactNode; children: ReactElement }) {
  if (!show) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={isRtl() ? 'left' : 'right'}>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Error notifications stay a while, can be closed, and open the log. */
function errorToast(openLogs: () => void) {
  return { duration: 8000, closeButton: true, action: { label: t('Logs'), onClick: openLogs } }
}

export function App() {
  const [page, setPage] = useState<Page>('home')
  const [tab, setTab] = useState<string>()
  // The Dashboard shows a failed connect itself; elsewhere a toast says so.
  const pageRef = useRef(page)
  pageRef.current = page
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
        if (s.error && pageRef.current !== 'home') toast.error(s.error, errorToast(() => setPage('logs')))
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
      toast.error(errorMessage(e), errorToast(() => setPage('logs')))
    }
  }, [])

  if (!state) return <div className="text-muted-foreground p-10">{t('Loading…')}</div>

  setLanguage(state.settings.language ?? 'en')
  const props: PageProps = {
    state,
    status,
    stats,
    logs,
    update,
    run,
    go: (p: Page, t?: string) => {
      setPage(p)
      setTab(t)
    },
    tab
  }
  const summary = connectionSummary(status)
  const server = state.servers.find((s) => s.id === (status.serverId ?? state.selectedServerId))

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full">
        <aside className={cn('bg-sidebar border-sidebar-border flex shrink-0 flex-col overflow-hidden border-e py-4 transition-[width] duration-200 ease-out', collapsed ? 'w-16 px-2' : 'w-56 px-3')}>
          {collapsed ? (
            // Collapsed: just the logo; hovering it turns it into the expand button.
            <div className="mb-6 flex justify-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleCollapsed}
                    aria-label={t('Expand sidebar')}
                    className="group/logo hover:bg-sidebar-accent relative flex size-10 cursor-pointer items-center justify-center rounded-lg transition-colors"
                  >
                    <BridgeLogo className="size-8 transition-opacity duration-150 group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0" />
                    <PanelLeftOpen className="text-foreground absolute size-4 opacity-0 transition-opacity duration-150 group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side={isRtl() ? 'left' : 'right'}>{t('Expand (Ctrl+B)')}</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <div className="mb-6 flex items-center gap-2.5 px-2">
              <BridgeLogo className="size-8 drop-shadow-[0_4px_14px_color-mix(in_oklch,var(--primary)_40%,transparent)]" />
              <div className="min-w-0 flex-1 text-[15px] font-semibold tracking-[-0.02em]">{t('Bridge')}</div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleCollapsed}
                    aria-label={t('Collapse sidebar')}
                    className="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
                  >
                    <PanelLeftClose className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side={isRtl() ? 'left' : 'right'}>{t('Collapse (Ctrl+B)')}</TooltipContent>
              </Tooltip>
            </div>
          )}

          <nav className="flex flex-col gap-1">
            {NAV.map(({ id, label, icon: Icon }) => (
              <SideTip key={id} show={collapsed} label={t(label)}>
                <button
                  onClick={() => props.go(id)}
                  aria-label={t(label)}
                  className={cn(
                    'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-foreground flex h-10 cursor-pointer items-center gap-3 rounded-lg text-sm font-medium whitespace-nowrap transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-3',
                    // The current page: a neutral pill, white text and a filled white icon.
                    page === id && 'bg-sidebar-accent hover:bg-sidebar-accent text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/5%)]'
                  )}
                >
                  <Icon className="size-[19px] shrink-0" weight={page === id ? 'fill' : 'regular'} />
                  {!collapsed && t(label)}
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
                  className="bg-card hover:border-brand/40 flex h-11 cursor-pointer items-center justify-center rounded-lg border transition-colors"
                >
                  <StatusDot tone={summary.tone} pulse={summary.tone === 'primary'} />
                </button>
              </SideTip>
            ) : (
              <button onClick={() => setPage('home')} className="bg-card hover:border-brand/40 flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-start transition-colors">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <StatusDot tone={summary.tone} pulse={summary.tone === 'primary'} />
                  {summary.label}
                </div>
                <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                  {status.state === 'running' && status.exit && (server?.engine === 'aether' ? <CloudflareMark className="h-3 w-4" /> : <Flag code={status.exit.countryCode} className="h-3 w-4" />)}
                  <span className="truncate">{server ? server.name : t('No server selected')}</span>
                </div>
                {status.state === 'running' && (
                  <div className="tabular mt-1.5 grid grid-cols-2 gap-2 border-t pt-2 text-xs">
                    <span className="flex items-center gap-1" title={t('Download speed')}>
                      <ArrowDown className="text-brand size-3.5" />
                      {stats ? speed(stats.downSpeed) : '-'}
                    </span>
                    <span className="flex items-center gap-1" title={t('Upload speed')}>
                      <ArrowUp className="text-muted-foreground size-3.5" />
                      {stats ? speed(stats.upSpeed) : '-'}
                    </span>
                  </div>
                )}
              </button>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div key={page} className="animate-page-in mx-auto max-w-5xl px-8 pt-5 pb-7">
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
      <SideTip show label={busy ? t('Updating to Bridge {version}… {pct}%', { version: u.version, pct }) : t('Bridge {version} is available: install and restart', { version: u.version })}>
        <button
          disabled={busy}
          onClick={() => run(() => api.installUpdate())}
          aria-label={t('Install update')}
          className="border-brand/30 bg-primary/8 text-brand relative flex h-10 cursor-pointer items-center justify-center rounded-lg border disabled:cursor-default"
        >
          <Download className={cn('size-4', busy && 'animate-pulse')} />
          <span className="bg-primary absolute top-1.5 end-1.5 size-2 rounded-full" />
        </button>
      </SideTip>
    )
  }
  return (
    <div className="border-brand/30 bg-primary/8 rounded-lg border p-3 text-xs">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Download className="text-brand size-4" />
        {t('Update available')}
      </div>
      <div className="text-muted-foreground mt-0.5 flex items-center justify-between gap-2">
        <span>{t('Bridge')}{" "}{u.version}</span>
        <button className="hover:text-brand cursor-pointer underline-offset-2 hover:underline" onClick={() => run(() => api.openUpdatePage())}>
          {t('What\'s new')}
        </button>
      </div>
      {update.state === 'available' ? (
        <Button size="sm" className="mt-2.5 w-full" onClick={() => run(() => api.installUpdate())}>
          {t('Install and restart')}
        </Button>
      ) : (
        <>
          <Progress value={pct} className="mt-2.5" />
          <div className="text-muted-foreground tabular mt-1.5">{update.state === 'installing' ? t('Installing, Bridge will reopen…') : `Downloading… ${pct}%`}</div>
        </>
      )}
    </div>
  )
}
