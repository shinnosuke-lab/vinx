import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import html2canvas from 'html2canvas'
import { createTerminal, closeTerminal, terminalWsUrl } from './api'
import { storeTerminalSid, removeTerminalSid } from './terminal-sids'
import { t, tf } from './i18n'
import { TerminalAgentChat } from './TerminalAgentChat'
import type { TerminalAgentChatHandle } from './TerminalAgentChat'

const THEME_BG = '#18181b'
const THEME_FG = '#e4e4e7'
const THEME_CURSOR = '#e4e4e7'
const THEME_SEL_BG = '#264f78'
const STATUS_DEFAULT = '#3f3f46'
const STATUS_GREEN = '#22c55e'
const STATUS_ERROR = '#ef4444'
const FONT_MONO = 'JetBrains Mono, Cascadia Code, SF Mono, Monaco, monospace'

interface TerminalPaneProps {
  reuseSid?: string
  onClose?: () => void
  onSidReady?: (sid: string) => void
}

interface SelectionMenu {
  x: number
  y: number
  text: string
}

export default function TerminalPane({ reuseSid, onClose, onSidReady }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const agentChatRef = useRef<TerminalAgentChatHandle>(null)
  const [status, setStatus] = useState(t('connecting'))
  const [statusBg, setStatusBg] = useState(STATUS_DEFAULT)
  const [sid, setSid] = useState('')
  const sidRef = useRef('')
  const [reconnectKey, setReconnectKey] = useState(0)
  const [selMenu, setSelMenu] = useState<SelectionMenu | null>(null)
  const [copyOk, setCopyOk] = useState(false)
  const selMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontSize: 12,
      fontFamily: FONT_MONO,
      theme: {
        background: THEME_BG,
        foreground: THEME_FG,
        cursor: THEME_CURSOR,
        selectionBackground: THEME_SEL_BG,
        scrollbarSliderBackground: 'rgba(255, 255, 255, 0.12)',
        scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.25)',
        scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.35)',
      },
    })
    termRef.current = term

    const fitAddon = new FitAddon()
    fitRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(el)

    // WebGL renderer for crisp integer-pixel rows. First arg is
    // preserveDrawingBuffer (kept on so handleScreenshot can read pixels
    // back). Falls back to the DOM renderer if the GPU context can't be
    // created (headless / GPU blocklist) — terminal still works.
    try {
      const webgl = new WebglAddon(true)
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('[terminal] WebGL renderer unavailable, falling back to DOM:', err)
    }

    let ws: WebSocket | null = null
    let disposed = false

    // Double rAF lets flex layout settle before FitAddon measures the parent.
    // After fit(), guard the WebGL half-row clipping bug: at fractional DPR the
    // canvas ends up a fraction of a row taller than FitAddon's CSS-px
    // measurement predicted, so the last row is clipped by overflow:hidden. If
    // we detect the overflow, shrink xterm by one row so screen == canvas.
    const safeFit = () => {
      if (disposed) return
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (disposed) return
          try {
            const fit = fitRef.current
            const tm = termRef.current
            const host = containerRef.current
            if (!fit || !tm || !host) return
            fit.fit()
            const xtermEl = host.querySelector('.xterm') as HTMLElement | null
            const screen = host.querySelector('.xterm-screen') as HTMLElement | null
            if (xtermEl && screen && tm.rows > 1) {
              if (screen.scrollHeight > xtermEl.clientHeight) {
                tm.resize(tm.cols, tm.rows - 1)
              }
            }
          } catch {
            /* not laid out yet / disposed */
          }
        }),
      )
    }

    // Wait for webfont resolution before the first fit; otherwise xterm
    // measures fallback-font cell metrics and ends up off by ~0.5 row.
    if (document.fonts?.ready) {
      document.fonts.ready.then(safeFit)
    } else {
      safeFit()
    }

    async function connect() {
      setStatus(t('connecting'))
      setStatusBg(STATUS_DEFAULT)
      try {
        const resp = await createTerminal(reconnectKey === 0 ? reuseSid : undefined)
        if (disposed) return

        setSid(resp.sid)
        sidRef.current = resp.sid
        storeTerminalSid(resp.sid)
        onSidReady?.(resp.sid)

        ws = new WebSocket(terminalWsUrl(resp.sid))
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        let firstData = true
        ws.onopen = () => {
          const { cols, rows } = term
          ws?.send(JSON.stringify({ t: 'resize', cols, rows }))
        }

        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data === 'string') {
            // Control frame: {"t":"status"|"exit"}
            try {
              const msg = JSON.parse(ev.data)
              if (msg.t === 'status') {
                setStatus(t('connected'))
                setStatusBg(STATUS_GREEN)
              } else if (msg.t === 'exit') {
                setStatus(t('sessionEnded'))
                setStatusBg(STATUS_DEFAULT)
              }
            } catch {
              /* ignore malformed control frame */
            }
            return
          }
          // Binary frame: raw PTY output bytes.
          term.write(new Uint8Array(ev.data as ArrayBuffer))
          if (firstData) {
            firstData = false
            safeFit()
          }
        }

        ws.onerror = () => {
          setStatus(tf('connectFailed', 'WebSocket error'))
          setStatusBg(STATUS_ERROR)
        }

        ws.onclose = () => {
          if (disposed) return
          setStatus(t('disconnected'))
          setStatusBg(STATUS_DEFAULT)
        }

        term.onData((data) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'data', d: data }))
          }
        })

        term.onResize(({ cols, rows }) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'resize', cols, rows }))
          }
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatus(tf('connectFailed', msg))
        setStatusBg(STATUS_ERROR)
      }
    }

    connect()

    const resizeObserver = new ResizeObserver(() => safeFit())
    resizeObserver.observe(el)

    const onMouseUp = (ev: MouseEvent) => {
      setTimeout(() => {
        const sel = term.getSelection()
        if (sel && sel.length > 0) {
          const menuW = 100
          const menuH = 32
          const margin = 8
          let x = ev.clientX - menuW / 2
          let y = ev.clientY - menuH - margin
          if (y < margin) y = ev.clientY + margin
          if (x < margin) x = margin
          if (x + menuW > window.innerWidth - margin) x = window.innerWidth - margin - menuW
          setSelMenu({ x, y, text: sel })
        }
      }, 10)
    }
    el.addEventListener('mouseup', onMouseUp)

    const onMouseDown = (ev: MouseEvent) => {
      if (selMenuRef.current?.contains(ev.target as Node)) return
      setSelMenu(null)
    }
    document.addEventListener('mousedown', onMouseDown)

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setSelMenu(null)
    }
    document.addEventListener('keydown', onKeyDown)

    const onScroll = () => setSelMenu(null)
    const viewport = el.querySelector('.xterm-viewport')
    viewport?.addEventListener('scroll', onScroll)

    const onVisible = () => {
      if (document.visibilityState === 'visible') safeFit()
    }
    const onWinResize = () => safeFit()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('resize', onWinResize)

    const closeBridge = () => {
      const s = sidRef.current
      if (!s) return
      removeTerminalSid(s)
      closeTerminal(s)
    }

    const onBeforeUnload = () => closeBridge()
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      disposed = true
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('resize', onWinResize)
      document.removeEventListener('visibilitychange', onVisible)
      el.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      viewport?.removeEventListener('scroll', onScroll)
      resizeObserver.disconnect()
      wsRef.current?.close()
      wsRef.current = null
      termRef.current?.dispose()
      termRef.current = null
      closeBridge()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectKey])

  const handleReconnect = useCallback(() => {
    setReconnectKey((k) => k + 1)
  }, [])

  const handleSelCopy = useCallback(async () => {
    if (!selMenu) return
    const text = selMenu.text
    let ok = false
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        ok = true
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '0'
        ta.style.left = '0'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        try {
          ok = document.execCommand('copy')
        } finally {
          document.body.removeChild(ta)
        }
      }
    } catch {
      ok = false
    }
    setCopyOk(ok)
    setTimeout(() => {
      setCopyOk(false)
      setSelMenu(null)
    }, 800)
  }, [selMenu])

  const handleSelInsertAI = useCallback(() => {
    if (!selMenu) return
    agentChatRef.current?.openWithText(selMenu.text)
    setSelMenu(null)
    termRef.current?.clearSelection()
  }, [selMenu])

  const handleSelSendAI = useCallback(() => {
    if (!selMenu) return
    agentChatRef.current?.sendText(selMenu.text)
    setSelMenu(null)
    termRef.current?.clearSelection()
  }, [selMenu])

  const [screenshotOk, setScreenshotOk] = useState(false)

  const handleScreenshot = useCallback(async () => {
    const el = containerRef.current
    if (!el) return

    try {
      const term = termRef.current
      if (term) term.refresh(0, term.rows - 1)
    } catch {
      /* ignore */
    }

    const triggerDownload = (dataUrl: string) => {
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `terminal-${sidRef.current.slice(0, 8) || 'shell'}-${Date.now()}.png`
      a.click()
      setScreenshotOk(true)
      setTimeout(() => setScreenshotOk(false), 1500)
    }

    // Prefer the WebGL renderer's own <canvas> layers: html2canvas doesn't
    // reliably read WebGL canvases, but the addon's canvases are same-origin
    // and can be drawImage'd directly.
    const screen = el.querySelector('.xterm-screen')
    const canvases = screen
      ? (Array.from(screen.querySelectorAll('canvas')) as HTMLCanvasElement[])
      : []

    if (canvases.length > 0) {
      const w = Math.max(...canvases.map((c) => c.width))
      const h = Math.max(...canvases.map((c) => c.height))
      if (w && h) {
        const out = document.createElement('canvas')
        out.width = w
        out.height = h
        const ctx = out.getContext('2d')
        if (ctx) {
          ctx.fillStyle = THEME_BG
          ctx.fillRect(0, 0, w, h)
          for (const c of canvases) {
            try {
              ctx.drawImage(c, 0, 0)
            } catch {
              /* tainted canvas */
            }
          }
          triggerDownload(out.toDataURL('image/png'))
          return
        }
      }
    }

    // DOM-renderer fallback.
    try {
      const canvas = await html2canvas(el, { backgroundColor: THEME_BG })
      triggerDownload(canvas.toDataURL('image/png'))
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div className="terminal-pane">
      {/* Single pane (no onClose): skip the header entirely so the xterm body
          fills the pane; it reappears in multi-pane layouts. */}
      {onClose && (
        <div className="terminal-header">
          {sid && <span className="terminal-sid">SID: {sid.slice(0, 8)}</span>}
          <div className="terminal-header-spacer" />
          <button className="terminal-close" onClick={onClose} title={t('closeTerminal')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      )}
      <div className="terminal-body" ref={containerRef} />
      <div className="terminal-footer">
        <div className="terminal-footer-left">
          <button
            className={`terminal-footer-btn${screenshotOk ? ' terminal-footer-btn-ok' : ''}`}
            onClick={handleScreenshot}
            title={t('screenshot')}
          >
            {screenshotOk ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--status-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                <circle cx="12" cy="13" r="4"></circle>
              </svg>
            )}
          </button>
          <button
            className={`terminal-footer-btn${statusBg === STATUS_ERROR ? ' terminal-footer-btn-alert' : ''}`}
            onClick={handleReconnect}
            title={t('reconnect')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
          </button>
        </div>
        <div className="terminal-status-indicator" title={status}>
          <div className="terminal-status-dot" style={{ backgroundColor: statusBg }} />
          <span>{status}</span>
        </div>
      </div>
      {sid && <TerminalAgentChat ref={agentChatRef} terminalSid={sid} />}
      {selMenu && (
        <div ref={selMenuRef} className="terminal-selection-menu" style={{ left: selMenu.x, top: selMenu.y }}>
          <button className="terminal-sel-btn" onClick={handleSelCopy} title={t('copy')}>
            {copyOk ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--status-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>
          <button className="terminal-sel-btn" onClick={handleSelSendAI} title={t('insertAISend')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
          <button className="terminal-sel-btn" onClick={handleSelInsertAI} title={t('insertAI')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
