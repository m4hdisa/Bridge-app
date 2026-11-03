import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, LoaderCircle } from 'lucide-react'
import type { MtuResult, SpeedResult, SpeedTestResult, SpeedTestStatus } from '../../../shared/types'
import { usesTun } from '../../../shared/types'
import { bytes, errorMessage, mbps } from '../format'
import { api, type PageProps } from '../App'
import { t } from '@/i18n'
import { PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** Below this share of the speed without the adapter, the adapter itself is what limits it. */
const ADAPTER_SLOW = 0.7

export function Tools({ state, status, run, go }: PageProps) {
  return (
    <div>
      <PageHeader title={t('Tools')} description={t('Measure your connection and find the right settings for your network.')} />
      <div className="flex flex-col gap-4">
        <SpeedTest connected={status.state === 'running'} go={go} />
        <MtuFinder current={state.settings.tunMtu} run={run} />
      </div>
    </div>
  )
}

function SpeedTest({ connected, go }: { connected: boolean; go: PageProps['go'] }) {
  const [test, setTest] = useState<SpeedTestStatus>({ running: false })
  useEffect(() => {
    void api.getSpeedTest().then(setTest)
    return api.onSpeedTest(setTest)
  }, [])
  const start = () => void api.runSpeedTest().catch((e) => setTest((s) => ({ ...s, running: false, error: errorMessage(e) })))
  const result = test.result

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>{t('Speed test')}</CardTitle>
            <CardDescription className="mt-1.5 max-w-lg">{t('Measures the connected server against Cloudflare for about 20 seconds, using up to 360 MB of your data. Pause other downloads for a fair number.')}</CardDescription>
          </div>
          {test.running ? (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => void api.stopSpeedTest()}>
              {t('Stop')}
            </Button>
          ) : (
            <Button size="sm" className="shrink-0" disabled={!connected} onClick={start}>
              {t('Start test')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!connected && !test.running && <p className="text-muted-foreground text-xs">{t('Connect first, then run the speed test')}</p>}
        {test.running && (
          <div className="flex items-center gap-3">
            <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
            <span className="text-muted-foreground text-sm">{liveLabel(test)}</span>
            <span className="tabular ms-auto text-lg font-semibold">{mbps(test.mbps ?? 0)}</span>
          </div>
        )}
        {test.error && <p className="text-destructive text-xs">{t(test.error)}</p>}
        {result && <SpeedTable result={result} go={go} />}
      </CardContent>
    </Card>
  )
}

function liveLabel(test: SpeedTestStatus): string {
  if (!test.path) return t('Starting…')
  if (test.path === 'adapter') return test.phase === 'upload' ? t('Upload through the VPN adapter') : t('Download through the VPN adapter')
  return test.phase === 'upload' ? t('Upload skipping the adapter') : t('Download skipping the adapter')
}

function SpeedTable({ result, go }: { result: SpeedTestResult; go: PageProps['go'] }) {
  const { adapter, core } = result
  const used = (adapter?.usedBytes ?? 0) + core.usedBytes
  const comparable = adapter?.downMbps && core.downMbps
  const slow = comparable && adapter.downMbps! < core.downMbps! * ADAPTER_SLOW
  return (
    <div className="flex flex-col gap-3">
      <div className="divide-y rounded-lg border px-4">
        {adapter && <SpeedRow title={t('Through the VPN adapter')} description={t('What apps set to VPN get')} result={adapter} />}
        <SpeedRow
          title={adapter ? t('Skipping the adapter') : t('Through the local proxy')}
          description={adapter ? t('The same server, straight into the VPN core') : t('What apps using the proxy get')}
          result={core}
        />
      </div>
      {comparable && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm leading-relaxed">
            {slow
              ? t('The VPN adapter is costing speed. Try another network stack in Settings, then test again.')
              : t('The VPN adapter is not what limits this server. Its speed comes from the server and your network.')}
          </p>
          {slow && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => go('settings')}>
              {t('Settings')}
            </Button>
          )}
        </div>
      )}
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <span dir="auto">{result.serverName}</span>
        {usesTun(result.mode) && <span dir="ltr">{result.tunStack}</span>}
        {usesTun(result.mode) && <span>MTU {result.tunMtu || t('automatic')}</span>}
        <span>{t('{amount} used', { amount: bytes(used) })}</span>
      </div>
    </div>
  )
}

function SpeedRow({ title, description, result }: { title: string; description: string; result: SpeedResult }) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-5">
          <Speed icon={<ArrowDown className="size-4" />} value={result.downMbps} />
          <Speed icon={<ArrowUp className="size-4" />} value={result.upMbps} />
        </div>
      </div>
      {result.error && <p className="text-destructive mt-1.5 text-xs">{t(result.error)}</p>}
    </div>
  )
}

function Speed({ icon, value }: { icon: ReactNode; value?: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="tabular text-sm font-semibold">{value === undefined ? '-' : mbps(value)}</span>
    </div>
  )
}

function MtuFinder({ current, run }: { current: number; run: PageProps['run'] }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MtuResult>()
  const [error, setError] = useState<string>()
  const find = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setResult(await api.findMtu())
    } catch (e) {
      setResult(undefined)
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = (tunMtu: number) => run(() => api.updateSettings({ tunMtu }), () => t('Settings saved'))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>{t('Find MTU')}</CardTitle>
            <CardDescription className="mt-1.5 max-w-lg">{t('Finds the largest packet your network carries. Worth trying when ping looks fine but sites hang or calls break up.')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={() => void find()}>
            {busy && <LoaderCircle className="animate-spin" />}
            {t('Find MTU')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-destructive text-xs">{t(error)}</p>}
        {result && (
          <>
            <p className="text-sm">{t('Largest packet on this network: {size} bytes (tested against {target}).', { size: result.pathMtu, target: result.target })}</p>
            {result.recommended ? (
              <div className="flex items-center justify-between gap-4">
                <p className="text-muted-foreground text-xs leading-relaxed">{t('Your line carries smaller packets than usual. An adapter MTU of {size} may help; run the speed test before and after. Bridge reconnects to apply it.', { size: result.recommended })}</p>
                <Button size="sm" className="shrink-0" disabled={current === result.recommended} onClick={() => void apply(result.recommended!)}>
                  {t('Use {size}', { size: result.recommended })}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{t('Full-size packets get through, so nothing needs changing.')}</p>
            )}
          </>
        )}
        {current > 0 && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-xs">{t('The adapter MTU is set to {size}.', { size: current })}</p>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => void apply(0)}>
              {t('Back to automatic')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
