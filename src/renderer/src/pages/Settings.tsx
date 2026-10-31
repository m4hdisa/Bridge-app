import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { api, type PageProps } from '../App'

export function SettingsPage({ state, run }: PageProps) {
  const [draft, setDraft] = useState<Settings>(state.settings)
  useEffect(() => setDraft(state.settings), [state.settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className="page">
      <h1>Settings</h1>
      <div className="card form">
        <label className="check">
          <input type="checkbox" checked={draft.bypassIran} onChange={(e) => set('bypassIran', e.target.checked)} />
          Open Iranian sites directly (.ir and Iran IP / domain lists)
        </label>

        <label className="check">
          <input type="checkbox" checked={draft.strictRoute} onChange={(e) => set('strictRoute', e.target.checked)} />
          Strict mode: block DNS leaks outside the VPN adapter (can break other VPN / game tools running at the same time)
        </label>

        <label>
          DNS mode (Full VPN and Per-App)
          <select value={draft.dnsMode} onChange={(e) => set('dnsMode', e.target.value as Settings['dnsMode'])}>
            <option value="real">Real IPs over DNS-over-HTTPS (works with other VPN / game tools)</option>
            <option value="fakeip">FakeIP (slightly faster, breaks tools like EZConnect)</option>
          </select>
        </label>

        <label>
          Local proxy port (HTTP + SOCKS5 on 127.0.0.1)
          <input type="number" min={1024} max={65535} value={draft.mixedPort} onChange={(e) => set('mixedPort', Number(e.target.value))} />
        </label>

        <label>
          Latency test URL
          <input value={draft.testUrl} onChange={(e) => set('testUrl', e.target.value)} />
        </label>

        <label>
          Core log level
          <select value={draft.logLevel} onChange={(e) => set('logLevel', e.target.value as Settings['logLevel'])}>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>

        <div className="actions">
          <button className="primary" disabled={!dirty} onClick={() => run(() => api.updateSettings(draft), () => 'Settings saved')}>
            Save
          </button>
          <button disabled={!dirty} onClick={() => setDraft(state.settings)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
