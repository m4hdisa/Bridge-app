import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, ClipboardPaste, Cloud, Copy, Ellipsis, FileText, Link2, Plus, RefreshCw, Repeat, Server as ServerIcon, Trash2, TriangleAlert, Zap } from 'lucide-react'
import { WARP_METHODS, type ImportResult, type ServerProfile, type Subscription, type WarpOptions } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { ago, bytes } from '../format'
import { cn } from '@/lib/utils'
import { EmptyState, LatencyPill, PageHeader } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const DAY = 86400_000

function importMessage(r: ImportResult): string {
  return r.errors.length ? `${r.added} added · ${r.errors.length} not supported` : `${r.added} server${r.added === 1 ? '' : 's'} added`
}

export function Servers({ state, run }: PageProps) {
  const [testing, setTesting] = useState<string>()
  const [pasteOpen, setPasteOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)

  const test = async (key: string, ids?: string[]) => {
    setTesting(key)
    await run(() => api.testLatency(ids))
    setTesting(undefined)
  }
  const warp = state.servers.find((s) => s.engine === 'aether')
  const manual = state.servers.filter((s) => !s.subscriptionId && s !== warp)
  const empty = !state.servers.length && !state.subscriptions.length
  const addWarp = () => run(() => api.addWarpServer(), () => 'Free WARP server selected')

  return (
    <>
      <PageHeader
        title="Servers"
        description={
          state.settings.autoServer
            ? "Auto is on: Bridge uses the server with the best ping (highlighted). Picking a server here turns Auto off."
            : "Subscriptions and configs. The highlighted server is the one Bridge connects to."
        }
        actions={
          <>
            {!warp && (
              <Button variant="outline" onClick={addWarp}>
                <Cloud />
                Free WARP
              </Button>
            )}
            <Button variant="outline" disabled={!!testing || !state.servers.length} onClick={() => test('all')}>
              <Zap className={cn(testing === 'all' && 'animate-pulse')} />
              {testing === 'all' ? 'Testing…' : 'Test all'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <ClipboardPaste />
                  Import
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => run(() => api.importClipboard(), importMessage)}>
                  <ClipboardPaste />
                  From clipboard
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPasteOpen(true)}>
                  <FileText />
                  Paste links…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setSubOpen(true)}>
              <Plus />
              Add subscription
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        {empty && (
          <Card>
            <EmptyState
              icon={ServerIcon}
              title="No servers yet"
              description="Add your subscription link, or copy a vless:// / vmess:// / trojan:// / ss:// / hysteria2:// link and import it from the clipboard. No server yet? Use the free Cloudflare WARP server."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={addWarp}>
                    <Cloud />
                    Use free WARP
                  </Button>
                  <Button variant="outline" onClick={() => run(() => api.importClipboard(), importMessage)}>
                    <ClipboardPaste />
                    Import from clipboard
                  </Button>
                  <Button onClick={() => setSubOpen(true)}>
                    <Plus />
                    Add subscription
                  </Button>
                </div>
              }
            />
          </Card>
        )}

        {warp && <WarpCard server={warp} selected={warp.id === state.selectedServerId && !state.settings.autoServer} run={run} />}

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

        {manual.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Manual configs</CardTitle>
              <CardDescription>Imported from links.</CardDescription>
              <CardAction>
                <Button variant="ghost" size="sm" disabled={!!testing} onClick={() => test('manual', manual.map((s) => s.id))}>
                  <Zap />
                  Test
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {manual.map((s) => (
                <ServerRow key={s.id} server={s} selected={s.id === state.selectedServerId} run={run} />
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} run={run} />
      <SubscriptionDialog open={subOpen} onOpenChange={setSubOpen} run={run} />
    </>
  )
}

function SubscriptionCard(props: { sub: Subscription; servers: ServerProfile[]; selectedId?: string; testing: boolean; onTest: (ids: string[]) => void; run: PageProps['run'] }) {
  const { sub, servers, selectedId, testing, onTest, run } = props
  const [updating, setUpdating] = useState(false)
  const skipped = sub.skipped || []
  const u = sub.usage
  const used = u ? u.upload + u.download : 0
  const pct = u && u.total ? Math.min(100, (used / u.total) * 100) : 0
  const daysLeft = u?.expire ? Math.ceil((u.expire * 1000 - Date.now()) / DAY) : undefined
  const expired = daysLeft !== undefined && daysLeft <= 0
  const responding = servers.filter((s) => s.latency !== undefined && s.latency >= 0).length
  const tested = servers.some((s) => s.latency !== undefined)

  return (
    <Card className={cn((sub.lastError || expired) && 'border-destructive/40')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="text-primary size-4" />
          {sub.name || 'Subscription'}
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs">{sub.url}</CardDescription>
        <CardAction className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={testing || !servers.length} onClick={() => onTest(servers.map((s) => s.id))}>
                <Zap className={cn(testing && 'animate-pulse text-primary')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Test latency</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={updating}
                onClick={async () => {
                  setUpdating(true)
                  await run(() => api.updateSubscription(sub.id), importMessage)
                  setUpdating(false)
                }}
              >
                <RefreshCw className={cn(updating && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Update now</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => run(() => navigator.clipboard.writeText(sub.url), () => 'Subscription URL copied')}>
                <Copy />
                Copy URL
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => run(() => api.removeSubscription(sub.id), () => `Removed ${sub.name || 'subscription'}`)}>
                <Trash2 />
                Remove subscription
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Traffic">
            {u && !u.total && u.remaining !== undefined ? (
              <>
                <div className="tabular font-medium">{bytes(u.remaining)} left</div>
                <div className="text-muted-foreground text-xs">From the config name</div>
              </>
            ) : u && (u.total || u.upload || u.download) ? (
              <>
                <div className="tabular font-medium">
                  {bytes(used)} <span className="text-muted-foreground font-normal">/ {u.total ? bytes(u.total) : '∞'}</span>
                </div>
                {u.total > 0 && <Progress value={pct} className="mt-1.5" indicatorClassName={pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-warning' : undefined} />}
              </>
            ) : (
              <div className="text-muted-foreground">Not reported</div>
            )}
          </Tile>
          <Tile label="Expires">
            {u?.expire ? (
              <>
                <div className={cn('font-medium', expired ? 'text-destructive' : daysLeft! <= 3 && 'text-warning')}>{expired ? 'Expired' : `${daysLeft} days left`}</div>
                <div className="text-muted-foreground text-xs">{new Date(u.expire * 1000).toLocaleDateString()}</div>
              </>
            ) : (
              <div className="text-muted-foreground">Never</div>
            )}
          </Tile>
          <Tile label="Configs">
            <div className="font-medium">
              {servers.length} usable <span className="text-muted-foreground font-normal">of {sub.total ?? servers.length}</span>
            </div>
            <div className="text-muted-foreground text-xs">{tested ? `${responding} responding` : 'Not tested yet'}</div>
          </Tile>
          <Tile label="Updated">
            <div className="font-medium">{sub.updatedAt ? ago(sub.updatedAt) : 'Never'}</div>
            <div className="text-muted-foreground text-xs">Auto every {sub.updateHours || 12}h</div>
          </Tile>
        </div>

        {sub.lastError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>Last update failed: {sub.lastError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} selected={s.id === selectedId} run={run} />
          ))}
        </div>

        {skipped.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs font-medium">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              {skipped.length} config{skipped.length > 1 ? 's' : ''} not supported by either core
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
              {skipped.map((c, i) => (
                <div key={i} className="bg-muted/20 flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 opacity-80">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{c.name}</div>
                    <div className="text-warning truncate text-xs">{c.reason}</div>
                  </div>
                  <Badge variant="outline">{c.kind}</Badge>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-muted/30 flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-sm">
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{label}</div>
      {children}
    </div>
  )
}

function WarpCard({ server: s, selected, run }: { server: ServerProfile; selected: boolean; run: PageProps['run'] }) {
  const method = s.warp?.method ?? 'auto'
  const hint = method === 'auto' ? 'Tries every way at once. Prefers Gool, whose exit is outside Iran; otherwise keeps the first one that works.' : WARP_METHODS.find((m) => m.id === method)?.hint
  return (
    <Card className={cn(selected && 'border-primary/50')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="text-primary size-4" />
          Free WARP
          <Badge variant="success">Free</Badge>
        </CardTitle>
        <CardDescription>
          Cloudflare WARP, no config or subscription needed. Bridge finds a way through your network each time you connect, which can take up to a minute. Sites see a Cloudflare address, and some of them ask for a captcha.
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          {selected ? (
            <Badge variant="primary">
              <Check />
              In use
            </Badge>
          ) : (
            <Button size="sm" onClick={() => run(() => api.selectServer(s.id))}>
              Use
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={() => run(() => api.removeServer(s.id), () => 'Free WARP removed')}>
                <Trash2 />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Label className="text-sm">Connection method</Label>
          <Select value={method} onValueChange={(v) => run(() => api.setWarpMethod(s.id, v as WarpOptions['method']))}>
            <SelectTrigger className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (recommended)</SelectItem>
              {WARP_METHODS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </CardContent>
    </Card>
  )
}

function ServerRow({ server: s, selected, run }: { server: ServerProfile; selected: boolean; run: PageProps['run'] }) {
  const engine = s.engine === 'xray' ? 'xray' : 'sing-box'
  const canSwitch = !!s.xray && !s.xrayOnly
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !selected && run(() => api.selectServer(s.id))}
      onKeyDown={(e) => e.key === 'Enter' && !selected && run(() => api.selectServer(s.id))}
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'border-primary/50 bg-primary/8' : 'hover:bg-muted/40 border-transparent'
      )}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
        {selected && <Check className="size-3" strokeWidth={3.5} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{s.name}</div>
        <div className="text-muted-foreground truncate font-mono text-xs">
          {s.server}:{s.port}
        </div>
      </div>
      <Badge variant="outline" className="uppercase">
        {s.protocol}
      </Badge>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={engine === 'xray' ? 'warning' : 'secondary'}>{engine === 'xray' ? 'Xray' : 'sing-box'}</Badge>
        </TooltipTrigger>
        <TooltipContent>{s.xrayOnly ? 'Only the Xray core supports this config' : canSwitch ? 'Both cores can run this; switch in the menu' : 'Runs on sing-box'}</TooltipContent>
      </Tooltip>
      <LatencyPill ms={s.latency} className="w-16 justify-center" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon-sm" className="opacity-60 group-hover:opacity-100">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {!selected && (
            <DropdownMenuItem onClick={() => run(() => api.selectServer(s.id))}>
              <Check />
              Use this server
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => run(() => api.testLatency([s.id]))}>
            <Zap />
            Test latency
          </DropdownMenuItem>
          {canSwitch && (
            <DropdownMenuItem onClick={() => run(() => api.setServerEngine(s.id, engine === 'xray' ? 'sing-box' : 'xray'), () => `Now runs on ${engine === 'xray' ? 'sing-box' : 'Xray'}`)}>
              <Repeat />
              Run on {engine === 'xray' ? 'sing-box' : 'Xray'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => run(() => navigator.clipboard.writeText(s.link), () => 'Link copied')}>
            <Copy />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => run(() => api.removeServer(s.id))}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function PasteDialog({ open, onOpenChange, run }: { open: boolean; onOpenChange: (v: boolean) => void; run: PageProps['run'] }) {
  const [text, setText] = useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paste links</DialogTitle>
          <DialogDescription>One share link per line, or a base64 subscription body.</DialogDescription>
        </DialogHeader>
        <Textarea rows={7} className="font-mono text-xs" placeholder="vless://…&#10;vmess://…&#10;trojan://…" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!text.trim()}
            onClick={() =>
              run(
                () => api.importText(text),
                (r) => {
                  setText('')
                  onOpenChange(false)
                  return importMessage(r)
                }
              )
            }
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SubscriptionDialog({ open, onOpenChange, run }: { open: boolean; onOpenChange: (v: boolean) => void; run: PageProps['run'] }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = /^https?:\/\//.test(url.trim())
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add subscription</DialogTitle>
          <DialogDescription>Bridge downloads it now and keeps it up to date automatically.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="sub-url">Subscription URL</Label>
            <Input id="sub-url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sub-name">
              Name <span className="text-muted-foreground font-normal">(optional, taken from the panel otherwise)</span>
            </Label>
            <Input id="sub-name" placeholder="My provider" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true)
              await run(
                () => api.addSubscription(name.trim(), url.trim()),
                (r) => {
                  setName('')
                  setUrl('')
                  onOpenChange(false)
                  return importMessage(r)
                }
              )
              setBusy(false)
            }}
          >
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
