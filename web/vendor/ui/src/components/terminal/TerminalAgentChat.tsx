import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ArrowDown, Sparkles, SquareTerminal } from 'lucide-react'
import { VINX_LOGO } from '../../assets/vinx-logo'
import { createChatClient } from '@agentchat/client'
import { Markdown } from '@agentchat/components/chat/markdown'
import { ReasoningBlock } from '@agentchat/components/chat/reasoning-block'
import { ToolCallBlock } from '@agentchat/components/chat/tool-call-block'
import { ConfirmBar } from '@agentchat/components/chat/confirm-bar'
import { AskUserBar } from '@agentchat/components/chat/ask-user-bar'
import { ChatWelcome } from '@agentchat/components/chat/chat-welcome'
import { ChatInput } from '@agentchat/components/chat/chat-input'
import { defaultToolRenderers } from '@agentchat/components/chat/tools'
import type { AskAnswer, AskQuestion, ChatEvent, ToolRenderer, ToolRenderProps } from '@agentchat/types'
import { t, tf } from './i18n'

/**
 * Floating AI assistant docked in the corner of each terminal pane.
 *
 * The panel *chrome* is the FAB, a resizable/fullscreen panel, a welcome card
 * and an input row; the *data layer* is
 * agent-core's own `createChatClient` (SSE `/api/chat`), and message bodies are
 * rendered with agent-core's shared chat components (Markdown, reasoning + tool
 * cards, confirm bar) so the look matches the main Copilot chat.
 *
 * v1 wiring: the assistant runs against the agent's own tools (e.g. `run_shell`
 * executes server-side, results shown in the tool card). It does NOT inject
 * commands into the user's interactive PTY — that (vinx's terminal_send +
 * scrollback narration) is a later phase.
 */

interface Message {
  id: number
  role: 'user' | 'assistant' | 'status' | 'tool' | 'error'
  content: string
  toolCallId?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  toolSuccess?: boolean
  reasoning?: string
}

interface PendingConfirm {
  id: string
  name: string
  arguments: string
}

interface PendingAskUser {
  id: string
  questions: AskQuestion[]
  /** Seconds until the backend auto-picks defaults (unattended sessions). */
  timeoutSecs?: number | null
}

/**
 * Inside the terminal page the `open_terminal` button would just reopen what
 * the user is already looking at — render a quiet inline note instead. The
 * main Copilot chat keeps the default button renderer.
 */
function OpenTerminalHere({ result, isRunning }: ToolRenderProps) {
  if (isRunning && !result) return null
  return (
    <div className="mt-1 flex items-center gap-1.5 pb-1 pl-1 text-[11px] text-muted-foreground">
      <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
      {t('alreadyInTerminal')}
    </div>
  )
}

/**
 * One transcript row, memoized: a streaming flush touches only the last
 * assistant row and the running tool row, and the rest of the list must not
 * re-render for every batch — the v86 emulator shares this main thread.
 */
const MessageRow = memo(function MessageRow({
  msg,
  isLast,
  loading,
  renderers,
}: {
  msg: Message
  isLast: boolean
  loading: boolean
  renderers: Record<string, ToolRenderer>
}) {
  if (msg.role === 'assistant' && !msg.content && !msg.reasoning && !loading) return null
  if (msg.role === 'tool') {
    return (
      <div className="tac-msg">
        <ToolCallBlock
          name={msg.toolName || ''}
          args={msg.toolArgs}
          result={msg.toolResult}
          success={msg.toolSuccess}
          isRunning={loading && !msg.toolResult}
          renderers={renderers}
        />
      </div>
    )
  }
  if (msg.role === 'status') {
    return <div className="tac-msg-status">{msg.content}</div>
  }
  if (msg.role === 'error') {
    return <div className="tac-msg-error">{msg.content}</div>
  }
  if (msg.role === 'user') {
    return (
      <div className="tac-msg tac-msg-user">
        <div className="tac-msg-user-bubble">{msg.content}</div>
      </div>
    )
  }
  const streamingHere = loading && isLast
  const showThinking = !msg.content && !msg.reasoning && streamingHere
  return (
    <div className="tac-msg">
      {msg.reasoning && <ReasoningBlock content={msg.reasoning} isStreaming={streamingHere} />}
      {msg.content ? (
        <div className="tac-msg-assistant-body">
          <Markdown content={msg.content} isStreaming={streamingHere} />
        </div>
      ) : showThinking ? (
        <span className="tac-thinking">{t('thinking')}</span>
      ) : null}
    </div>
  )
})

export interface TerminalAgentChatHandle {
  openWithText: (text: string) => void
  /** Open the panel and send `text` immediately (staged in the input if a turn
   *  is already in progress). */
  sendText: (text: string) => void
}

interface TerminalAgentChatProps {
  /** Terminal session id (reserved for future PTY-targeted tools). */
  terminalSid?: string
  /** Extra tool cards merged over the defaults (the in-terminal
   *  `open_terminal` note stays); how a host page draws its own tools. */
  toolRenderers?: Record<string, ToolRenderer>
}

let nextMsgId = 0

export const TerminalAgentChat = forwardRef<TerminalAgentChatHandle, TerminalAgentChatProps>(
  function TerminalAgentChat({ toolRenderers }, ref) {
    const client = useMemo(() => createChatClient('', { origin: 'terminal' }), [])
    const renderers = useMemo(
      () => ({ ...defaultToolRenderers, ...toolRenderers, open_terminal: OpenTerminalHere }),
      [toolRenderers],
    )

    const [open, setOpen] = useState(false)
    const [panelMode, setPanelMode] = useState<'default' | 'full'>('default')
    const [input, setInput] = useState('')
    const [messages, setMessages] = useState<Message[]>([])
    const [loading, setLoading] = useState(false)
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
    const [pendingAskUser, setPendingAskUser] = useState<PendingAskUser | null>(null)
    /** Transient one-line progress from `task` sub-agents (`subagent` frames). */
    const [subagentNote, setSubagentNote] = useState<string | null>(null)
    // Session-scoped full-auto (backend-owned; synced from SSE `session` frames).
    const [autoConfirm, setAutoConfirm] = useState(false)
    const [panelHeight, setPanelHeight] = useState(420)
    const [modelName, setModelName] = useState('')

    // Model badge on the empty-state composer (same source as the main chat).
    useEffect(() => {
      client
        .getMeta()
        .then((m) => {
          if (typeof m?.model === 'string') setModelName(m.model)
        })
        .catch(() => {})
    }, [client])

    const messagesEndRef = useRef<HTMLDivElement>(null)
    const messagesContainerRef = useRef<HTMLDivElement>(null)
    const userScrolledUpRef = useRef(false)
    const controllerRef = useRef<AbortController | null>(null)
    const chatContainerRef = useRef<HTMLDivElement>(null)
    const resizeRef = useRef<{ startY: number; startH: number } | null>(null)
    const heightInitRef = useRef(false)
    const sessionIdRef = useRef<string | null>(null)
    // Latest `sendMessage` / `queueLocal` / `loading` for the imperative
    // handle and the `done` handler (avoids stale closures).
    const sendMessageRef = useRef<(text: string) => void>(() => {})
    const queueLocalRef = useRef<(text: string) => void>(() => {})
    const loadingRef = useRef(false)
    const toolArgsRef = useRef<Record<string, string>>({})
    /** Messages typed while a turn runs; sent the moment it finishes. */
    const queuedRef = useRef<string[]>([])
    // `read_skill` calls are hidden (same as the main Copilot chat): skill
    // activation is narrated via the `skill` event's status line instead.
    const hiddenToolIdsRef = useRef<Set<string>>(new Set())

    useImperativeHandle(
      ref,
      () => ({
        openWithText(text: string) {
          setOpen(true)
          setInput((prev) => (prev.trim() ? prev + '\n' + text : text))
          setTimeout(() => {
            chatContainerRef.current?.querySelector('textarea')?.focus()
          }, 100)
        },
        sendText(text: string) {
          setOpen(true)
          // A turn in progress -> queue it (runs when the turn ends); else send.
          if (loadingRef.current) queueLocalRef.current(text)
          else sendMessageRef.current(text)
        },
      }),
      [],
    )

    useEffect(() => {
      if (open && !heightInitRef.current) {
        heightInitRef.current = true
        const containerH = chatContainerRef.current?.clientHeight ?? 0
        if (containerH > 0) {
          const twoThirds = Math.round((containerH * 2) / 3)
          setPanelHeight(containerH < 420 ? containerH : Math.max(420, twoThirds))
        }
      }
    }, [open])

    // Re-runs when the messages container (absent in the empty state) mounts.
    const hasMessages = messages.length > 0
    const [showJump, setShowJump] = useState(false)
    useEffect(() => {
      const el = messagesContainerRef.current
      if (!el) return
      const onScroll = () => {
        const threshold = 80
        const up = el.scrollTop + el.clientHeight < el.scrollHeight - threshold
        userScrolledUpRef.current = up
        setShowJump(up)
      }
      el.addEventListener('scroll', onScroll, { passive: true })
      return () => el.removeEventListener('scroll', onScroll)
    }, [open, hasMessages])

    // Deterministic follow: pin the container to its bottom synchronously
    // after each commit, unless the person scrolled away. The previous
    // smooth scrollIntoView raced the (async) scroll handler above during a
    // stream and ate upward scrolls; a direct scrollTop assignment cannot.
    useLayoutEffect(() => {
      const el = messagesContainerRef.current
      if (!el || userScrolledUpRef.current) return
      el.scrollTop = el.scrollHeight
    }, [messages, open])

    const jumpToBottom = useCallback(() => {
      const el = messagesContainerRef.current
      if (!el) return
      userScrolledUpRef.current = false
      setShowJump(false)
      el.scrollTop = el.scrollHeight
    }, [])

    // ── Streaming deltas, batched ──
    // Every token used to be its own setState and a full list re-render, on
    // the same main thread as the v86 emulator. Deltas pool in a ref and land
    // at most every 50ms; any non-delta event flushes first, so ordering
    // (content → tool_start → result → next assistant) still holds.
    const pendingRef = useRef({ content: '', reasoning: '', argIds: new Set<string>() })
    const flushTimerRef = useRef<number | null>(null)

    const flushDeltas = useCallback(() => {
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      const pending = pendingRef.current
      if (!pending.content && !pending.reasoning && pending.argIds.size === 0) return
      pendingRef.current = { content: '', reasoning: '', argIds: new Set() }
      setMessages((prev) => {
        const updated = [...prev]
        if (pending.content || pending.reasoning) {
          for (let j = updated.length - 1; j >= 0; j--) {
            if (updated[j].role === 'assistant') {
              updated[j] = {
                ...updated[j],
                content: updated[j].content + pending.content,
                reasoning: (updated[j].reasoning || '') + pending.reasoning,
              }
              break
            }
          }
        }
        if (pending.argIds.size) {
          for (let j = 0; j < updated.length; j++) {
            const m = updated[j]
            if (m.role === 'tool' && m.toolCallId && pending.argIds.has(m.toolCallId)) {
              updated[j] = { ...m, toolArgs: toolArgsRef.current[m.toolCallId] }
            }
          }
        }
        return updated
      })
    }, [])

    const queueFlush = useCallback(() => {
      if (flushTimerRef.current != null) return
      flushTimerRef.current = window.setTimeout(flushDeltas, 50)
    }, [flushDeltas])

    const handleEvent = useCallback((ev: ChatEvent) => {
      // Delta events pool and return; everything else flushes first.
      switch (ev.event) {
        case 'reasoning':
          pendingRef.current.reasoning += ev.data.text ?? ''
          queueFlush()
          return
        case 'content':
          pendingRef.current.content += ev.data.text ?? ''
          queueFlush()
          return
        case 'tool_args': {
          const id = ev.data.id as string | undefined
          if (!id || hiddenToolIdsRef.current.has(id)) return
          toolArgsRef.current[id] = (toolArgsRef.current[id] || '') + (ev.data.delta ?? '')
          pendingRef.current.argIds.add(id)
          queueFlush()
          return
        }
        default:
          flushDeltas()
      }
      switch (ev.event) {
        case 'session':
          sessionIdRef.current = ev.data.session_id
          setSessionId(ev.data.session_id)
          if (Object.prototype.hasOwnProperty.call(ev.data, 'auto_confirm')) {
            setAutoConfirm(ev.data.auto_confirm === true)
          }
          break
        case 'tool_start': {
          const id = ev.data.id as string
          const name = ev.data.name as string
          if (name === 'read_skill') {
            hiddenToolIdsRef.current.add(id)
            break
          }
          const initialArgs = (ev.data.arguments as string) || ''
          toolArgsRef.current[id] = initialArgs
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId++, role: 'tool', content: '', toolCallId: id, toolName: name, toolArgs: initialArgs },
          ])
          break
        }
        case 'tool_result': {
          const id = ev.data.id as string | undefined
          // A confirm/ask resolved elsewhere (timeout auto-pick, another
          // client): its tool_result clears the now-stale bar.
          if (id) {
            setPendingConfirm((prev) => (prev && prev.id === id ? null : prev))
            setPendingAskUser((prev) => (prev && prev.id === id ? null : prev))
          }
          if (id && hiddenToolIdsRef.current.delete(id)) break
          const result = (ev.data.result as string) ?? ''
          const success = ev.data.success !== false
          setMessages((prev) => {
            let matched = false
            const updated = prev.map((m) => {
              if (!matched && m.role === 'tool' && !m.toolResult && (id ? m.toolCallId === id : true)) {
                matched = true
                return { ...m, toolResult: result, toolSuccess: success }
              }
              return m
            })
            return [...updated, { id: nextMsgId++, role: 'assistant', content: '', reasoning: '' }]
          })
          break
        }
        case 'skill': {
          // The panel has no skill chip; narrate activation as a status line.
          const name = ev.data.name
          if (typeof name === 'string' && name) {
            setMessages((prev) => [
              ...prev,
              { id: nextMsgId++, role: 'status', content: tf('skillLoaded', name) },
            ])
          }
          break
        }
        case 'status':
          setMessages((prev) => [...prev, { id: nextMsgId++, role: 'status', content: ev.data.text ?? '' }])
          break
        case 'confirm':
          setPendingConfirm({ id: ev.data.id, name: ev.data.name, arguments: ev.data.arguments })
          break
        case 'ask_user':
          setPendingAskUser({
            id: ev.data.id,
            questions: ev.data.questions,
            timeoutSecs: ev.data.timeout_secs ?? null,
          })
          break
        case 'subagent': {
          // `task` sub-agent envelope: keep a single transient progress line
          // (this panel is intentionally minimal — the parent `task` tool row
          // carries the report once the child finishes).
          const taskId = (ev.data.task_id as string | undefined)?.slice(0, 8)
          const inner = ev.data.event as string | undefined
          if (!taskId) break
          if (inner === 'tool_start') {
            setSubagentNote(
              `${t('subagentTag')} ${taskId} · ${t('subagentRunning').replace('{name}', ev.data.data?.name ?? '')}`,
            )
          } else if (inner === 'done') {
            setSubagentNote(`${t('subagentTag')} ${taskId} · ${t('subagentDone')}`)
          } else if (inner === 'error') {
            setSubagentNote(`${t('subagentTag')} ${taskId} · ${t('subagentError')}`)
          }
          break
        }
        case 'error':
          setSubagentNote(null)
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId++, role: 'error', content: tf('errorPrefix', ev.data.message ?? 'error') },
          ])
          break
        case 'done': {
          setLoading(false)
          loadingRef.current = false
          setSubagentNote(null)
          // Anything queued while the turn ran goes out now, as one message.
          const queued = queuedRef.current.splice(0).join('\n')
          if (queued) setTimeout(() => sendMessageRef.current(queued), 0)
          break
        }
        // `set_chat_style` easter egg: the terminal panel keeps its own look;
        // ignore explicitly rather than falling through as an unknown event.
        case 'style':
          break
        default:
          break
      }
    }, [flushDeltas, queueFlush])

    const sendMessage = useCallback(
      (text: string) => {
        if (!text || loadingRef.current) return
        setInput('')
        userScrolledUpRef.current = false
        setShowJump(false)
        toolArgsRef.current = {}
        pendingRef.current = { content: '', reasoning: '', argIds: new Set() }
        setMessages((prev) => [
          ...prev,
          { id: nextMsgId++, role: 'user', content: text },
          { id: nextMsgId++, role: 'assistant', content: '', reasoning: '' },
        ])
        setLoading(true)
        loadingRef.current = true

        const controller = new AbortController()
        controllerRef.current = controller
        client
          .streamChat(text, sessionIdRef.current, handleEvent, controller.signal)
          .catch((e) => {
            if (controller.signal.aborted) return
            setMessages((prev) => [
              ...prev,
              { id: nextMsgId++, role: 'error', content: tf('requestFailed', e instanceof Error ? e.message : String(e)) },
            ])
          })
          .finally(() => {
            if (!controller.signal.aborted) {
              setLoading(false)
              loadingRef.current = false
            }
          })
      },
      [client, handleEvent],
    )

    /** Typed while a turn runs: hold it here, sent as one message on `done`. */
    const queueLocal = useCallback((text: string) => {
      queuedRef.current.push(text)
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId++, role: 'status', content: 'queued — sends when this turn finishes' },
      ])
    }, [])

    // Keep the imperative-handle refs pointing at the current values.
    sendMessageRef.current = sendMessage
    queueLocalRef.current = queueLocal
    loadingRef.current = loading

    const handleSend = useCallback(() => {
      const text = input.trim()
      if (!text) return
      if (loadingRef.current) {
        setInput('')
        queueLocal(text)
        return
      }
      sendMessage(text)
    }, [input, queueLocal, sendMessage])

    // The composer's "send now": inject into the RUNNING turn (the engine's
    // steer lane) rather than waiting behind it.
    const handleSendNow = useCallback(() => {
      const text = input.trim()
      if (!text) return
      const sid = sessionIdRef.current
      setInput('')
      if (!sid || !loadingRef.current) {
        sendMessage(text)
        return
      }
      void client.steer(sid, text).then((steered) => {
        if (steered) {
          setMessages((prev) => [...prev, { id: nextMsgId++, role: 'user', content: text }])
        } else {
          // The turn ended in the gap; nothing to steer into.
          sendMessage(text)
        }
      })
    }, [input, client, sendMessage])

    const handleConfirm = useCallback(
      (confirmed: boolean, amendedArgs?: unknown, auto?: boolean) => {
        const sid = sessionIdRef.current
        if (sid && pendingConfirm) {
          // The call id rides along so a sub-agent's gate (which looks
          // identical) answers the right agent. The allow-pattern and
          // allow-dir lanes are deliberately absent: neither has meaning for
          // this page's VM device, and dead buttons teach distrust.
          const callId = pendingConfirm.id
          if (confirmed && auto) {
            // Badge follows the server: light it only after the confirm
            // actually reached a pending request.
            void client
              .confirm(sid, confirmed, amendedArgs, undefined, undefined, auto, callId)
              .then((ok) => {
                if (ok) setAutoConfirm(true)
              })
          } else {
            void client.confirm(sid, confirmed, amendedArgs, undefined, undefined, auto, callId)
          }
          setPendingConfirm(null)
        }
      },
      [client, pendingConfirm],
    )

    // Badge click: turn session full-auto off (applies to the in-flight
    // turn's next tool call too — the backend flag is shared with the loop).
    const handleAutoConfirmOff = useCallback(() => {
      const sid = sessionIdRef.current
      if (sid) void client.setAutoConfirm(sid, false)
      setAutoConfirm(false)
    }, [client])

    const handleAskUser = useCallback(
      (answers: AskAnswer[], cancelled: boolean) => {
        const sid = sessionIdRef.current
        if (sid && pendingAskUser) {
          void client.answer(sid, answers, cancelled, pendingAskUser.id)
          setPendingAskUser(null)
        }
      },
      [client, pendingAskUser],
    )

    const handleAskUserActivity = useCallback(() => {
      const sid = sessionIdRef.current
      if (sid && pendingAskUser) void client.askActivity(sid, pendingAskUser.id)
    }, [client, pendingAskUser])

    const handleStop = useCallback(() => {
      const sid = sessionIdRef.current
      if (sid) void client.cancel(sid)
      controllerRef.current?.abort()
      setLoading(false)
      loadingRef.current = false
    }, [client])

    const handleClear = useCallback(() => {
      // Cancel before forgetting the session: a cleared panel with a live
      // turn would leave a ghost agent running commands on the machine with
      // nobody watching and no way left to stop it.
      const sid = sessionIdRef.current
      if (sid) void client.cancel(sid)
      controllerRef.current?.abort()
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      pendingRef.current = { content: '', reasoning: '', argIds: new Set() }
      queuedRef.current = []
      setMessages([])
      setSessionId(null)
      sessionIdRef.current = null
      setPendingConfirm(null)
      setPendingAskUser(null)
      setSubagentNote(null)
      setLoading(false)
      loadingRef.current = false
      userScrolledUpRef.current = false
      setShowJump(false)
      toolArgsRef.current = {}
      hiddenToolIdsRef.current = new Set()
    }, [client])

    const isEmpty = !hasMessages

    // One composer for both states: the shared ChatInput (IME-safe Enter,
    // stop button, full-auto badge). While a turn streams the input stays
    // live — Enter queues for after the turn, "send now" steers into it.
    const composer = (
      <div className="tac-composer">
        {showJump && (
          <button type="button" className="tac-jump" onClick={jumpToBottom} title="Jump to bottom">
            <ArrowDown size={13} />
          </button>
        )}
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={handleStop}
          streaming={loading}
          hasMessages
          modelName={modelName}
          autoConfirm={autoConfirm}
          onAutoConfirmOff={handleAutoConfirmOff}
          queueEnabled
          onSendNow={handleSendNow}
        />
      </div>
    )

    const handleResizeStart = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault()
        resizeRef.current = { startY: e.clientY, startH: panelHeight }
        const onMouseMove = (ev: MouseEvent) => {
          if (!resizeRef.current) return
          const delta = resizeRef.current.startY - ev.clientY
          const maxH = chatContainerRef.current?.clientHeight ?? 800
          const newH = Math.min(maxH, Math.max(200, resizeRef.current.startH + delta))
          setPanelHeight(newH)
        }
        const onMouseUp = () => {
          resizeRef.current = null
          document.removeEventListener('mousemove', onMouseMove)
          document.removeEventListener('mouseup', onMouseUp)
          document.body.style.userSelect = ''
          document.body.style.cursor = ''
        }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'ns-resize'
        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
      },
      [panelHeight],
    )

    return (
      <div
        ref={chatContainerRef}
        className={`tac${open ? ' tac-open' : ''}${open && panelMode === 'full' ? ' tac-full' : ''}`}
      >
        {!open && (
          <button
            className={
              'tac-fab' +
              (pendingConfirm || pendingAskUser ? ' tac-fab-attn' : loading ? ' tac-fab-busy' : '')
            }
            onClick={() => setOpen(true)}
            title={
              pendingConfirm || pendingAskUser
                ? 'The assistant is waiting for you'
                : t('agentFab')
            }
          >
            <img className="tac-fab-logo" src={VINX_LOGO} alt="" />
            {(pendingConfirm || pendingAskUser) && <span className="tac-fab-dot" />}
          </button>
        )}

        {open && (
          <div className="tac-panel" style={panelMode === 'default' ? { height: panelHeight } : undefined}>
            {panelMode === 'default' && (
              <div className="tac-resize-handle" onMouseDown={handleResizeStart}>
                <div className="tac-resize-bar" />
              </div>
            )}
            <div className="tac-header">
              <div className="tac-title">
                <Sparkles size={14} />
                <span>{t('agentTitle')}</span>
              </div>
              <div className="tac-header-actions">
                {messages.length > 0 && (
                  <button className="tac-header-btn" onClick={handleClear} title={t('newSession')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path>
                    </svg>
                  </button>
                )}
                {panelMode === 'default' ? (
                  <button className="tac-header-btn" onClick={() => setPanelMode('full')} title={t('fullscreen')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9"></polyline>
                      <polyline points="9 21 3 21 3 15"></polyline>
                      <line x1="21" y1="3" x2="14" y2="10"></line>
                      <line x1="3" y1="21" x2="10" y2="14"></line>
                    </svg>
                  </button>
                ) : (
                  <button className="tac-header-btn" onClick={() => setPanelMode('default')} title={t('restoreDefault')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20"></polyline>
                      <polyline points="20 10 14 10 14 4"></polyline>
                      <line x1="14" y1="10" x2="21" y2="3"></line>
                      <line x1="3" y1="21" x2="10" y2="14"></line>
                    </svg>
                  </button>
                )}
                <button className="tac-header-btn" onClick={() => setOpen(false)} title={t('minimize')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>

            {isEmpty ? (
              <div className="tac-empty">
                <ChatWelcome />
                <ChatInput
                  value={input}
                  onChange={setInput}
                  onSend={handleSend}
                  onStop={handleStop}
                  streaming={loading}
                  hasMessages={false}
                  centered
                  modelName={modelName}
                  autoConfirm={autoConfirm}
                  onAutoConfirmOff={handleAutoConfirmOff}
                />
                <div className="tac-welcome-chips">
                  {[t('chipDiskUsage'), t('chipNetworkStatus'), t('chipSystemLogs')].map((tip) => (
                    <button key={tip} className="tac-welcome-chip" onClick={() => sendMessage(tip)}>
                      {tip}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div ref={messagesContainerRef} className="tac-messages">
                  {messages.map((msg, i) => (
                    <MessageRow
                      key={msg.id}
                      msg={msg}
                      isLast={i === messages.length - 1}
                      loading={loading}
                      renderers={renderers}
                    />
                  ))}
                  <div ref={messagesEndRef} />
                </div>

                {pendingConfirm && (
                  <ConfirmBar
                    toolName={pendingConfirm.name}
                    toolArgs={pendingConfirm.arguments}
                    onConfirm={(amendedArgs) => handleConfirm(true, amendedArgs)}
                    onConfirmAll={() => handleConfirm(true, undefined, true)}
                    onCancel={() => handleConfirm(false)}
                  />
                )}


                {pendingAskUser && (
                  <AskUserBar
                    questions={pendingAskUser.questions}
                    timeoutSecs={pendingAskUser.timeoutSecs}
                    onActivity={handleAskUserActivity}
                    onSubmit={(answers) => handleAskUser(answers, false)}
                    onCancel={() => handleAskUser([], true)}
                  />
                )}

                {loading && subagentNote && (
                  <div className="tac-msg-status" style={{ padding: '2px 12px' }}>
                    {subagentNote}
                  </div>
                )}

                {composer}
              </>
            )}
          </div>
        )}
      </div>
    )
  },
)
