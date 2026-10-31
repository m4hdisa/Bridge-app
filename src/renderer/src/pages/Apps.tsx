import { useState } from 'react'
import type { AppAction, AppRule, RunningProcess } from '../../../shared/types'
import { api, type PageProps } from '../App'

const ACTIONS: { id: AppAction; label: string }[] = [
  { id: 'proxy', label: 'Use VPN' },
  { id: 'direct', label: 'Direct' },
  { id: 'block', label: 'Block' }
]

function newRule(p: RunningProcess, action: AppAction): AppRule {
  return { id: crypto.randomUUID(), name: p.name, path: p.path, icon: p.icon, action, enabled: true }
}

export function Apps({ state, run }: PageProps) {
  const [picker, setPicker] = useState<RunningProcess[]>()
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const mode = state.settings.mode
  // Adding an app usually means "send it through the VPN". Only in Full VPN mode
  // (where everything already uses the VPN) does adding an app mean excluding it.
  const defaultAction: AppAction = mode === 'tun' ? 'direct' : 'proxy'
  const ruled = new Set(state.appRules.map((r) => r.path.toLowerCase()))

  const openPicker = async () => {
    setLoading(true)
    await run(async () => setPicker(await api.listProcesses()))
    setLoading(false)
  }

  const shown = (picker || []).filter((p) => !ruled.has(p.path.toLowerCase()) && (p.name + p.path).toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="page">
      <div className="page-head">
        <h1>Apps</h1>
        <div className="actions">
          <button onClick={openPicker} disabled={loading}>{loading ? 'Loading…' : 'Add running app'}</button>
          <button
            onClick={() =>
              run(async () => {
                const p = await api.pickExe()
                if (p) await api.saveAppRule(newRule(p, defaultAction))
              })
            }
          >
            Browse for .exe
          </button>
        </div>
      </div>

      <p className="muted">
        {mode === 'per-app' && 'Per-App mode: only apps set to "Use VPN" go through the VPN. Everything else is direct.'}
        {mode === 'tun' && 'Full VPN mode: every app uses the VPN, except apps set to "Direct" or "Block".'}
        {mode === 'system-proxy' && 'System Proxy mode: "Direct" and "Block" apply to apps that use the system proxy. Switch to Per-App for full control.'}
      </p>

      {picker && (
        <div className="card">
          <div className="row">
            <h2 className="grow">Running apps</h2>
            <button className="link" onClick={() => setPicker(undefined)}>Close</button>
          </div>
          <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          <div className="picker">
            {shown.map((p) => (
              <div key={p.path} className="row">
                <AppIcon src={p.icon} />
                <div className="grow">
                  <strong>{p.name}</strong>
                  <div className="muted small ellipsis">{p.path}</div>
                </div>
                <button className="primary" onClick={() => run(() => api.saveAppRule(newRule(p, defaultAction)))}>
                  Add
                </button>
              </div>
            ))}
            {!shown.length && <p className="muted">No other apps found.</p>}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Rules ({state.appRules.length})</h2>
        {!state.appRules.length && <p className="muted">No apps added yet.</p>}
        {state.appRules.map((r) => (
          <div key={r.id} className={'row' + (r.enabled ? '' : ' disabled')}>
            <input type="checkbox" checked={r.enabled} title="Enabled" onChange={(e) => run(() => api.saveAppRule({ ...r, enabled: e.target.checked }))} />
            <AppIcon src={r.icon} />
            <div className="grow">
              <strong>{r.name}</strong>
              <div className="muted small ellipsis">{r.path}</div>
            </div>
            <div className="segmented small">
              {ACTIONS.map((a) => (
                <button key={a.id} className={r.action === a.id ? 'active ' + a.id : ''} onClick={() => run(() => api.saveAppRule({ ...r, action: a.id }))}>
                  {a.label}
                </button>
              ))}
            </div>
            <button className="danger" onClick={() => run(() => api.removeAppRule(r.id))}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function AppIcon({ src }: { src?: string }) {
  return src ? <img className="app-icon" src={src} alt="" /> : <span className="app-icon placeholder" />
}
