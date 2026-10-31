import { useEffect, useState } from 'react'
import { AppWindow, Ban, FolderOpen, Globe, Info, LoaderCircle, Plus, Search, Shield, Split, Trash2, Waypoints } from 'lucide-react'
import type { AppAction, AppRule, RunningProcess } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { cn } from '@/lib/utils'
import { AppIcon, EmptyState, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription, AlertTitle, ScrollArea } from '@/components/ui/misc'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Each action has its own color, so a list of rules can be read at a glance. */
const ACTIONS: { id: AppAction; label: string; icon: typeof Shield; tip: string; on: string }[] = [
  { id: 'proxy', label: 'VPN', icon: Shield, tip: 'Through Bridge’s VPN server', on: 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground' },
  { id: 'direct', label: 'Direct', icon: Globe, tip: 'Your normal internet (Wi-Fi / Ethernet)', on: 'data-[state=on]:bg-foreground/90 data-[state=on]:text-background' },
  { id: 'other', label: 'Other VPN', icon: Waypoints, tip: 'Handed to another VPN / game tool running next to Bridge (e.g. EZConnect)', on: 'data-[state=on]:bg-warning data-[state=on]:text-black' },
  { id: 'block', label: 'Block', icon: Ban, tip: 'No network at all', on: 'data-[state=on]:bg-destructive data-[state=on]:text-white' }
]

const MODE_HELP: Record<string, { title: string; text: string }> = {
  'per-app': { title: 'Per-App mode', text: 'Only apps set to VPN use the VPN. Apps not in this list are left on your normal internet.' },
  tun: { title: 'Full VPN mode', text: 'Every app uses the VPN, except the ones set to Direct, Other VPN or Block here.' },
  'system-proxy': { title: 'System Proxy mode', text: 'Rules apply to apps that use the Windows proxy. Switch to Per-App on the Dashboard for full per-app control.' },
  'proxy-only': { title: 'Proxy only mode', text: 'Rules apply to apps you point at Bridge’s local proxy. Switch to Per-App for full per-app control.' }
}

function newRule(p: RunningProcess, action: AppAction): AppRule {
  return { id: crypto.randomUUID(), name: p.name, path: p.path, icon: p.icon, action, enabled: true }
}

export function Apps({ state, run }: PageProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const mode = state.settings.mode
  // Adding an app usually means "send it through the VPN"; in Full VPN everything already is.
  const defaultAction: AppAction = mode === 'tun' ? 'direct' : 'proxy'
  const help = MODE_HELP[mode]
  const q = filter.trim().toLowerCase()
  const rules = state.appRules.filter((r) => !q || (r.name + r.path).toLowerCase().includes(q))
  const counts = Object.fromEntries(ACTIONS.map((a) => [a.id, state.appRules.filter((r) => r.enabled && r.action === a.id).length])) as Record<AppAction, number>

  return (
    <>
      <PageHeader
        title="Apps"
        description="Decide, per app, where its traffic goes."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                run(async () => {
                  const p = await api.pickExe()
                  if (p) await api.saveAppRule(newRule(p, defaultAction))
                })
              }
            >
              <FolderOpen />
              Browse .exe
            </Button>
            <Button onClick={() => setPickerOpen(true)}>
              <Plus />
              Add app
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <Alert>
          {mode === 'per-app' ? <Split /> : <Info />}
          <AlertTitle>{help.title}</AlertTitle>
          <AlertDescription>{help.text}</AlertDescription>
        </Alert>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {ACTIONS.map(({ id, label, icon: Icon, tip }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <div className="bg-card flex items-center gap-3 rounded-xl border px-4 py-3">
                  <span
                    className={cn(
                      'flex size-8 items-center justify-center rounded-lg',
                      id === 'proxy' && 'bg-primary/15 text-primary',
                      id === 'direct' && 'bg-foreground/10 text-foreground',
                      id === 'other' && 'bg-warning/15 text-warning',
                      id === 'block' && 'bg-destructive/15 text-destructive'
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <div className="tabular text-lg leading-tight font-semibold">{counts[id]}</div>
                    <div className="text-muted-foreground text-xs">{label}</div>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>{tip}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Rules</CardTitle>
            <CardDescription>Changes apply instantly, without reconnecting.</CardDescription>
            {state.appRules.length > 4 && (
              <CardAction>
                <div className="relative w-56">
                  <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                  <Input className="h-8 pl-8" placeholder="Filter apps" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            {!state.appRules.length && (
              <EmptyState
                icon={AppWindow}
                title="No apps yet"
                description="Add the apps that should use the VPN (or that another tool should carry). Apps not listed here are left alone."
                action={
                  <Button onClick={() => setPickerOpen(true)}>
                    <Plus />
                    Add app
                  </Button>
                }
              />
            )}
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} run={run} />
            ))}
            {state.appRules.length > 0 && !rules.length && <p className="text-muted-foreground py-6 text-center text-sm">No apps match “{filter}”.</p>}
          </CardContent>
        </Card>
      </div>

      <AppPicker open={pickerOpen} onOpenChange={setPickerOpen} existing={state.appRules} onAdd={(p) => run(() => api.saveAppRule(newRule(p, defaultAction)), () => `${p.name} added`)} run={run} />
    </>
  )
}

function RuleRow({ rule: r, run }: { rule: AppRule; run: PageProps['run'] }) {
  return (
    <div className={cn('hover:bg-muted/30 flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 transition-colors', !r.enabled && 'opacity-55')}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Switch checked={r.enabled} onCheckedChange={(v) => run(() => api.saveAppRule({ ...r, enabled: v }))} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{r.enabled ? 'Rule on' : 'Rule off (app left alone)'}</TooltipContent>
      </Tooltip>
      <AppIcon src={r.icon} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{r.name}</div>
        <div className="text-muted-foreground truncate text-xs" title={r.path}>
          {r.path}
        </div>
      </div>
      <ToggleGroup type="single" value={r.action} onValueChange={(v) => v && run(() => api.saveAppRule({ ...r, action: v as AppAction }))} disabled={!r.enabled}>
        {/* No Tooltip wrapper here: its trigger sets data-state and would hide the selected state. */}
        {ACTIONS.map(({ id, label, icon: Icon, tip, on }) => (
          <ToggleGroupItem key={id} value={id} title={tip} className={cn('h-7 px-2.5 text-xs', on)}>
            <Icon className="size-3.5" />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => run(() => api.removeAppRule(r.id))}>
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Remove (the app is left alone again)</TooltipContent>
      </Tooltip>
    </div>
  )
}

function AppPicker({
  open,
  onOpenChange,
  existing,
  onAdd,
  run
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  existing: AppRule[]
  onAdd: (p: RunningProcess) => void
  run: PageProps['run']
}) {
  const [list, setList] = useState<RunningProcess[]>()
  const [search, setSearch] = useState('')
  const taken = new Set(existing.map((r) => r.path.toLowerCase()))
  const q = search.trim().toLowerCase()
  const shown = (list || []).filter((p) => !taken.has(p.path.toLowerCase()) && (p.name + p.path).toLowerCase().includes(q))

  // Load the list every time the dialog opens. Radix only calls onOpenChange when the
  // dialog closes itself, not when the page opens it, so this can't live there.
  useEffect(() => {
    if (!open) return
    setList(undefined)
    setSearch('')
    void run(async () => {
      // On failure show the empty state (and the error toast) instead of spinning forever.
      setList(await api.listProcesses().catch((e) => {
        setList([])
        throw e
      }))
    })
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a running app</DialogTitle>
          <DialogDescription>Start the app first if it isn't listed, or use “Browse .exe”.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input className="pl-9" placeholder="Search apps" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        </div>
        <ScrollArea className="h-80 rounded-lg border">
          <div className="flex flex-col p-1.5">
            {!list && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
                <LoaderCircle className="size-4 animate-spin" />
                Looking for running apps…
              </div>
            )}
            {list && !shown.length && <p className="text-muted-foreground py-16 text-center text-sm">No other apps found.</p>}
            {shown.map((p) => (
              <button key={p.path} onClick={() => onAdd(p)} className="hover:bg-accent group flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left">
                <AppIcon src={p.icon} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-muted-foreground truncate text-xs">{p.path}</div>
                </div>
                <Plus className="text-muted-foreground group-hover:text-primary size-4" />
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
