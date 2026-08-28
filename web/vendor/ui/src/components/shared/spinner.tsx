import { cn } from "@agentchat/lib/utils"

interface SpinnerProps {
  className?: string
  size?: "sm" | "md" | "lg"
}

export function Spinner({ className, size = "md" }: SpinnerProps) {
  const sizeClass = {
    sm: "h-4 w-4 border-[1.5px]",
    md: "h-5 w-5 border-2",
    lg: "h-8 w-8 border-2",
  }[size]

  return (
    <div
      className={cn(
        "animate-spin rounded-full border-muted-foreground/30 border-t-primary",
        sizeClass,
        className,
      )}
    />
  )
}
