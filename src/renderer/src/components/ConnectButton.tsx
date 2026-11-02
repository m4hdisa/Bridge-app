import { Power } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import type { ButtonStyle } from '../../../shared/types'

export type ConnectState = 'off' | 'busy' | 'on'

/** The connect button, in the style picked in Settings (Dashboard by default). */
export function ConnectButton({ look = 'dashboard', ...props }: { look?: ButtonStyle; state: ConnectState; label: string; disabled: boolean; onClick: () => void }) {
  return look === 'classic' ? <ClassicButton {...props} /> : <DashboardButton {...props} />
}

/**
 * The connect button, built like a key on a car's dashboard: a round key set in a dark
 * frame, with a small light above the icon. Off: the light is dark. Connecting: it blinks blue.
 * On: it glows green (the same green as the "Protected" dot), and the key stays a little
 * pressed in, like a latched switch.
 */
function DashboardButton({ state, label, disabled, onClick }: { state: ConnectState; label: string; disabled: boolean; onClick: () => void }) {
  const on = state === 'on'
  const busy = state === 'busy'
  return (
    // The frame the key sits in.
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full p-3',
        'bg-[linear-gradient(180deg,oklch(0.2_0_0)_0%,oklch(0.15_0_0)_100%)]',
        'shadow-[inset_0_2px_6px_oklch(0_0_0/60%),inset_0_-1px_0_oklch(1_0_0/6%),0_1px_0_oklch(1_0_0/4%)]'
      )}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={on ? t('Disconnect') : t('Connect')}
        aria-pressed={on}
        className={cn(
          'group relative isolate flex size-44 cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-full outline-none',
          'transition-[transform,box-shadow,color] duration-200 focus-visible:ring-4 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          'bg-[linear-gradient(180deg,oklch(0.3_0_0)_0%,oklch(0.23_0_0)_55%,oklch(0.2_0_0)_100%)]',
          'active:translate-y-[2px] active:shadow-[inset_0_1px_0_oklch(1_0_0/6%),0_2px_4px_-1px_oklch(0_0_0/80%)]',
          on
            ? 'text-foreground translate-y-px shadow-[inset_0_1px_0_oklch(1_0_0/8%),inset_0_-4px_10px_oklch(0_0_0/30%),0_3px_6px_-1px_oklch(0_0_0/80%)]'
            : 'text-muted-foreground hover:text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/12%),inset_0_-6px_12px_oklch(0_0_0/30%),0_8px_16px_-4px_oklch(0_0_0/85%),0_2px_3px_oklch(0_0_0/60%)]'
        )}
      >
        {/* A soft sheen across the top, like light on a plastic key. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-6 top-1 -z-10 h-1/3 rounded-full bg-[radial-gradient(ellipse_at_top,oklch(1_0_0/0.1),transparent_70%)]" />

        {/* The indicator light. */}
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-7 rounded-full transition-[background-color,box-shadow] duration-300',
            on
              ? 'bg-[oklch(0.8_0.2_150)] shadow-[0_0_8px_oklch(0.8_0.2_150/80%),0_0_18px_oklch(0.75_0.2_150/45%)]'
              : busy
                ? 'bg-brand animate-pulse shadow-[0_0_8px_var(--brand)]'
                : 'bg-white/[0.12] shadow-[inset_0_1px_1px_oklch(0_0_0/60%)]'
          )}
        />
        <Power className="size-10 drop-shadow-[0_1px_0_oklch(0_0_0/60%)]" strokeWidth={2.25} />
        <span className="text-xs font-semibold tracking-[-0.01em] drop-shadow-[0_1px_0_oklch(0_0_0/60%)]">{label}</span>
      </button>
    </div>
  )
}

/**
 * The original connect button (Settings > Connect button > Classic), built like a physical
 * control: a bezel ring with a small gap, and the button itself, a disc lit from above. Connecting: a thin arc runs around the bezel (it means "working"). On: the logo blue,
 * a soft light slowly turning inside it, and a still blue light behind it all.
 */
function ClassicButton({ state, label, disabled, onClick }: { state: ConnectState; label: string; disabled: boolean; onClick: () => void }) {
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
