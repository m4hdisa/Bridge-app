import { useEffect, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { Settings, UpdateStatus } from '../../../shared/types'
import { ago } from '../format'
import { api, type PageProps } from '../App'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import { PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export function SettingsPage({ state, update, run }: PageProps) {
  const [draft, setDraft] = useState<Settings>(state.settings)
  useEffect(() => setDraft(state.settings), [state.settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <div className={cn(dirty && 'pb-20')}>
      <PageHeader title={t('Settings')} description={t('Changes reconnect Bridge if it\'s connected.')} />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('Language')}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={t('App language')} description={t('Persian reads right to left. Logs and server names stay as they are.')}>
              <Select value={draft.language} onValueChange={(v) => set('language', v as Settings['language'])}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="fa">فارسی</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Routing')}</CardTitle>
            <CardDescription>{t('What goes through the VPN besides your app rules.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={t('Open Iranian sites directly')} description={t('.ir domains and Iran\'s IP / domain lists skip the VPN, so local sites stay fast and reachable.')}>
              <Switch checked={draft.bypassIran} onCheckedChange={(v) => set('bypassIran', v)} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Discord')}</CardTitle>
            <CardDescription>{t('Bridge talks to the Discord app on this PC only; nothing is sent anywhere else.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row
              title={t('Show in Discord')}
              description={t('While connected, your Discord profile shows the server you\'re on, the mode, where traffic exits (with its flag) and for how long. Your IP address isn\'t shown. Friends will see that you use a VPN.')}
            >
              <Switch checked={draft.showInDiscord} onCheckedChange={(v) => set('showInDiscord', v)} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Servers')}</CardTitle>
            <CardDescription>{t('Keeping ping results fresh. Pick “Auto” in the server list on the Dashboard to always use the best one.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={t('Ping servers automatically')} description={t('Tests every server when Bridge starts, after subscription updates and every 10 minutes. Uses a little traffic on each server.')}>
              <Switch checked={draft.autoPing} onCheckedChange={(v) => set('autoPing', v)} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('DNS and compatibility')}</CardTitle>
            <CardDescription>{t('For Per-App and Full VPN. The defaults work best next to other VPN and game tools.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={t('DNS mode')} description={t('Real IPs keep tools like EZConnect working. FakeIP is slightly faster but breaks tools that pick traffic by IP.')}>
              <Select value={draft.dnsMode} onValueChange={(v) => set('dnsMode', v as Settings['dnsMode'])}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="real">{t('Real IPs (recommended)')}</SelectItem>
                  <SelectItem value="fakeip">{t('FakeIP')}</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row title={t('Strict mode')} description={t('Blocks DNS outside Bridge\'s adapter to stop leaks. Can break other VPN or game tools running at the same time.')}>
              <Switch checked={draft.strictRoute} onCheckedChange={(v) => set('strictRoute', v)} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Local proxy')}</CardTitle>
            <CardDescription>{t('SOCKS5 and HTTP on 127.0.0.1, available in every mode.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={t('Port')} description={t('Point apps here in Proxy only mode, e.g. Telegram\'s proxy settings.')}>
              <Input type="number" min={1024} max={65535} className="tabular w-28" value={draft.mixedPort} onChange={(e) => set('mixedPort', Number(e.target.value))} />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('Diagnostics')}</CardTitle>
            <CardDescription>{t('For latency tests, health checks and logs.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={t('Test URL')} description={t('Fetched through each server for latency and health. Should return quickly and be reachable through the VPN.')}>
              <Input className="w-80 font-mono text-xs" value={draft.testUrl} onChange={(e) => set('testUrl', e.target.value)} />
            </Row>
            <Row title={t('Core log level')} description={t('Debug is very detailed; use it only while chasing a problem.')}>
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

        <Card>
          <CardHeader>
            <CardTitle>{t('About and updates')}</CardTitle>
            <CardDescription>{t('Bridge looks for a new version on GitHub when it starts and a few times a day.')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title={`Bridge ${update.current}`} description={updateText(update)}>
              {update.state === 'available' || (update.state === 'error' && update.update) ? (
                <Button size="sm" onClick={() => run(() => api.installUpdate())}>
                  {t('Install')}{" "}{update.update!.version}
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={['checking', 'downloading', 'installing'].includes(update.state)} onClick={() => run(() => api.checkUpdate())}>
                  {update.state === 'checking' && <LoaderCircle className="animate-spin" />}
                  {t('Check for updates')}
                </Button>
              )}
            </Row>
            <Row
              title={t('Cores')}
              description={t('sing-box (GPL-3.0) and Xray-core (MPL-2.0) run your servers. Free WARP runs on Aether by CluvexStudio (AGPL-3.0, unmodified; source github.com/CluvexStudio/Aether, channel t.me/CluvexStudio).')}
            >
              {null}
            </Row>
          </CardContent>
        </Card>
      </div>

      {dirty && (
        <div className="bg-popover/95 fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-xl border px-4 py-3 shadow-2xl backdrop-blur [margin-left:7rem] rtl:[margin-left:-7rem]">
          <span className="text-sm">{t('You have unsaved changes')}</span>
          <Button variant="ghost" size="sm" onClick={() => setDraft(state.settings)}>
            {t('Discard')}
          </Button>
          <Button size="sm" onClick={() => run(() => api.updateSettings(draft), () => t('Settings saved'))}>
            {t('Save changes')}
          </Button>
        </div>
      )}
    </div>
  )
}

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'checking':
      return t('Checking for updates…')
    case 'latest':
      return t('You have the latest version (checked {when}).', { when: u.checkedAt ? ago(u.checkedAt) : t('just now') })
    case 'available':
      return t('Bridge {version} is available. Installing closes Bridge for a moment and opens it again; your servers and settings stay.', { version: u.update!.version })
    case 'downloading':
      return t('Downloading Bridge {version}… {pct}%', { version: u.update!.version, pct: Math.round((u.progress ?? 0) * 100) })
    case 'installing':
      return t('Installing; Bridge will reopen by itself.')
    case 'error':
      return u.error || t('Could not check for updates.')
    default:
      return t('Not checked yet.')
  }
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
