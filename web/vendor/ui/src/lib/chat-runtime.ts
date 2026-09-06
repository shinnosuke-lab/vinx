import { createContext, useContext } from "react"
import type { ChatClient } from "../client"

/**
 * Runtime handle a tool card may need for side-effecting actions (e.g. the
 * `set_chat_style` card's "save this theme" button): the live API client plus
 * the current session id for provenance. Deliberately kept OUT of the public
 * `ToolRenderProps` contract — host-supplied renderers stay a pure
 * `(props) => ReactNode`. Only the built-in cards that AgentChat mounts read
 * this; surfaces that do not provide it (e.g. the terminal panel) simply have
 * `null`, and the affordance hides itself.
 */
/** Live view of one running sub-agent (`task` call), keyed by tool_call id. */
export interface SubagentLive {
  /** Current activity line (tool the child is executing, or a status note). */
  note: string
  /** Wall-clock ms when the first `subagent` frame arrived (elapsed basis). */
  startedAt: number
  /** True after a per-task cancel was requested, until its tool_result lands. */
  cancelling: boolean
  /** The child's transcript session id (`task-<uuid>`), from the `subagent`
   *  frames — lets the task card deep-link to the live sub-session view
   *  while the child is still running. */
  sessionId?: string
  /** The task's human-readable name (its `description` argument), riding the
   *  `subagent` frames — titles the progress row even when this tab never saw
   *  the parent round's tool_start (re-attach after a trimmed replay). */
  label?: string
}

export interface ChatRuntime {
  client: ChatClient
  sessionId: string | null
  /** Live sub-agent state for the streaming turn; absent on static surfaces. */
  subagents?: Record<string, SubagentLive>
  /** Cancel ONE running sub-agent by its `task` tool_call id. */
  cancelTask?: (taskId: string) => void
  /** Host-provided deep link to a session id (e.g. `#/chat/<id>`), used by
   *  the `task` card's "view transcript" anchor. */
  sessionHref?: (id: string) => string
  /** Look up an earlier tool call of this transcript by its tool_call id.
   *  The `recall_result` card uses it to show a recalled output the way the
   *  original card did: the original's arguments drive that renderer's
   *  header (the command, the path, the pattern). Undefined when the call is
   *  not in the transcript any more (recalled from the archive after a
   *  compaction rewrote the history, or this surface keeps none). */
  findToolCall?: (callId: string) => { name: string; args?: string } | undefined
  /** Scroll the transcript to an earlier tool call, unfolding whatever hides
   *  it (its step group, the card itself) — see lib/reveal. */
  revealToolCall?: (callId: string) => void
}

export const ChatRuntimeContext = createContext<ChatRuntime | null>(null)

export function useChatRuntime(): ChatRuntime | null {
  return useContext(ChatRuntimeContext)
}
