import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "../src/theme.css"
import { TerminalApp } from "../src/components/terminal/TerminalApp"

// Web SSH terminal SPA entry. Served by the agent at `/terminal/`; the shell
// runs locally via PTY over `/api/terminal/{sid}/ws`. Wrapped in `.acc-root
// .dark` so the reused chat renderers (in the assistant panel) get their
// Tailwind theme tokens; the terminal chrome itself is plain CSS (terminal.css).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="acc-root dark term-root">
      <TerminalApp />
    </div>
  </StrictMode>,
)
