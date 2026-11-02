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
    // Cloudflare's logo (path from Simple Icons, CC0), in its two brand oranges.
    <svg viewBox="0 5 24 14" className={cn('h-3.5 w-5 shrink-0', className)} role="img" aria-label={t('Cloudflare')}>
      <title>{t('Cloudflare')}</title>
      <path
        fill="#F38020"
        d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268z"
      />
      <path
        fill="#FBAD41"
        d="M19.2656 11.2813c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"
      />
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
