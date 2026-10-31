import { useEffect, useState } from 'react'
import { usesTun, type AppRoute, type ConnectionMode, type CoreStatus, type HealthCheck } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { ago, bytes, duration, speed } from '../format'

const MODES: { id: ConnectionMode; label: string; help: string }[] = [
  { id: 'per-app', label: 'Per-App', help: 'Only the apps you choose on the Apps page use the VPN. Everything else uses your normal internet.' },
  { id: 'tun', label: 'Full VPN', help: 'All apps use the VPN, except apps you set to Direct or Block on the Apps page.' },
  { id: 'system-proxy', label: 'System Proxy', help: 'Sets the Windows proxy. Browsers and apps that respect it use the VPN. No admin rights needed.' },
  { id: 'proxy-only', label: 'Proxy only', help: 'Only runs a local SOCKS5 / HTTP proxy. Nothing on the system changes; point any app at it yourself (e.g. Telegram proxy settings). No admin rights needed.' }
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
  const needsAdmin = usesTun(state.settings.mode) && !admin
  const proxyAddress = `127.0.0.1:${status.proxyPort ?? state.settings.mixedPort}`
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
              {server.engine === 'xray' && <span className="badge xray">Xray</span>}
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
        <div className="proxy-line">
          <span className="muted">Local proxy (SOCKS5 + HTTP){running ? '' : ' while connected'}:</span>
          <code>{proxyAddress}</code>
          <button className="link" onClick={() => run(() => navigator.clipboard.writeText(proxyAddress), () => `Copied ${proxyAddress}`)}>
            Copy
          </button>
        </div>
      </div>

      {running && status.otherTunnels?.length ? (
        <div className="warn-box column">
          <strong>Other VPN / tunnel tools are active</strong>
          <span className="small">
            {status.otherTunnels.join(', ')}. Bridge keeps its own traffic on your real network adapter to avoid them, but two tools
            capturing the same apps can still conflict. If something breaks, try Per-App mode with only the apps you need, or Proxy only mode.
          </span>
        </div>
      ) : null}

      {running && <HealthCard status={status} mode={state.settings.mode} run={run} />}

      {stats && (
        <>
          <div className="stat-row">
            <Stat label="Download" value={speed(stats.downSpeed)} sub={`${bytes(stats.downTotal)} total`} />
            <Stat label="Upload" value={speed(stats.upSpeed)} sub={`${bytes(stats.upTotal)} total`} />
          </div>
          <div className="card">
            <h2>Apps using the network</h2>
            <table className="table">
              <thead>
                <tr><th>App</th><th>Route</th><th>Open</th><th>Download</th><th>Upload</th></tr>
              </thead>
              <tbody>
                {stats.apps.map((a) => {
                  const icon = state.appRules.find((r) => r.path.toLowerCase() === a.path.toLowerCase())?.icon
                  return (
                    <tr key={a.path} className={a.connections ? '' : 'idle'}>
                      <td title={a.path}>
                        <span className="app-cell">
                          {icon ? <img className="app-icon small" src={icon} alt="" /> : <span className="app-icon small placeholder" />}
                          {a.name}
                        </span>
                      </td>
                      <td><RouteBadge route={a.route} /></td>
                      <td>{a.connections}</td>
                      <td>{bytes(a.download)}</td>
                      <td>{bytes(a.upload)}</td>
                    </tr>
                  )
                })}
                {!stats.apps.length && (
                  <tr><td colSpan={5} className="muted">No traffic yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function HealthCard({ status, mode, run }: { status: CoreStatus; mode: ConnectionMode; run: PageProps['run'] }) {
  const [checking, setChecking] = useState(false)
  const h = status.health
  const serverDown = h?.server && !h.server.ok
  const internetDown = h?.internet && !h.internet.ok
  return (
    <div className={'card health' + (serverDown ? ' bad' : '')}>
      <div className="row head">
        <h2 className="grow">Connection health</h2>
        <button
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            await run(() => api.checkHealth())
            setChecking(false)
          }}
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <HealthRow label="VPN server" check={h?.server} />
      <HealthRow label="Internet (direct)" check={h?.internet} />
      {serverDown && (
        <p className="error small">
          {mode === 'per-app'
            ? 'The VPN server is not responding. Apps set to "Use VPN" are offline; other apps still use your normal internet.'
            : 'The VPN server is not responding, so apps going through the VPN are offline. Try another server or Per-App mode.'}
        </p>
      )}
      {internetDown && !serverDown && <p className="error small">Direct internet is not responding. Apps set to Direct may be offline.</p>}
    </div>
  )
}

function HealthRow({ label, check }: { label: string; check?: HealthCheck }) {
  return (
    <div className="health-row">
      <span className={'dot ' + (!check ? 'busy' : check.ok ? 'on' : 'bad')} />
      <span className="grow">{label}</span>
      <span className="muted small">
        {!check ? 'Checking…' : check.ok ? `${check.latency} ms` : check.error}
        {check && ` · ${ago(check.checkedAt)}`}
      </span>
    </div>
  )
}

function RouteBadge({ route }: { route?: AppRoute }) {
  if (!route) return <span className="muted">-</span>
  const label = route === 'vpn' ? 'VPN' : route === 'direct' ? 'Direct' : 'VPN + Direct'
  return <span className={'route ' + route}>{label}</span>
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
