import { useEffect, useRef, useState } from 'react'
import { Copy, ScrollText, Search } from 'lucide-react'
import type { LogLine } from '../../../shared/types'
import type { PageProps } from '../App'
import { cn } from '@/lib/utils'
import { EmptyState, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

// sing-box tags each connection's lines with an id like "[123456 0ms]". A search also shows
// every line of the matching connections, so "chrome" shows where they went and why they failed.
const connId = (text: string) => text.match(/\[(\d+) [\d.]+m?s\]/)?.[1]

const levelStyle: Record<LogLine['level'], string> = {
  info: 'text-muted-foreground',
  warn: 'text-warning',
  error: 'text-destructive'
}

export function Logs({ logs, run }: PageProps) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [search, setSearch] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  const query = search.trim().toLowerCase()
  const ids = new Set(query ? logs.filter((l) => l.text.toLowerCase().includes(query)).map((l) => connId(l.text)).filter(Boolean) : [])
  const shown = logs.filter((l) => (!errorsOnly || l.level !== 'info') && (!query || l.text.toLowerCase().includes(query) || ids.has(connId(l.text))))

  // Keep following new lines only while the view is scrolled to the bottom.
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' })
  }, [shown.length, follow])

  const copy = () =>
    run(
      () => navigator.clipboard.writeText(shown.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.text}`).join('\n')),
      () => `Copied ${shown.length} line${shown.length === 1 ? '' : 's'}`
    )

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <PageHeader
        title="Logs"
        description="What the VPN core is doing. Search an app name to see its whole connections."
        actions={
          <Button variant="outline" onClick={copy} disabled={!shown.length}>
            <Copy />
            Copy {query || errorsOnly ? 'filtered' : 'all'}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-4">
        <div className="relative w-72">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input className="pl-9" placeholder="Search, e.g. chrome or error" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Label className="text-muted-foreground cursor-pointer font-normal">
          <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          Warnings and errors only
        </Label>
        <span className="text-muted-foreground tabular ml-auto text-xs">
          {shown.length} of {logs.length} lines
        </span>
      </div>

      <Card className="min-h-0 flex-1 gap-0 overflow-hidden py-0">
        {!shown.length ? (
          <EmptyState icon={ScrollText} title={logs.length ? 'Nothing matches' : 'No logs yet'} description={logs.length ? 'Try another search.' : 'Logs appear when you connect.'} />
        ) : (
          <div
            ref={boxRef}
            onScroll={(e) => {
              const el = e.currentTarget
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            }}
            className="h-full overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
          >
            {shown.map((l, i) => (
              <div key={i} className={cn('flex gap-3 border-l-2 border-transparent py-0.5 pl-2 break-all whitespace-pre-wrap', l.level === 'error' && 'border-destructive/60', l.level === 'warn' && 'border-warning/60')}>
                <span className="text-muted-foreground/60 shrink-0">{new Date(l.time).toLocaleTimeString()}</span>
                <span className={cn(l.level === 'info' ? 'text-foreground/85' : levelStyle[l.level])}>{l.text}</span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </Card>
    </div>
  )
}
