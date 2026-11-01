import { Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export type ConnectState = 'off' | 'busy' | 'on'

/**
 * The connect button, built like a physical control: a bezel ring with a small gap, and the
 * button itself, a disc lit from above. Connecting: a thin arc runs around the bezel (it means "working"). On: the logo blue,
 * a soft light slowly turning inside it, and a still blue light behind it all.
 */
export function ConnectButton({ state, label, disabled, onClick }: { state: ConnectState; label: string; disabled: boolean; onClick: () => void }) {
  const on = state === 'on'
  const busy = state === 'busy'
  return (
    <div className="relative flex size-60 shrink-0 items-center justify-center">
      {/* The background: a still blue light behind it, on only. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-10 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_30%,transparent)_0%,transparent_62%)] transition-opacity duration-700',
          on ? 'opacity-100' : 'opacity-0'
        )}
      />

      {/* The bezel: a ring with a small gap around the button. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-2 rounded-full border transition-colors duration-500',
          on ? 'border-brand/30 bg-primary/10' : 'bg-card/60 border-white/[0.07]',
          'shadow-[inset_0_2px_6px_oklch(0_0_0/45%),0_1px_0_oklch(1_0_0/5%)]'
        )}
      />
      {busy && (
        <svg viewBox="0 0 100 100" className="text-brand absolute inset-2 size-[calc(100%-1rem)] animate-spin [animation-duration:1.4s]" aria-hidden>
          <circle cx="50" cy="50" r="49.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="56 253" />
        </svg>
      )}

      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={on ? t('Disconnect') : t('Connect')}
        className={cn(
          'group relative isolate flex size-44 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-full outline-none transition-[box-shadow,transform] duration-300 focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50',
          on
            ? 'text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/35%),inset_0_-10px_24px_oklch(0.25_0.15_265/45%),0_20px_44px_-14px_color-mix(in_oklch,var(--primary)_75%,transparent)]'
            : 'text-muted-foreground hover:text-brand shadow-[inset_0_1px_0_oklch(1_0_0/9%),inset_0_-10px_20px_oklch(0_0_0/35%),0_16px_32px_-16px_oklch(0_0_0/80%)]',
          busy && 'text-brand'
        )}
      >
        {/* The disc: lit from above, the logo blue when on; a slow turning light (on) and a highlight. */}
        <span aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <span
            className={cn(
              'absolute inset-0 transition-opacity duration-500',
              'bg-[linear-gradient(180deg,oklch(0.27_0_0)_0%,oklch(0.19_0_0)_100%)]',
              on ? 'opacity-0' : 'opacity-100'
            )}
          />
          <span
            className={cn('absolute inset-0 bg-[linear-gradient(180deg,oklch(0.56_0.24_262)_0%,var(--primary)_45%,var(--primary-deep)_100%)] transition-opacity duration-500', on ? 'opacity-100' : 'opacity-0')}
          />
          <span
            className={cn(
              'absolute -inset-[35%] animate-spin blur-2xl transition-opacity duration-700 [animation-duration:14s]',
              'bg-[conic-gradient(from_0deg,transparent_0deg,oklch(0.8_0.14_235/0.5)_70deg,transparent_150deg,transparent_210deg,oklch(0.45_0.24_285/0.55)_280deg,transparent_360deg)]',
              on ? 'opacity-100' : 'opacity-0'
            )}
          />
          <span className={cn('absolute inset-x-6 top-1.5 h-1/2 rounded-full bg-[radial-gradient(ellipse_at_top,oklch(1_0_0/0.28),transparent_70%)]', on ? 'opacity-100' : 'opacity-40')} />
        </span>
        <Power className="size-10 drop-shadow-[0_1px_1px_oklch(0_0_0/30%)]" strokeWidth={2.25} />
        <span className={cn('text-xs font-semibold tracking-[-0.01em]', !on && !busy && 'group-hover:text-foreground')}>{label}</span>
      </button>
    </div>
  )
}
