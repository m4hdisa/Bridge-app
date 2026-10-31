import { useEffect, useRef, useState } from 'react'
import type { PageProps } from '../App'

export function Logs({ logs, run }: PageProps) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [search, setSearch] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const query = search.trim().toLowerCase()
  // sing-box tags each connection's lines with an id like "[123456 0ms]". When searching,
  // also show every line of the matching connections, so a search for "chrome" shows
  // where those connections went and why they failed, not just "found process path".
  const connId = (text: string) => text.match(/\[(\d+) [\d.]+m?s\]/)?.[1]
  const ids = new Set(query ? logs.filter((l) => l.text.toLowerCase().includes(query)).map((l) => connId(l.text)).filter(Boolean) : [])
  const matches = (l: (typeof logs)[number]) => !query || l.text.toLowerCase().includes(query) || ids.has(connId(l.text))
  const shown = logs.filter((l) => (!errorsOnly || l.level !== 'info') && matches(l))

  useEffect(() => end.current?.scrollIntoView(), [shown.length])

  const copy = () =>
    run(
      () => navigator.clipboard.writeText(shown.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.text}`).join('\n')),
      () => `Copied ${shown.length} line(s)`
    )

  return (
    <div className="page logs-page">
      <div className="page-head">
        <h1>Logs</h1>
        <div className="actions">
          <input placeholder="Search (e.g. Telegram)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
          <label className="check">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
            Warnings and errors only
          </label>
          <button onClick={copy} disabled={!shown.length}>Copy</button>
        </div>
      </div>
      <div className="card logs">
        {shown.map((l, i) => (
          <div key={i} className={'log ' + l.level}>
            <span className="muted">{new Date(l.time).toLocaleTimeString()}</span> {l.text}
          </div>
        ))}
        {!shown.length && <div className="muted">Nothing yet.</div>}
        <div ref={end} />
      </div>
    </div>
  )
}
