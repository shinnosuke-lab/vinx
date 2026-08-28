/**
 * Connection monitor: polls the agent every 3s and publishes one persistent
 * top-right toast once it has been unreachable for 5s straight. The debounce
 * deliberately swallows the 1-2s restart after a config save; recovery
 * dismisses the keyed toast immediately.
 */

import { useEffect, useMemo, useState } from "react"
import { createChatClient } from "@agentchat/client"
import { t } from "@agentchat/lib/i18n"
import { toast } from "@agentchat/components/ui/toast"

const POLL_MS = 3000
const SHOW_DELAY_MS = 5000
const CONNECTION_TOAST_KEY = "agent-connection-lost"

export function ConnectionBanner({ basePath = "" }: { basePath?: string }) {
  const client = useMemo(() => createChatClient(basePath), [basePath])
  const [down, setDown] = useState(false)
  const [show, setShow] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      const ok = await client.probe().catch(() => false)
      if (!alive) return
      setDown(!ok)
      timer = window.setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [client])

  useEffect(() => {
    if (!down) {
      setShow(false)
      return
    }
    const id = window.setTimeout(() => setShow(true), SHOW_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [down])

  useEffect(() => {
    if (show) {
      toast.error(t("connectionLost"), {
        key: CONNECTION_TOAST_KEY,
        duration: null,
      })
    } else {
      toast.dismiss(CONNECTION_TOAST_KEY)
    }
    return () => toast.dismiss(CONNECTION_TOAST_KEY)
  }, [show])

  return null
}
