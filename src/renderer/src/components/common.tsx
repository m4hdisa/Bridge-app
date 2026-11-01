// Small building blocks shared by the pages.
import * as React from 'react'
import { AppWindow, Globe } from 'lucide-react'
import * as Flags from 'country-flag-icons/react/3x2'
import { BRIDGE_HOLE_R, BRIDGE_HOLES, BRIDGE_RECTS, LOGO_COLOR, LOGO_TILE } from '../../../shared/logo'
import type { AppRoute } from '../../../shared/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[1.625rem] leading-tight font-semibold tracking-[-0.025em]">{title}</h1>
        {description && <p className="text-muted-foreground mt-1.5 max-w-[65ch] text-sm leading-relaxed">{description}</p>}
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
  primary: 'bg-brand shadow-[0_0_0_3px] shadow-brand/20',
  muted: 'bg-muted-foreground/50'
}

export function StatusDot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', toneDot[tone], pulse && 'animate-pulse', className)} />
}

/** Latency as a colored pill: green < 300 ms, amber < 800 ms, red above or failed. */
export function LatencyPill({ ms, pinging, className }: { ms?: number; pinging?: boolean; className?: string }) {
  if (pinging) return <LoadingDots className={className} />
  if (ms === undefined) return <span className={cn('text-muted-foreground text-center text-xs', className)}>-</span>
  if (ms < 0)
    return (
      <Badge variant="destructive" className={className}>
        {t('Timeout')}
      </Badge>
    )
  const variant = ms < 300 ? 'success' : ms < 800 ? 'warning' : 'destructive'
  return (
    <Badge variant={variant} dir="ltr" className={cn('tabular', className)}>
      {ms}{" "}{t('ms')}
    </Badge>
  )
}

/** Three dots that pulse in turn: a ping (or any small wait) in progress. */
export function LoadingDots({ className }: { className?: string }) {
  return (
    <span role="status" aria-label={t('Testing')} className={cn('inline-flex h-5 items-center justify-center gap-1', className)}>
      {[0, 160, 320].map((delay) => (
        <span key={delay} className="bg-brand animate-loading-dot size-1.5 rounded-full" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  )
}

export function RouteBadge({ route }: { route?: AppRoute }) {
  if (!route) return <span className="text-muted-foreground text-xs">-</span>
  if (route === 'vpn') return <Badge variant="primary">{t('VPN')}</Badge>
  if (route === 'direct') return <Badge variant="outline">{t('Direct')}</Badge>
  return <Badge variant="warning">{t('VPN + Direct')}</Badge>
}

/** A country flag as an SVG (Windows can't draw flag emoji); a globe if the code is unknown. */
export function Flag({ code, className }: { code?: string; className?: string }) {
  const Svg = code ? (Flags as Record<string, React.ComponentType<{ className?: string; title?: string }>>)[code.toUpperCase()] : undefined
  if (!Svg) return <Globe className={cn('text-muted-foreground h-3.5 w-5', className)} />
  return <Svg title={code} className={cn('h-3.5 w-5 shrink-0 rounded-[3px] shadow-[0_0_0_1px] shadow-white/10', className)} />
}

/** Bridge's logo: the white bridge mark on the brand-blue tile (the app icon is drawn from the same geometry). */
export function BridgeLogo({ className }: { className?: string }) {
  const id = React.useId()
  return (
    <svg viewBox="0 0 100 100" className={cn('shrink-0', className)} role="img" aria-label={t('Bridge')}>
      <defs>
        {/* The bridge is its rectangles minus the circles, so the tile shows through the cut-outs. */}
        <mask id={`${id}-cut`}>
          {BRIDGE_RECTS.map(([x1, y1, x2, y2]) => (
            <rect key={`${x1},${y1}`} x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="white" />
          ))}
          {BRIDGE_HOLES.map(([cx, cy]) => (
            <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={BRIDGE_HOLE_R} fill="black" />
          ))}
        </mask>
      </defs>
      <path d={LOGO_TILE} fill={LOGO_COLOR} />
      <rect width="100" height="100" fill="white" mask={`url(#${id}-cut)`} />
    </svg>
  )
}

/** Shown instead of a country flag when the VPN is Cloudflare WARP: the exit is Cloudflare's network. */
export function CloudflareMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 16" className={cn('h-3.5 w-5 shrink-0', className)} role="img" aria-label={t('Cloudflare')}>
      <title>{t('Cloudflare')}</title>
      <path fill="#F38020" d="M19.2 6.6A7.2 7.2 0 0 0 5.4 4.9 5.6 5.6 0 0 0 5.6 16h13.2a4.7 4.7 0 0 0 .4-9.4Z" />
      <path fill="#FBAD41" d="M19.2 6.6c-.3 0-.6 0-.9.1a5 5 0 0 1-4.4 9.3h4.9a4.7 4.7 0 0 0 .4-9.4Z" />
    </svg>
  )
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
      <span className="bg-primary/10 text-brand flex size-12 items-center justify-center rounded-full">
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
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  className
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </div>
      <div className="tabular text-xl font-semibold">{value}</div>
      {hint && <div className="text-muted-foreground tabular text-xs">{hint}</div>}
    </div>
  )
}
