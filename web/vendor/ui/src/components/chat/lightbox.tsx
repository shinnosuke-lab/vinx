import { useEffect } from "react"
import { X } from "lucide-react"

/** Full-screen image preview: dimmed backdrop + centered image. Closes on
 *  backdrop click or Escape. Rendered by the chat page for both composer
 *  chips (object URLs) and transcript thumbnails (upload URLs). */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string
  alt?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 animate-in fade-in-0 duration-100"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 inline-flex items-center justify-center rounded-full bg-black/50 p-2 text-white/80 transition-colors hover:text-white"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt ?? ""}
        className="max-h-full max-w-full rounded-sm object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
