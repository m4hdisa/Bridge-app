import { useCallback, useEffect, useState } from 'react'
import type { AppState, CoreStatus, LogLine, TrafficStats } from '../../shared/types'
import { errorMessage } from './format'
import { Home } from './pages/Home'
import { Servers } from './pages/Servers'
import { Apps } from './pages/Apps'
import { Logs } from './pages/Logs'
import { SettingsPage } from './pages/Settings'

export const api = window.bridge

export interface PageProps {
  state: AppState
  status: CoreStatus
  stats?: TrafficStats
  logs: LogLine[]
  /** Runs an action and shows its error (if any) in the notice bar. */
  run: <T>(fn: () => Promise<T>, success?: (r: T) => string | undefined) => Promise<void>
  go: (page: Page) => void
}

type Page = 'home' | 'servers' | 'apps' | 'logs' | 'settings'

const PAGES: { id: Page; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'servers', label: 'Servers' },
  { id: 'apps', label: 'Apps' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const [page, setPage] = useState<Page>('home')
  const [state, setState] = useState<AppState>()
  const [status, setStatus] = useState<CoreStatus>({ state: 'stopped' })
  const [stats, setStats] = useState<TrafficStats>()
  const [logs, setLogs] = useState<LogLine[]>([])
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string }>()

  useEffect(() => {
    void api.getState().then(setState)
    void api.getStatus().then(setStatus)
    void api.getLogs().then(setLogs)
    const offs = [
      api.onState(setState),
      api.onStatus((s) => {
        setStatus(s)
        if (s.state === 'stopped') setStats(undefined)
        if (s.error) setNotice({ kind: 'error', text: s.error })
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
      if (msg) setNotice({ kind: 'ok', text: msg })
    } catch (e) {
      setNotice({ kind: 'error', text: errorMessage(e) })
    }
  }, [])

  if (!state) return <div className="loading">Loading…</div>

  const props: PageProps = { state, status, stats, logs, run, go: setPage }
  const running = status.state === 'running'
  const serverDown = running && status.health?.server?.ok === false

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          Bridge
        </div>
        {PAGES.map((p) => (
          <button key={p.id} className={'nav-item' + (page === p.id ? ' active' : '')} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
        <div className="sidebar-footer">
          <span className={'dot ' + (serverDown ? 'busy' : running ? 'on' : status.state === 'stopped' ? 'off' : 'busy')} />
          {serverDown
            ? 'Server not responding'
            : running
              ? 'Connected'
              : status.state === 'stopped'
                ? 'Disconnected'
                : status.state === 'starting'
                  ? 'Connecting…'
                  : 'Stopping…'}
        </div>
      </nav>
      <main className="content">
        {notice && (
          <div className={'notice ' + notice.kind}>
            <span>{notice.text}</span>
            <button className="link" onClick={() => setNotice(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        {page === 'home' && <Home {...props} />}
        {page === 'servers' && <Servers {...props} />}
        {page === 'apps' && <Apps {...props} />}
        {page === 'logs' && <Logs {...props} />}
        {page === 'settings' && <SettingsPage {...props} />}
      </main>
    </div>
  )
}
