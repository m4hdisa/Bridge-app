import { useState } from 'react'
import type { ImportResult, ServerProfile, Subscription } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { ago, bytes } from '../format'
import { Latency } from './Home'

function importMessage(r: ImportResult): string {
  const parts = [`${r.added} server(s) added`]
  if (r.errors.length) parts.push(`${r.errors.length} not supported (see the subscription for details)`)
  return parts.join('. ')
}

const DAY = 86400_000

export function Servers({ state, run }: PageProps) {
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [subName, setSubName] = useState('')
  const [subUrl, setSubUrl] = useState('')
  const [testing, setTesting] = useState<string>()

  const test = async (key: string, ids?: string[]) => {
    setTesting(key)
    await run(() => api.testLatency(ids))
    setTesting(undefined)
  }
  const manual = state.servers.filter((s) => !s.subscriptionId)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Servers</h1>
        <div className="actions">
          <button onClick={() => run(() => api.importClipboard(), importMessage)}>Import from clipboard</button>
          <button onClick={() => setShowPaste((v) => !v)}>Paste links</button>
          <button disabled={!!testing || !state.servers.length} onClick={() => test('all')}>
            {testing === 'all' ? 'Testing…' : 'Test all'}
          </button>
        </div>
      </div>

      {showPaste && (
        <div className="card">
          <textarea
            rows={5}
            placeholder="vless://…, vmess://…, trojan://…, ss://…, hysteria2://…, tuic://… (one per line)"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <div className="actions">
            <button
              className="primary"
              disabled={!paste.trim()}
              onClick={() =>
                run(() => api.importText(paste), (r) => {
                  setPaste('')
                  setShowPaste(false)
                  return r.errors.length ? `${r.added} added. Not supported: ${r.errors.join(' | ')}` : `${r.added} server(s) added`
                })
              }
            >
              Import
            </button>
          </div>
        </div>
      )}

      {state.subscriptions.map((sub) => (
        <SubscriptionCard
          key={sub.id}
          sub={sub}
          servers={state.servers.filter((s) => s.subscriptionId === sub.id)}
          selectedId={state.selectedServerId}
          testing={testing === sub.id}
          onTest={(ids) => test(sub.id, ids)}
          run={run}
        />
      ))}

      {(manual.length > 0 || !state.subscriptions.length) && (
        <div className="card">
          <h2>Manual configs ({manual.length})</h2>
          {!manual.length && <p className="muted">Import a link or add a subscription to get started.</p>}
          {manual.map((s) => (
            <ServerRow key={s.id} server={s} selected={s.id === state.selectedServerId} run={run} />
          ))}
        </div>
      )}

      <div className="card">
        <h2>Add subscription</h2>
        <div className="row form-row">
          <input placeholder="Name (optional)" value={subName} onChange={(e) => setSubName(e.target.value)} style={{ width: 160 }} />
          <input className="grow" placeholder="Subscription URL (https://…)" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} />
          <button
            className="primary"
            disabled={!/^https?:\/\//.test(subUrl.trim())}
            onClick={() =>
              run(() => api.addSubscription(subName.trim(), subUrl.trim()), (r) => {
                setSubName('')
                setSubUrl('')
                return importMessage(r)
              })
            }
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function SubscriptionCard(props: {
  sub: Subscription
  servers: ServerProfile[]
  selectedId?: string
  testing: boolean
  onTest: (ids: string[]) => void
  run: PageProps['run']
}) {
  const { sub, servers, selectedId, testing, onTest, run } = props
  const [updating, setUpdating] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const skipped = sub.skipped || []
  const u = sub.usage
  const used = u ? u.upload + u.download : 0
  const pct = u && u.total ? Math.min(100, (used / u.total) * 100) : 0
  const daysLeft = u?.expire ? Math.ceil((u.expire * 1000 - Date.now()) / DAY) : undefined
  const expired = daysLeft !== undefined && daysLeft <= 0
  const working = servers.filter((s) => s.latency !== undefined && s.latency >= 0).length

  return (
    <div className={'card sub' + (sub.lastError || expired ? ' bad' : '')}>
      <div className="sub-head">
        <div className="grow">
          <h2>{sub.name || 'Subscription'}</h2>
          <div className="muted small ellipsis">{sub.url}</div>
        </div>
        <button disabled={testing || !servers.length} onClick={() => onTest(servers.map((s) => s.id))}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          disabled={updating}
          onClick={async () => {
            setUpdating(true)
            await run(() => api.updateSubscription(sub.id), importMessage)
            setUpdating(false)
          }}
        >
          {updating ? 'Updating…' : 'Update'}
        </button>
        <button className="danger" onClick={() => run(() => api.removeSubscription(sub.id))}>Remove</button>
      </div>

      <div className="sub-stats">
        <div className="sub-stat">
          <div className="muted small">Traffic</div>
          {u ? (
            <>
              <div>
                {bytes(used)} {u.total ? `of ${bytes(u.total)}` : '(unlimited)'}
              </div>
              {u.total > 0 && (
                <div className="bar">
                  <span style={{ width: `${pct}%` }} className={pct > 90 ? 'bad' : pct > 70 ? 'mid' : ''} />
                </div>
              )}
            </>
          ) : (
            <div className="muted">Not reported</div>
          )}
        </div>
        <div className="sub-stat">
          <div className="muted small">Expires</div>
          {u?.expire ? (
            <div className={expired ? 'error' : daysLeft! <= 3 ? 'warn-text' : ''}>
              {expired ? 'Expired' : `${daysLeft} day(s) left`}
              <span className="muted small"> · {new Date(u.expire * 1000).toLocaleDateString()}</span>
            </div>
          ) : (
            <div className="muted">Never</div>
          )}
        </div>
        <div className="sub-stat">
          <div className="muted small">Configs</div>
          <div>
            {sub.total ?? servers.length} total · {servers.length} usable
            {skipped.length > 0 && <span className="warn-text"> · {skipped.length} not supported</span>}
          </div>
          {servers.some((s) => s.latency !== undefined) && <div className="muted small">{working} responding in last test</div>}
        </div>
        <div className="sub-stat">
          <div className="muted small">Updated</div>
          <div>{sub.updatedAt ? ago(sub.updatedAt) : 'Never'}</div>
          <div className="muted small">auto every {sub.updateHours || 12}h</div>
        </div>
      </div>

      {sub.lastError && <div className="error small">Last update failed: {sub.lastError}</div>}

      {servers.map((s) => (
        <ServerRow key={s.id} server={s} selected={s.id === selectedId} run={run} />
      ))}

      {skipped.length > 0 && (
        <div className="skipped">
          <button className="link" onClick={() => setShowSkipped((v) => !v)}>
            {showSkipped ? '▾' : '▸'} {skipped.length} config(s) not supported by the core
          </button>
          {showSkipped &&
            skipped.map((c, i) => (
              <div key={i} className="row disabled">
                <span className="radio" />
                <div className="grow">
                  <strong>{c.name}</strong>
                  <div className="small warn-text">{c.reason}</div>
                </div>
                <span className="badge">{c.kind}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function ServerRow({ server: s, selected, run }: { server: ServerProfile; selected: boolean; run: PageProps['run'] }) {
  return (
    <div className={'row selectable' + (selected ? ' selected' : '')} onClick={() => run(() => api.selectServer(s.id))}>
      <span className="radio" />
      <div className="grow">
        <strong>{s.name}</strong>
        <div className="muted small">
          {s.server}:{s.port}
        </div>
      </div>
      <span className="badge">{s.protocol}</span>
      {s.latency !== undefined && <Latency ms={s.latency} />}
      <button
        className="danger"
        onClick={(e) => {
          e.stopPropagation()
          void run(() => api.removeServer(s.id))
        }}
      >
        Delete
      </button>
    </div>
  )
}
