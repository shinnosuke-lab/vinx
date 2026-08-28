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
}

export const ChatRuntimeContext = createContext<ChatRuntime | null>(null)

export function useChatRuntime(): ChatRuntime | null {
  return useContext(ChatRuntimeContext)
}
