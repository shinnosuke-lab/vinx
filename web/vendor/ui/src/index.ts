import "./theme.css"

export { AgentChat } from "./AgentChat"
export { CopilotApp } from "./CopilotApp"
export type { CopilotAppProps } from "./CopilotApp"
export { createChatClient, ChatUnavailableError } from "./client"
export type { ChatClient } from "./client"
export { defaultToolRenderers, fallbackRenderer } from "./components/chat/tools"
export { setLabels, setLanguage } from "./lib/i18n"
export { Toaster, toast } from "./components/ui/toast"
export { ConfirmDialogHost, confirmDialog, promptDialog } from "./components/ui/confirm-dialog"

export type {
  AgentChatProps,
  AgentChatHandle,
  ToolRenderer,
  ToolRenderProps,
  ThemeTokens,
  Labels,
  ChatEvent,
  AskQuestion,
  AskOption,
  AskAnswer,
  SessionSummary,
  MessageView,
} from "./types"

export { TerminalAgentChat } from "./components/terminal/TerminalAgentChat"
export type { TerminalAgentChatHandle } from "./components/terminal/TerminalAgentChat"

// For the copy buttons on a host page's own tool cards. Gateways serve this
// over plain HTTP, where `navigator.clipboard` does not exist at all, and a
// card outside the library needs the same fallback every button inside it
// already has -- see the function's own comment.
export { copyToClipboard } from "./lib/utils"
