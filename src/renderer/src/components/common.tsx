// Small building blocks shared by the pages.
import * as React from 'react'
import { AppWindow, Globe } from 'lucide-react'
import * as Flags from 'country-flag-icons/react/3x2'
import type { AppRoute } from '../../../shared/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export type Tone = 'success' | 'warning' | 'destructive' | 'muted' | 'primary'

const toneDot: Record<Tone, string> = {
  success: 'bg-success shadow-[0_0_0_3px] shadow-success/20',
  warning: 'bg-warning shadow-[0_0_0_3px] shadow-warning/20',
  destructive: 'bg-destructive shadow-[0_0_0_3px] shadow-destructive/20',
  primary: 'bg-primary shadow-[0_0_0_3px] shadow-primary/20',
  muted: 'bg-muted-foreground/50'
}

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', toneDot[tone], pulse && 'animate-pulse', className)} />
}

/** Latency as a colored pill: green < 300 ms, amber < 800 ms, red above or failed. */
export function LatencyPill({ ms, className }: { ms?: number; className?: string }) {
  if (ms === undefined) return <span className={cn('text-muted-foreground text-xs', className)}>—</span>
  if (ms < 0) return <Badge variant="destructive" className={className}>Timeout</Badge>
  const variant = ms < 300 ? 'success' : ms < 800 ? 'warning' : 'destructive'
  return (
    <Badge variant={variant} className={cn('tabular', className)}>
      {ms} ms
    </Badge>
  )
}

export function RouteBadge({ route }: { route?: AppRoute }) {
  if (!route) return <span className="text-muted-foreground text-xs">—</span>
  if (route === 'vpn') return <Badge variant="primary">VPN</Badge>
  if (route === 'direct') return <Badge variant="outline">Direct</Badge>
  return <Badge variant="warning">VPN + Direct</Badge>
}

/** A country flag as an SVG (Windows can't draw flag emoji); a globe if the code is unknown. */
export function Flag({ code, className }: { code?: string; className?: string }) {
  const Svg = code ? (Flags as Record<string, React.ComponentType<{ className?: string; title?: string }>>)[code.toUpperCase()] : undefined
  if (!Svg) return <Globe className={cn('text-muted-foreground h-3.5 w-5', className)} />
  return <Svg title={code} className={cn('h-3.5 w-5 shrink-0 rounded-[3px] shadow-[0_0_0_1px] shadow-white/10', className)} />
}

export function AppIcon({ src, className }: { src?: string; className?: string }) {
  return src ? (
    <img src={src} alt="" className={cn('size-7 shrink-0 rounded-md', className)} />
  ) : (
    <span className={cn('bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md', className)}>
      <AppWindow className="size-4" />
    </span>
  )
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full">
        <Icon className="size-6" />
      </span>
      <div>
        <div className="font-medium">{title}</div>
        {description && <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">{description}</p>}
      </div>
      {action}
    </div>
  )
}

/** A label + value block used in stat rows. */
export function Stat({ label, value, hint, icon: Icon, className }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </div>
      <div className="tabular text-xl font-semibold">{value}</div>
      {hint && <div className="text-muted-foreground tabular text-xs">{hint}</div>}
    </div>
  )
}
