import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { CopilotApp } from "../src"

// Reference SPA entry: the minimal full-page Copilot agent-core's `app` binary
// serves. Branding (brand / logo / theme / language) is driven entirely by the
// agent's own `/api/chat/meta` (its `meta.json` / config) — no props needed —
// which is exactly how an existing app customizes the standalone SPA with zero
// frontend code. Source-level embedders may still pass overrides as props.
// Same-origin API by default; point elsewhere via window.__AGENT_BASE__.
declare global {
  interface Window {
    __AGENT_BASE__?: string
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CopilotApp basePath={window.__AGENT_BASE__ ?? ""} />
  </StrictMode>,
)
