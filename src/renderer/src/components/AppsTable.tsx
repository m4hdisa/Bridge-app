import { Activity } from 'lucide-react'
import type { AppRule, AppTraffic } from '../../../shared/types'
import { bytes } from '../format'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import { AppIcon, EmptyState, RouteBadge } from '@/components/common'

/** Busiest first: the apps with open connections, then by how much they moved. */
export function busiestApps(apps: AppTraffic[]): AppTraffic[] {
  return [...apps].sort((a, b) => b.connections - a.connections || b.download + b.upload - (a.download + a.upload))
}

/** Apps that used the network since connecting, where their traffic went and how much of it. */
export function AppsTable({ apps, rules, running }: { apps?: AppTraffic[]; rules: AppRule[]; running: boolean }) {
  if (!apps?.length)
    return (
      <EmptyState
        icon={Activity}
        title={running ? t('No traffic yet') : t('Not connected')}
        description={running ? t('Apps appear here as soon as they open connections.') : t('Connect to see which apps use the network and where their traffic goes.')}
      />
    )
  return (
    <div className="text-sm">
      <div className="text-muted-foreground grid grid-cols-[1fr_110px_70px_90px_90px] gap-3 border-b px-5 pb-2 text-xs font-medium">
        <span>{t('App')}</span>
        <span>{t('Route')}</span>
        <span className="text-end">{t('Open')}</span>
        <span className="text-end">{t('Down')}</span>
        <span className="text-end">{t('Up')}</span>
      </div>
      {apps.map((a) => {
        const icon = rules.find((r) => r.path.toLowerCase() === a.path.toLowerCase())?.icon
        return (
          <div key={a.path} className={cn('hover:bg-muted/40 grid grid-cols-[1fr_110px_70px_90px_90px] items-center gap-3 border-b px-5 py-2 last:border-0', !a.connections && 'text-muted-foreground')}>
            <span className="flex min-w-0 items-center gap-2.5" title={a.path}>
              <AppIcon src={icon} className="size-6" />
              <span className="truncate">{a.name}</span>
            </span>
            <span>
              <RouteBadge route={a.route} />
            </span>
            <span className="tabular text-end">{a.connections}</span>
            <span className="tabular text-end">{bytes(a.download)}</span>
            <span className="tabular text-end">{bytes(a.upload)}</span>
          </div>
        )
      })}
    </div>
  )
}
