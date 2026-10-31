import { useEffect, useRef, useState } from 'react'
import type { PageProps } from '../App'

export function Logs({ logs }: PageProps) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const shown = errorsOnly ? logs.filter((l) => l.level !== 'info') : logs

  useEffect(() => end.current?.scrollIntoView(), [shown.length])

  return (
    <div className="page logs-page">
      <div className="page-head">
        <h1>Logs</h1>
        <label className="check">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          Warnings and errors only
        </label>
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
