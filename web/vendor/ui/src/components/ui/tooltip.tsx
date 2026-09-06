import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "@agentchat/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

/** Nearest `.acc-root` host so the portalled content inherits the library's
 *  scoped theme/dark tokens and escapes any `overflow-hidden` ancestor. */
function accRootContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined
  return (document.querySelector(".acc-root") as HTMLElement | null) ?? undefined
}

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal container={accRootContainer()}>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "acc-tip z-50 overflow-hidden rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
