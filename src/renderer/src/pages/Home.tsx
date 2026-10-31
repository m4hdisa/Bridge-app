import { useEffect, useState } from 'react'
import type { ConnectionMode } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { bytes, duration, speed } from '../format'

const MODES: { id: ConnectionMode; label: string; help: string }[] = [
  { id: 'per-app', label: 'Per-App', help: 'Only the apps you choose on the Apps page use the VPN. Everything else uses your normal internet.' },
  { id: 'tun', label: 'Full VPN', help: 'All apps use the VPN, except apps you set to Direct or Block on the Apps page.' },
  { id: 'system-proxy', label: 'System Proxy', help: 'Sets the Windows proxy. Browsers and apps that respect it use the VPN. No admin rights needed.' }
]

export function Home({ state, status, stats, run, go }: PageProps) {
  const [admin, setAdmin] = useState(true)
  const [, tick] = useState(0)
  useEffect(() => {
    void api.isAdmin().then(setAdmin)
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const server = state.servers.find((s) => s.id === state.selectedServerId)
  const mode = MODES.find((m) => m.id === state.settings.mode)!
  const busy = status.state === 'starting' || status.state === 'stopping'
  const running = status.state === 'running'
  const needsAdmin = state.settings.mode !== 'system-proxy' && !admin
  const proxyApps = state.appRules.filter((r) => r.enabled && r.action === 'proxy').length

  return (
    <div className="page home">
      <h1>Home</h1>

      <div className="card connect-card">
        <button
          className={'power ' + (running ? 'on' : busy ? 'busy' : '')}
          disabled={busy || (!running && (!server || needsAdmin))}
          onClick={() => run(() => (running ? api.disconnect() : api.connect()))}
        >
          {running ? 'Disconnect' : busy ? (status.state === 'starting' ? 'Connecting…' : 'Stopping…') : 'Connect'}
        </button>
        <div className="connect-info">
          <div className="muted">Server</div>
          {server ? (
            <div className="server-line">
              <strong>{server.name}</strong>
              <span className="badge">{server.protocol}</span>
              {server.latency !== undefined && <Latency ms={server.latency} />}
            </div>
          ) : (
            <div>
              No server yet. <button className="link" onClick={() => go('servers')}>Add one</button>
            </div>
          )}
          {running && status.startedAt && <div className="muted">Connected for {duration(Date.now() - status.startedAt)}</div>}
        </div>
      </div>

      <div className="card">
        <div className="segmented">
          {MODES.map((m) => (
            <button key={m.id} className={m.id === mode.id ? 'active' : ''} onClick={() => run(() => api.updateSettings({ mode: m.id }))}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="muted">{mode.help}</p>
        {mode.id === 'per-app' && (
          <p>
            {proxyApps ? `${proxyApps} app(s) set to use the VPN. ` : 'No apps chosen yet. '}
            <button className="link" onClick={() => go('apps')}>Choose apps</button>
          </p>
        )}
        {needsAdmin && (
          <div className="warn-box">
            This mode needs administrator rights.
            <button onClick={() => run(() => api.relaunchAsAdmin())}>Restart as admin</button>
          </div>
        )}
      </div>

      {stats && (
        <>
          <div className="stat-row">
            <Stat label="Download" value={speed(stats.downSpeed)} sub={`${bytes(stats.downTotal)} total`} />
            <Stat label="Upload" value={speed(stats.upSpeed)} sub={`${bytes(stats.upTotal)} total`} />
          </div>
          <div className="card">
            <h2>Traffic by app</h2>
            <table className="table">
              <thead>
                <tr><th>App</th><th>Connections</th><th>Download</th><th>Upload</th></tr>
              </thead>
              <tbody>
                {stats.apps.map((a) => (
                  <tr key={a.path}>
                    <td title={a.path}>{a.name}</td>
                    <td>{a.connections}</td>
                    <td>{bytes(a.download)}</td>
                    <td>{bytes(a.upload)}</td>
                  </tr>
                ))}
                {!stats.apps.length && (
                  <tr><td colSpan={4} className="muted">No traffic yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card stat">
      <div className="muted">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="muted">{sub}</div>
    </div>
  )
}

export function Latency({ ms }: { ms: number }) {
  if (ms < 0) return <span className="latency bad">timeout</span>
  return <span className={'latency ' + (ms < 300 ? 'good' : ms < 800 ? 'mid' : 'bad')}>{ms} ms</span>
}
