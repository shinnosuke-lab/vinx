import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CopilotApp } from '@vinx/agent-chat'

// Host-owned agent SPA built from agent-core component source. Customize brand,
// theme, and (later) per-tool renderers here. Same-origin API (served by the
// agent process), so basePath is empty.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CopilotApp basePath="" brand="Copilot" theme={{ accent: 'hsl(221 83% 53%)' }} />
  </StrictMode>,
)
