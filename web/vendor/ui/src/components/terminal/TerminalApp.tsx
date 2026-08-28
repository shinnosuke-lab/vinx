import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createChatClient } from '@agentchat/client'
import { setLanguage } from '@agentchat/lib/i18n'
import TerminalPane from './TerminalPane'
import Toolbar from './Toolbar'
import SplitHandle from './SplitHandle'
import { drainTerminalSids } from './terminal-sids'
import { closeTerminal } from './api'
import { setTerminalLanguage } from './i18n'
import './terminal.css'

interface Pane {
  id: string
  size: number // flex-basis percentage
  reuseSid?: string
}

let nextPaneId = 1
function genPaneId() {
  return `pane-${nextPaneId++}-${Date.now().toString(36)}`
}

const MIN_PANE_PCT = 10

/**
 * Multi-pane local-shell workspace: split layout, resize handles, reload-safe
 * SID reuse. There is no remote gateway (mac/container) concept — agent-core
 * spawns the shell on the box, so a fresh pane is just a new local PTY.
 */
export function TerminalApp() {
  const [panes, setPanes] = useState<Pane[]>([])
  const [splitDir, setSplitDir] = useState<'horizontal' | 'vertical'>('vertical')
  // Bumped once meta.lang is applied so already-rendered chrome re-reads t().
  const [, setLangEpoch] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Follow the agent's configured locale (same source as the Copilot SPA:
  // `meta.lang` from /api/chat/meta) for both the terminal chrome i18n and
  // the shared chat components. Browser auto-detect remains the fallback.
  useEffect(() => {
    createChatClient('')
      .getMeta()
      .then((meta) => {
        if (meta?.lang) {
          setLanguage(meta.lang)
          setTerminalLanguage(meta.lang)
          setLangEpoch((n) => n + 1)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const oldSids = drainTerminalSids()
    if (oldSids.length > 0) {
      const equalSize = 100 / oldSids.length
      setPanes(oldSids.map((sid) => ({ id: genPaneId(), size: equalSize, reuseSid: sid })))
    } else {
      setPanes([{ id: genPaneId(), size: 100 }])
    }
    // On a hot-reload where old SIDs weren't reused, close them so bash doesn't
    // leak (mirrors vinx's cleanup path).
    return () => {
      for (const sid of oldSids) closeTerminal(sid)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addPane = useCallback(() => {
    setPanes((prev) => {
      const newSize = 100 / (prev.length + 1)
      const scaled = prev.map((p) => ({ ...p, size: p.size * (prev.length / (prev.length + 1)) }))
      return [...scaled, { id: genPaneId(), size: newSize }]
    })
  }, [])

  const removePane = useCallback((id: string) => {
    setPanes((prev) => {
      const remaining = prev.filter((p) => p.id !== id)
      const total = remaining.reduce((s, p) => s + p.size, 0)
      return remaining.map((p) => ({ ...p, size: (p.size / total) * 100 }))
    })
  }, [])

  const handleResize = useCallback(
    (index: number, delta: number) => {
      const container = containerRef.current
      if (!container) return
      const totalPx = splitDir === 'vertical' ? container.clientHeight : container.clientWidth
      if (totalPx === 0) return
      const deltaPct = (delta / totalPx) * 100
      setPanes((prev) => {
        const updated = [...prev]
        const newA = updated[index].size + deltaPct
        const newB = updated[index + 1].size - deltaPct
        if (newA < MIN_PANE_PCT || newB < MIN_PANE_PCT) return prev
        updated[index] = { ...updated[index], size: newA }
        updated[index + 1] = { ...updated[index + 1], size: newB }
        return updated
      })
    },
    [splitDir],
  )

  return (
    <div className="app">
      <Toolbar
        paneCount={panes.length}
        splitDir={splitDir}
        onAdd={addPane}
        onToggleSplit={() => setSplitDir((d) => (d === 'horizontal' ? 'vertical' : 'horizontal'))}
      />
      <div ref={containerRef} className={`pane-container split-${splitDir}`}>
        {panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {i > 0 && <SplitHandle direction={splitDir} onResize={(delta) => handleResize(i - 1, delta)} />}
            <div className="pane-wrapper" style={{ flex: `${pane.size} 0 0px` }}>
              <TerminalPane
                reuseSid={pane.reuseSid}
                onClose={panes.length > 1 ? () => removePane(pane.id) : undefined}
              />
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export default TerminalApp
