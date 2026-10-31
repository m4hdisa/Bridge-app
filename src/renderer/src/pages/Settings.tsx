import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { api, type PageProps } from '../App'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export function SettingsPage({ state, run }: PageProps) {
  const [draft, setDraft] = useState<Settings>(state.settings)
  useEffect(() => setDraft(state.settings), [state.settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className={cn(dirty && 'pb-20')}>
      <PageHeader title="Settings" description="Changes reconnect Bridge if it's connected." />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Routing</CardTitle>
            <CardDescription>What goes through the VPN besides your app rules.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title="Open Iranian sites directly" description=".ir domains and Iran's IP / domain lists skip the VPN, so local sites stay fast and reachable.">
              <Switch checked={draft.bypassIran} onCheckedChange={(v) => set('bypassIran', v)} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>DNS and compatibility</CardTitle>
            <CardDescription>For Per-App and Full VPN. The defaults work best next to other VPN and game tools.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title="DNS mode" description="Real IPs keep tools like EZConnect working. FakeIP is slightly faster but breaks tools that pick traffic by IP.">
              <Select value={draft.dnsMode} onValueChange={(v) => set('dnsMode', v as Settings['dnsMode'])}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="real">Real IPs (recommended)</SelectItem>
                  <SelectItem value="fakeip">FakeIP</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row title="Strict mode" description="Blocks DNS outside Bridge's adapter to stop leaks. Can break other VPN or game tools running at the same time.">
              <Switch checked={draft.strictRoute} onCheckedChange={(v) => set('strictRoute', v)} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Local proxy</CardTitle>
            <CardDescription>SOCKS5 and HTTP on 127.0.0.1, available in every mode.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title="Port" description="Point apps here in Proxy only mode, e.g. Telegram's proxy settings.">
              <Input type="number" min={1024} max={65535} className="tabular w-28" value={draft.mixedPort} onChange={(e) => set('mixedPort', Number(e.target.value))} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>For latency tests, health checks and logs.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title="Test URL" description="Fetched through each server for latency and health. Should return quickly and be reachable through the VPN.">
              <Input className="w-80 font-mono text-xs" value={draft.testUrl} onChange={(e) => set('testUrl', e.target.value)} />
            </Row>
            <Row title="Core log level" description="Debug is very detailed; use it only while chasing a problem.">
              <Select value={draft.logLevel} onValueChange={(v) => set('logLevel', v as Settings['logLevel'])}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['debug', 'info', 'warn', 'error'] as const).map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          </CardContent>
        </Card>
      </div>

      {dirty && (
        <div className="bg-popover/95 fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border px-4 py-3 shadow-2xl backdrop-blur [margin-left:7rem]">
          <span className="text-sm">You have unsaved changes</span>
          <Button variant="ghost" size="sm" onClick={() => setDraft(state.settings)}>
            Discard
          </Button>
          <Button size="sm" onClick={() => run(() => api.updateSettings(draft), () => 'Settings saved')}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  )
}

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-muted-foreground mt-0.5 max-w-lg text-xs leading-relaxed">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
