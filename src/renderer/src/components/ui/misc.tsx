// Small shadcn/ui primitives: Separator, ScrollArea, Collapsible, Alert, Toaster.
import * as React from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { cva, type VariantProps } from 'class-variance-authority'
import { Toaster as Sonner } from 'sonner'
import { cn } from '@/lib/utils'

function Separator({ className, orientation = 'horizontal', decorative = true, ...props }: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn('bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px', className)}
      {...props}
    />
  )
}

function ScrollArea({ className, children, viewportRef, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportRef?: React.Ref<HTMLDivElement> }) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} data-slot="scroll-area-viewport" className="size-full rounded-[inherit] outline-none">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.ScrollAreaScrollbar orientation="vertical" className="flex h-full w-2.5 touch-none border-s border-s-transparent p-px transition-colors select-none">
        <ScrollAreaPrimitive.ScrollAreaThumb className="bg-foreground/15 relative flex-1 rounded-full" />
      </ScrollAreaPrimitive.ScrollAreaScrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

const Collapsible = CollapsiblePrimitive.Root
const CollapsibleTrigger = CollapsiblePrimitive.Trigger
const CollapsibleContent = CollapsiblePrimitive.Content

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        primary: 'border-brand/30 bg-primary/8 text-brand [&_[data-slot=alert-description]]:text-foreground/80',
        warning: 'border-warning/30 bg-warning/8 text-warning [&_[data-slot=alert-description]]:text-foreground/80',
        destructive: 'border-destructive/30 bg-destructive/8 text-destructive [&_[data-slot=alert-description]]:text-foreground/80'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed', className)} {...props} />
}

/**
 * Notifications: a card like the rest of the app, with an icon in the message's color and an
 * optional action (errors offer "Logs"). Errors stay longer and can be closed.
 */
function Toaster(props: React.ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      gap={10}
      icons={{
        success: <CircleCheck className="text-success size-[18px]" />,
        error: <CircleAlert className="text-destructive size-[18px]" />,
        warning: <TriangleAlert className="text-warning size-[18px]" />,
        info: <Info className="text-brand size-[18px]" />
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'group/toast bg-popover/95 text-popover-foreground flex w-[360px] items-start gap-3 rounded-xl border px-4 py-3 shadow-[inset_0_1px_0_oklch(1_0_0/5%),0_16px_40px_-12px_oklch(0_0_0/70%)] backdrop-blur-md',
          error: 'border-destructive/30',
          warning: 'border-warning/30',
          icon: 'mt-px shrink-0',
          content: 'min-w-0 flex-1 gap-0.5',
          title: 'text-sm font-medium leading-snug line-clamp-4 break-words',
          description: 'text-muted-foreground text-xs leading-relaxed',
          actionButton: 'bg-secondary hover:bg-accent text-foreground ms-auto shrink-0 cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          closeButton: '!bg-popover !border-border !text-muted-foreground hover:!text-foreground'
        }
      }}
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle, Collapsible, CollapsibleContent, CollapsibleTrigger, ScrollArea, Separator, Toaster }
