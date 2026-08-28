import { useCallback, useRef } from 'react'

interface SplitHandleProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
}

/**
 * Drag bar between two adjacent panes. Captures the mouse on mousedown so the
 * cursor stays row-/col-resize even during fast drags.
 */
export default function SplitHandle({ direction, onResize }: SplitHandleProps) {
  const startRef = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startRef.current = direction === 'vertical' ? e.clientY : e.clientX

      const handleMove = (ev: MouseEvent) => {
        const current = direction === 'vertical' ? ev.clientY : ev.clientX
        const delta = current - startRef.current
        if (Math.abs(delta) > 1) {
          onResize(delta)
          startRef.current = current
        }
      }
      const handleUp = () => {
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = direction === 'vertical' ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [direction, onResize],
  )

  return <div className={`split-handle split-handle-${direction}`} onMouseDown={handleMouseDown} />
}
