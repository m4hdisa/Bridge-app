import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, ClipboardPaste, Cloud, Copy, Ellipsis, FileText, Link2, Plus, RefreshCw, Repeat, Server as ServerIcon, Trash2, TriangleAlert, Zap } from 'lucide-react'
import { WARP_METHODS, type ImportResult, type ServerProfile, type Subscription, type WarpOptions } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { ago, bytes } from '../format'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import { CloudflareMark, EmptyState, Flag, LatencyPill, PageHeader } from '@/components/common'
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
  return r.errors.length ? t('{added} added · {skipped} not supported', { added: r.added, skipped: r.errors.length }) : t(r.added === 1 ? '{n} server added' : '{n} servers added', { n: r.added })
}

export function Servers({ state, status, run }: PageProps) {
  const [testing, setTesting] = useState<string>()
  const [pasteOpen, setPasteOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)

  const test = async (key: string, ids?: string[]) => {
    setTesting(key)
    await run(() => api.testLatency(ids))
    setTesting(undefined)
  }
  const warp = state.servers.find((s) => s.engine === 'aether' && !s.warp?.peer)
  const warpConfigs = state.servers.filter((s) => s.engine === 'aether' && !!s.warp?.peer)
  const manual = state.servers.filter((s) => !s.subscriptionId && s.engine !== 'aether')
  const empty = !state.servers.length && !state.subscriptions.length
  const addWarp = () => run(() => api.addWarpServer(), () => t('Free WARP server selected'))

  return (
    <>
      <PageHeader
        title={t('Servers')}
        description={
          state.settings.autoServer
            ? t('Auto is on: Bridge uses the server with the best ping (highlighted). Picking a server here turns Auto off.')
            : t('Subscriptions and configs. The highlighted server is the one Bridge connects to.')
        }
        actions={
          <>
            <Button variant="outline" disabled={!!testing || !state.servers.length} onClick={() => test('all')}>
              <Zap className={cn(testing === 'all' && 'animate-pulse')} />
              {testing === 'all' ? t('Testing…') : t('Test all')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus />
                  {t('Add servers')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => setSubOpen(true)}>
                  <Link2 />
                  {t('Subscription link…')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => run(() => api.importClipboard(), importMessage)}>
                  <ClipboardPaste />
                  {t('Links from clipboard')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPasteOpen(true)}>
                  <FileText />
                  {t('Paste links…')}
                </DropdownMenuItem>
                {!warp && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={addWarp}>
                      <Cloud />
                      {t('Free WARP server')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        {empty && (
          <Card>
            <EmptyState
              icon={ServerIcon}
              title={t('No servers yet')}
              description={t('Add your subscription link, or copy a vless:// / vmess:// / trojan:// / ss:// / hysteria2:// link and import it from the clipboard. No server yet? Use the free Cloudflare WARP server.')}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={addWarp}>
                    <Cloud />
                    {t('Use free WARP')}
                  </Button>
                  <Button variant="outline" onClick={() => run(() => api.importClipboard(), importMessage)}>
                    <ClipboardPaste />
                    {t('Import from clipboard')}
                  </Button>
                  <Button onClick={() => setSubOpen(true)}>
                    <Plus />
                    {t('Add subscription')}
                  </Button>
                </div>
              }
            />
          </Card>
        )}

        {warp && (
          <WarpCard
            server={warp}
            configs={warpConfigs}
            selectedId={state.settings.autoServer ? undefined : state.selectedServerId}
            connected={status.state !== 'stopped'}
            run={run}
          />
        )}

        {state.subscriptions.map((sub) => (
          <SubscriptionCard
            key={sub.id}
            sub={sub}
            servers={state.servers.filter((s) => s.subscriptionId === sub.id)}
            selectedId={state.selectedServerId}
            pinging={state.pinging}
            testing={testing === sub.id}
            onTest={(ids) => test(sub.id, ids)}
            run={run}
          />
        ))}

        {manual.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t('Manual configs')}</CardTitle>
              <CardDescription>{t('Imported from links.')}</CardDescription>
              <CardAction>
                <Button variant="ghost" size="sm" disabled={!!testing} onClick={() => test('manual', manual.map((s) => s.id))}>
                  <Zap />
                  {t('Test')}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {manual.map((s) => (
                <ServerRow key={s.id} server={s} selected={s.id === state.selectedServerId} pinging={state.pinging?.includes(s.id)} run={run} />
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

function SubscriptionCard(props: {
  sub: Subscription
  servers: ServerProfile[]
  selectedId?: string
  pinging?: string[]
  testing: boolean
  onTest: (ids: string[]) => void
  run: PageProps['run']
}) {
  const { sub, servers, selectedId, pinging, testing, onTest, run } = props
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
          <Link2 className="text-brand size-4" />
          {sub.name || t('Subscription')}
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs">{sub.url}</CardDescription>
        <CardAction className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={testing || !servers.length} onClick={() => onTest(servers.map((s) => s.id))}>
                <Zap className={cn(testing && 'animate-pulse text-brand')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Test latency')}</TooltipContent>
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
            <TooltipContent>{t('Update now')}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => run(() => navigator.clipboard.writeText(sub.url), () => t('Subscription URL copied'))}>
                <Copy />
                {t('Copy URL')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => run(() => api.removeSubscription(sub.id), () => `Removed ${sub.name || 'subscription'}`)}>
                <Trash2 />
                {t('Remove subscription')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="bg-muted/20 grid grid-cols-2 overflow-hidden rounded-lg border md:grid-cols-4">
          <Tile label={t('Traffic')} className="border-b md:border-b-0">
            {u && !u.total && u.remaining !== undefined ? (
              <>
                <div className="tabular font-medium">{t('{size} left', { size: bytes(u.remaining) })}</div>
                <div className="text-muted-foreground text-xs">{t('From the config name')}</div>
              </>
            ) : u && (u.total || u.upload || u.download) ? (
              <>
                <div className="tabular font-medium">
                  {bytes(used)} <span className="text-muted-foreground font-normal">/ {u.total ? bytes(u.total) : '∞'}</span>
                </div>
                {u.total > 0 && <Progress value={pct} className="mt-1.5" indicatorClassName={pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-warning' : undefined} />}
              </>
            ) : (
              <div className="text-muted-foreground">{t('Not reported')}</div>
            )}
          </Tile>
          <Tile label={t('Expires')} className="border-b border-s md:border-b-0">
            {u?.expire ? (
              <>
                <div className={cn('font-medium', expired ? 'text-destructive' : daysLeft! <= 3 && 'text-warning')}>{expired ? t('Expired') : t('{n} days left', { n: daysLeft! })}</div>
                <div className="text-muted-foreground text-xs">{new Date(u.expire * 1000).toLocaleDateString()}</div>
              </>
            ) : (
              <div className="text-muted-foreground">{t('Never')}</div>
            )}
          </Tile>
          <Tile label={t('Configs')} className="md:border-l">
            <div className="font-medium">
              {t('{n} usable', { n: servers.length })} <span className="text-muted-foreground font-normal">{t('of {total}', { total: sub.total ?? servers.length })}</span>
            </div>
            <div className="text-muted-foreground text-xs">{tested ? t('{n} responding', { n: responding }) : t('Not tested yet')}</div>
          </Tile>
          <Tile label={t('Updated')} className="border-s">
            <div className="font-medium">{sub.updatedAt ? ago(sub.updatedAt) : t('Never')}</div>
            <div className="text-muted-foreground text-xs">{t('Auto every {n}h', { n: sub.updateHours || 12 })}</div>
          </Tile>
        </div>

        {sub.lastError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{t('Last update failed: {error}', { error: sub.lastError })}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} selected={s.id === selectedId} pinging={pinging?.includes(s.id)} run={run} />
          ))}
        </div>

        {skipped.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs font-medium">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              {t(skipped.length > 1 ? '{n} configs not supported by either core' : '{n} config not supported by either core', { n: skipped.length })}
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

/** One cell of the subscription's summary box. */
function Tile({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 px-3.5 py-2.5 text-sm', className)}>
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      {children}
    </div>
  )
}

function WarpCard({
  server: s,
  configs,
  selectedId,
  connected,
  run
}: {
  server: ServerProfile
  configs: ServerProfile[]
  selectedId?: string
  connected: boolean
  run: PageProps['run']
}) {
  const [finding, setFinding] = useState(false)
  const selected = s.id === selectedId
  const find = async () => {
    setFinding(true)
    await run(
      () => api.findWarpConfigs(),
      (n) => (n ? t(n === 1 ? '{n} config found' : '{n} configs found', { n }) : t('No way through found on this network right now'))
    )
    setFinding(false)
  }
  const method = s.warp?.method ?? 'auto'
  const hint = method === 'auto' ? t('Tries every way at once. Prefers Gool, whose exit is outside Iran; otherwise keeps the first one that works. If Gool misses, the next connects for a few hours don\'t wait for it.') : t(WARP_METHODS.find((m) => m.id === method)?.hint ?? '')
  return (
    <Card className={cn(selected && 'border-brand/50')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudflareMark />
          {t('Free WARP')}
          <Badge variant="success">{t('Free')}</Badge>
        </CardTitle>
        <CardDescription>
          {t('Cloudflare WARP, no config or subscription needed. Bridge finds a way through your network each time you connect, which can take up to a minute; a saved config below connects in seconds. Sites see a Cloudflare address, and some of them ask for a captcha.')}
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          {selected ? (
            <Badge variant="primary">
              <Check />
              {t('In use')}
            </Badge>
          ) : (
            <Button size="sm" onClick={() => run(() => api.selectServer(s.id))}>
              {t('Use')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={() => run(() => api.removeServer(s.id), () => t('Free WARP removed'))}>
                <Trash2 />
                {t('Remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Label className="text-sm">{t('Connection method')}</Label>
          <Select value={method} onValueChange={(v) => run(() => api.setWarpMethod(s.id, v as WarpOptions['method']))}>
            <SelectTrigger className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('Auto (recommended)')}</SelectItem>
              {WARP_METHODS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {t(m.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-xs">{hint}</p>

        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('Saved configs')}</div>
              <p className="text-muted-foreground text-xs">
                {connected
                  ? t('Disconnect to find configs: Bridge tests every way on your own network.')
                  : t('Tests every way through your network once and saves each one that works, with its gateway. Connecting to a saved config skips the search, so it takes seconds.')}
              </p>
            </div>
            <Button size="sm" variant="outline" disabled={finding || connected} onClick={find}>
              <RefreshCw className={cn(finding && 'animate-spin')} />
              {finding ? t('Finding… (up to 1.5 min)') : configs.length ? t('Find again') : t('Find configs')}
            </Button>
          </div>
          {configs.length > 0 && (
            <div className="flex flex-col gap-1">
              {configs.map((c) => (
                <WarpConfigRow key={c.id} server={c} selected={c.id === selectedId} run={run} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function WarpConfigRow({ server: s, selected, run }: { server: ServerProfile; selected: boolean; run: PageProps['run'] }) {
  const w = s.warp!
  const label = WARP_METHODS.find((m) => m.id === w.method)?.label ?? w.method
  const pick = () => !selected && run(() => api.selectServer(s.id))
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={pick}
      onKeyDown={(e) => e.key === 'Enter' && pick()}
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected ? 'border-brand/50 bg-primary/8' : 'hover:bg-muted/40 border-transparent'
      )}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-brand bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
        {selected && <Check className="size-3" strokeWidth={3.5} />}
      </span>
      <CloudflareMark />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{t(label)}</span>
        <span className="text-muted-foreground truncate font-mono text-xs">{w.peer}</span>
      </div>
      {w.exit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Flag code={w.exit} className="h-3 w-4" />
              {w.exit}
            </span>
          </TooltipTrigger>
          <TooltipContent>{w.exit === 'IR' ? t('Cloudflare registers this exit in Iran: filtering is bypassed, but some sites block Iranian users') : t('Exit country Cloudflare gave this config')}</TooltipContent>
        </Tooltip>
      )}
      {w.readyMs !== undefined && <span className="text-muted-foreground tabular w-12 text-end text-xs">{(w.readyMs / 1000).toFixed(1)} s</span>}
      <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          run(() => api.removeServer(s.id))
        }}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

function ServerRow({ server: s, selected, pinging, run }: { server: ServerProfile; selected: boolean; pinging?: boolean; run: PageProps['run'] }) {
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
        selected ? 'border-brand/50 bg-primary/8' : 'hover:bg-muted/40 border-transparent'
      )}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-brand bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>
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
          <Badge variant={engine === 'xray' ? 'warning' : 'secondary'}>{engine === 'xray' ? t('Xray') : 'sing-box'}</Badge>
        </TooltipTrigger>
        <TooltipContent>{s.xrayOnly ? t('Only the Xray core supports this config') : canSwitch ? t('Both cores can run this; switch in the menu') : t('Runs on sing-box')}</TooltipContent>
      </Tooltip>
      <LatencyPill ms={s.latency} pinging={pinging} className="w-16 justify-center" />
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
              {t('Use this server')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => run(() => api.testLatency([s.id]))}>
            <Zap />
            {t('Test latency')}
          </DropdownMenuItem>
          {canSwitch && (
            <DropdownMenuItem onClick={() => run(() => api.setServerEngine(s.id, engine === 'xray' ? 'sing-box' : 'xray'), () => t('Now runs on {core}', { core: engine === 'xray' ? 'sing-box' : 'Xray' }))}>
              <Repeat />
              {t('Run on {core}', { core: engine === 'xray' ? 'sing-box' : 'Xray' })}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => run(() => navigator.clipboard.writeText(s.link), () => t('Link copied'))}>
            <Copy />
            {t('Copy link')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => run(() => api.removeServer(s.id))}>
            <Trash2 />
            {t('Delete')}
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
          <DialogTitle>{t('Paste links')}</DialogTitle>
          <DialogDescription>{t('One share link per line, or a base64 subscription body.')}</DialogDescription>
        </DialogHeader>
        <Textarea rows={7} className="font-mono text-xs" placeholder={'vless://…\nvmess://…\ntrojan://…'} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
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
            {t('Import')}
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
          <DialogTitle>{t('Add subscription')}</DialogTitle>
          <DialogDescription>{t('Bridge downloads it now and keeps it up to date automatically.')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="sub-url">{t('Subscription URL')}</Label>
            <Input id="sub-url" placeholder={t('https://…')} value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sub-name">
              {t('Name')}{" "}<span className="text-muted-foreground font-normal">{t('(optional, taken from the panel otherwise)')}</span>
            </Label>
            <Input id="sub-name" placeholder={t('My provider')} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
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
            {busy ? t('Adding…') : t('Add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
