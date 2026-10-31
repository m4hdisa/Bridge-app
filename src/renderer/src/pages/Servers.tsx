import { useState } from 'react'
import type { ImportResult } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { ago, bytes } from '../format'
import { Latency } from './Home'

function importMessage(r: ImportResult): string {
  const parts = [`${r.added} server(s) added`]
  if (r.errors.length) parts.push(`${r.errors.length} skipped: ${r.errors.slice(0, 3).join(' | ')}`)
  return parts.join('. ')
}

export function Servers({ state, run }: PageProps) {
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [subName, setSubName] = useState('')
  const [subUrl, setSubUrl] = useState('')
  const [testing, setTesting] = useState(false)
  const [updating, setUpdating] = useState<string>()

  const subName_ = (id?: string) => state.subscriptions.find((s) => s.id === id)?.name

  return (
    <div className="page">
      <div className="page-head">
        <h1>Servers</h1>
        <div className="actions">
          <button onClick={() => run(() => api.importClipboard(), importMessage)}>Import from clipboard</button>
          <button onClick={() => setShowPaste((v) => !v)}>Paste links</button>
          <button
            disabled={testing || !state.servers.length}
            onClick={async () => {
              setTesting(true)
              await run(() => api.testLatency())
              setTesting(false)
            }}
          >
            {testing ? 'Testing…' : 'Test all'}
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
                  return importMessage(r)
                })
              }
            >
              Import
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Subscriptions</h2>
        {state.subscriptions.map((s) => (
          <div key={s.id} className="row">
            <div className="grow">
              <strong>{s.name}</strong>
              <div className="muted small ellipsis">{s.url}</div>
              <div className="muted small">
                {s.updatedAt ? `Updated ${ago(s.updatedAt)}` : 'Never updated'}
                {s.usage && ` · Used ${bytes(s.usage.upload + s.usage.download)} of ${s.usage.total ? bytes(s.usage.total) : 'unlimited'}`}
                {s.usage?.expire && ` · Expires ${new Date(s.usage.expire * 1000).toLocaleDateString()}`}
              </div>
              {s.lastError && <div className="error small">{s.lastError}</div>}
            </div>
            <button
              disabled={updating === s.id}
              onClick={async () => {
                setUpdating(s.id)
                await run(() => api.updateSubscription(s.id), importMessage)
                setUpdating(undefined)
              }}
            >
              {updating === s.id ? 'Updating…' : 'Update'}
            </button>
            <button className="danger" onClick={() => run(() => api.removeSubscription(s.id))}>Remove</button>
          </div>
        ))}
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

      <div className="card">
        <h2>All servers ({state.servers.length})</h2>
        {!state.servers.length && <p className="muted">Import a link or add a subscription to get started.</p>}
        {state.servers.map((s) => (
          <div
            key={s.id}
            className={'row selectable' + (s.id === state.selectedServerId ? ' selected' : '')}
            onClick={() => run(() => api.selectServer(s.id))}
          >
            <span className="radio" />
            <div className="grow">
              <strong>{s.name}</strong>
              <div className="muted small">
                {s.server}:{s.port}
                {s.subscriptionId && ` · ${subName_(s.subscriptionId)}`}
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
        ))}
      </div>
    </div>
  )
}
