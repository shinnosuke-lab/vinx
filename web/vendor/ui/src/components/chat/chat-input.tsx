import { useRef, useEffect, useCallback, useId, useMemo, useState } from "react"
import {
  FileText,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { Separator } from "@agentchat/components/ui/separator"
import { EffortBadge, ModelBadge } from "@agentchat/components/chat/model-icon"
import { SkillIcon } from "@agentchat/components/shared/skill-icon"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import type { SkillInfo } from "@agentchat/types"

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  hasMessages: boolean
  centered?: boolean
  modelName?: string
  /** Models advertised by the upstream, enabling the model switcher dropdown. */
  models?: string[]
  /** Configured default model (tagged in the switcher). */
  defaultModel?: string
  /** Switch the model for this session (empty list keeps the badge read-only). */
  onSelectModel?: (model: string) => void
  /** `reasoning_effort` levels of the CURRENT model (from `/api/models` caps).
   *  Empty hides the effort badge. */
  effortLevels?: string[]
  /** Selected effort ("" = the provider default). */
  selectedEffort?: string
  /** The current model's server-side default effort (labels the default row). */
  defaultEffort?: string | null
  /** Switch the reasoning effort for this session ("" = back to default). */
  onSelectEffort?: (effort: string) => void
  /** Skills for the `/` command palette (manual-invocable only are shown). */
  skills?: SkillInfo[]
  /** Icon URL resolver for palette rows and the pending-skill chip. */
  skillIconUrl?: (name: string) => string
  /** Skill staged for the next message, shown as a removable chip. */
  pendingSkill?: SkillInfo | null
  /** Skill sent for deterministic activation, awaiting the server event. */
  activatingSkill?: SkillInfo | null
  /** Authoritative active skill name from session metadata / SSE. */
  activeSkillName?: string | null
  /** A deterministic reset request is in flight. */
  resettingSkill?: boolean
  onPendingSkillChange?: (skill: SkillInfo | null) => void
  /** Deterministically exit the active skill. */
  onResetSkill?: () => void
  /** Session full-auto is ON: show the red badge next to the action button
   *  and render the stop button in the destructive color. */
  autoConfirm?: boolean
  /** Badge click: turn session full-auto off. */
  onAutoConfirmOff?: () => void
  /** Attachments staged for the next message (chips above the textarea). An
   *  entry without `id` is still uploading and blocks send. */
  attachments?: {
    key: number
    name: string
    kind: "image" | "file"
    size: number
    previewUrl?: string
    id?: string
  }[]
  onAddFiles?: (files: File[]) => void
  onRemoveUpload?: (key: number) => void
  /** Open the image lightbox (image chips zoom on click). */
  onPreview?: (src: string, alt?: string) => void
  /** Enable typing while a turn streams: Enter/send parks the message in the
   *  session queue (it auto-sends when the reply finishes). */
  queueEnabled?: boolean
  /** "Send now": steer the typed message into the RUNNING turn. Only shown
   *  while streaming with `queueEnabled`, and only for a plain text message
   *  (steering has no attachment channel). */
  onSendNow?: () => void
}

/** `2.4 MB` / `3 KB` / `512 B` for file chips. */
function chipSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)} KB`
  return `${bytes} B`
}

const MAX_PALETTE_ITEMS = 8

/** A palette row: either the built-in `reset` escape hatch or a real skill. */
type PaletteItem = { kind: "reset" } | { kind: "skill"; skill: SkillInfo }

/** Match a leading `/token` with no whitespace yet — the palette trigger. */
function slashQuery(value: string): string | null {
  const m = /^\/([^\s]*)$/.exec(value)
  return m ? m[1] : null
}

type SkillChipMode = "pending" | "activating" | "active" | "resetting"

function SkillContextChip({
  mode,
  name,
  skill,
  skillIconUrl,
  onDismiss,
  disabled,
}: {
  mode: SkillChipMode
  name: string
  skill?: SkillInfo
  skillIconUrl?: (name: string) => string
  onDismiss?: () => void
  disabled?: boolean
}) {
  const busy = mode === "activating" || mode === "resetting"
  const active = mode === "active" || mode === "resetting"
  const label =
    mode === "pending"
      ? t("skillStatePending")
      : mode === "activating"
        ? t("skillStateActivating")
        : mode === "resetting"
          ? t("skillStateResetting")
          : t("skillStateActive")
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-[4px] border pl-1.5 pr-1 text-[11px]",
        active
          ? "border-border bg-muted/40 text-foreground/80"
          : "border-primary/20 bg-primary/10 text-foreground",
      )}
    >
      {busy ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <SkillIcon
          name={name}
          src={skillIconUrl?.(name) ?? ""}
          hasIcon={!!skill?.has_icon && !!skillIconUrl}
          className="h-3.5 w-3.5"
        />
      )}
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono">/{name}</span>
      {onDismiss && !busy ? (
        <button
          type="button"
          onClick={onDismiss}
          disabled={disabled}
          title={active ? t("resetSkillHint") : t("skillChipRemove")}
          className="rounded-[3px] p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  )
}

export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  hasMessages,
  centered,
  modelName,
  models,
  defaultModel,
  onSelectModel,
  effortLevels,
  selectedEffort,
  defaultEffort,
  onSelectEffort,
  skills,
  skillIconUrl,
  pendingSkill,
  activatingSkill,
  activeSkillName,
  resettingSkill,
  onPendingSkillChange,
  onResetSkill,
  autoConfirm,
  onAutoConfirmOff,
  attachments,
  onAddFiles,
  onRemoveUpload,
  onPreview,
  queueEnabled,
  onSendNow,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const paletteId = useId()
  const [selIndex, setSelIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    const maxH = centered ? 200 : 160
    el.style.height = Math.min(el.scrollHeight, maxH) + "px"
  }, [centered])

  useEffect(() => {
    autoResize()
  }, [value, autoResize])

  const query = slashQuery(value)
  const invocable = useMemo(
    () => (skills ?? []).filter((s) => s.user_invocable && s.enabled !== false),
    [skills],
  )
  const items = useMemo<PaletteItem[]>(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    const ranked = invocable
      .map((skill) => {
        const name = skill.name.toLowerCase()
        const description = skill.description.toLowerCase()
        const score =
          q === "" || name.startsWith(q)
            ? 0
            : name.includes(q)
              ? 1
              : description.includes(q)
                ? 2
                : null
        return score === null ? null : { skill, score }
      })
      .filter((entry): entry is { skill: SkillInfo; score: number } => entry !== null)
      .sort(
        (a, b) =>
          a.score - b.score ||
          Number(!!b.skill.pinned) - Number(!!a.skill.pinned) ||
          a.skill.name.localeCompare(b.skill.name),
      )
      .map<PaletteItem>(({ skill }) => ({ kind: "skill", skill }))

    const showReset =
      !!activeSkillName &&
      (q === "" || "reset".startsWith(q) || "none".startsWith(q))
    const skillLimit = showReset ? MAX_PALETTE_ITEMS - 1 : MAX_PALETTE_ITEMS
    return [
      ...ranked.slice(0, skillLimit),
      ...(showReset ? ([{ kind: "reset" }] as PaletteItem[]) : []),
    ]
  }, [activeSkillName, invocable, query])

  const paletteOpen = query !== null && !dismissed

  // Reset selection/dismissal whenever the slash token changes.
  useEffect(() => {
    setSelIndex(0)
    if (query === null) setDismissed(false)
  }, [query])

  const acceptItem = useCallback(
    (item: PaletteItem) => {
      setDismissed(true)
      onChange("")
      if (item.kind === "reset") {
        // No arguments to add: run the escape hatch immediately.
        onResetSkill?.()
      } else {
        onPendingSkillChange?.(item.skill)
      }
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [onChange, onPendingSkillChange, onResetSkill],
  )

  const removeChip = useCallback(() => {
    onPendingSkillChange?.(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [onPendingSkillChange])

  /** Typing `/name ` (space after an exact skill-name token) stages the chip,
   *  mirroring palette selection — keeps the two entry paths consistent. */
  const handleChange = useCallback(
    (next: string) => {
      const m = /^\/(\S+)\s$/.exec(next)
      if (m && onPendingSkillChange) {
        const skill = invocable.find((s) => s.name === m[1])
        if (skill) {
          onPendingSkillChange(skill)
          onChange("")
          return
        }
      }
      onChange(next)
    },
    [invocable, onChange, onPendingSkillChange],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter confirms an IME candidate before it means "choose" or "send".
    if (e.nativeEvent.isComposing) return
    if (paletteOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        setDismissed(true)
        return
      }
      if (items.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setSelIndex((i) => (i + 1) % items.length)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setSelIndex((i) => (i - 1 + items.length) % items.length)
          return
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault()
          acceptItem(items[Math.min(selIndex, items.length - 1)])
          return
        }
      }
    }
    if (e.key === "Backspace" && value === "" && pendingSkill) {
      e.preventDefault()
      removeChip()
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  /** Clipboard paste: screenshots and copied files go straight in. */
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!onAddFiles) return
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) {
      e.preventDefault()
      onAddFiles(files)
    }
  }

  const paletteRow = (item: PaletteItem, i: number) => {
    const selected = i === selIndex
    const rowClass = cn(
      "flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left outline-none transition-colors",
      selected ? "bg-muted text-foreground" : "text-foreground/85 hover:bg-muted/50",
    )
    if (item.kind === "reset") {
      return (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => acceptItem(item)}
          onMouseEnter={() => setSelIndex(i)}
          className={rowClass}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-mono text-xs text-foreground">/reset</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {t("resetSkillHint")}
            </span>
          </span>
        </button>
      )
    }
    const s = item.skill
    const current = s.name === activeSkillName
    return (
      <button
        type="button"
        tabIndex={-1}
        onClick={() => acceptItem(item)}
        onMouseEnter={() => setSelIndex(i)}
        className={rowClass}
      >
        <SkillIcon
          name={s.name}
          src={skillIconUrl?.(s.name) ?? ""}
          hasIcon={!!s.has_icon && !!skillIconUrl}
          className="h-5 w-5"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex w-full items-center gap-1.5">
            <span className="font-mono text-xs text-foreground">/{s.name}</span>
            {current ? (
              <span className="rounded-[4px] border border-border bg-background px-1 py-px text-[9px] text-muted-foreground">
                {t("skillStateActive")}
              </span>
            ) : null}
            {s.argument_hint ? (
              <span className="ml-auto max-w-[45%] truncate rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {s.argument_hint}
              </span>
            ) : null}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">{s.description}</span>
        </span>
      </button>
    )
  }

  const palette = paletteOpen ? (
    <div
      className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-md border border-border bg-card shadow-md animate-in fade-in-0 zoom-in-95 duration-100 sm:w-[34rem] sm:max-w-[calc(100vw-2rem)]"
      // Keep textarea focus when clicking an item.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex h-8 items-center gap-2 border-b border-border/40 bg-muted/15 px-3">
        <Sparkles className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} />
        <span className="text-[11px] font-medium text-foreground/80">
          {t("skillsPaletteTitle")}
        </span>
        <span className="ml-auto hidden text-[10px] text-muted-foreground/70 sm:inline">
          {t("skillsPaletteKeys")}
        </span>
      </div>
      <ul id={paletteId} role="listbox" className="max-h-72 overflow-y-auto py-1">
        {items.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">
            {t("skillsPaletteEmpty")}
          </li>
        ) : items.map((item, i) => (
          <li
            id={`${paletteId}-option-${i}`}
            key={item.kind === "reset" ? "__reset__" : item.skill.name}
            role="option"
            aria-selected={i === selIndex}
            className={cn("px-1", item.kind === "reset" && "mt-1 border-t border-border/40 pt-1")}
          >
            {paletteRow(item, i)}
          </li>
        ))}
      </ul>
    </div>
  ) : null

  const activeSkill = (skills ?? []).find((s) => s.name === activeSkillName)
  const showActivating =
    !!activatingSkill && activatingSkill.name !== activeSkillName
  const hasSkillContext = !!activeSkillName || !!pendingSkill || showActivating
  const skillContext = hasSkillContext ? (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 px-3",
        centered ? "pt-3" : "pt-2.5",
      )}
      aria-label={t("skillContextLabel")}
    >
      {activeSkillName ? (
        <SkillContextChip
          mode={resettingSkill ? "resetting" : "active"}
          name={activeSkillName}
          skill={activeSkill}
          skillIconUrl={skillIconUrl}
          onDismiss={resettingSkill ? undefined : onResetSkill}
          disabled={streaming}
        />
      ) : null}
      {pendingSkill ? (
        <SkillContextChip
          mode="pending"
          name={pendingSkill.name}
          skill={pendingSkill}
          skillIconUrl={skillIconUrl}
          onDismiss={removeChip}
        />
      ) : null}
      {showActivating && activatingSkill ? (
        <SkillContextChip
          mode="activating"
          name={activatingSkill.name}
          skill={activatingSkill}
          skillIconUrl={skillIconUrl}
        />
      ) : null}
    </div>
  ) : null

  // Queue mode: the composer stays usable while a turn streams — typed
  // messages park in the session queue (Enter) or steer the running turn.
  const queueMode = streaming && !!queueEnabled
  const placeholder = pendingSkill
    ? pendingSkill.argument_hint || t("skillChipArgsPlaceholder")
    : queueMode
      ? t("queuePlaceholder")
      : centered || !hasMessages
        ? t("placeholderCentered")
        : t("placeholderBottom")

  const uploads = attachments ?? []
  const uploading = uploads.some((a) => !a.id)
  const canSend =
    (!!value.trim() || !!pendingSkill || uploads.length > 0) && !uploading

  /** Attachment chips row: image thumbnails (click = zoom) + file chips
   *  (icon + name + size), staged for the next message. */
  const attachmentChips = uploads.length > 0 ? (
    <div className={cn("flex flex-wrap items-center gap-1.5 px-3", centered ? "pt-3" : "pt-2.5")}>
      {uploads.map((up) => (
        <span
          key={up.key}
          className={cn(
            "group/chip relative overflow-hidden rounded-[4px] border border-border",
            up.kind === "image"
              ? "inline-flex h-12 w-12"
              : "inline-flex h-9 max-w-52 items-center gap-1.5 bg-muted/40 pl-2 pr-5",
          )}
          title={up.name}
        >
          {up.kind === "image" && up.previewUrl ? (
            <img
              src={up.previewUrl}
              alt={up.name}
              onClick={() => onPreview?.(up.previewUrl as string, up.name)}
              className="h-full w-full cursor-zoom-in object-cover"
            />
          ) : (
            // objectURL tab = browser-native preview (txt/pdf render in place).
            <button
              type="button"
              onClick={() => up.previewUrl && window.open(up.previewUrl, "_blank")}
              className="flex min-w-0 items-center gap-1.5 text-left"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[11px] text-foreground/85">{up.name}</span>
                <span className="text-[9px] text-muted-foreground">{chipSize(up.size)}</span>
              </span>
            </button>
          )}
          {!up.id && (
            <span className="absolute inset-0 flex items-center justify-center bg-background/60">
              <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemoveUpload?.(up.key)}
            className={cn(
              "absolute right-0 top-0 rounded-bl-[4px] bg-background/80 p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
              up.kind === "image" ? "opacity-0 group-hover/chip:opacity-100" : "opacity-70 hover:opacity-100",
            )}
            title={t("delete")}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  ) : null

  /** Attach button (all models — non-image files ride as tool-readable
   *  uploads; images degrade to placeholders on text-only models). */
  const attachButton = onAddFiles ? (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) onAddFiles(files)
          e.target.value = ""
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={() => fileInputRef.current?.click()}
        disabled={streaming}
        className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-4"
        title={t("attachFile")}
      >
        <Paperclip />
      </Button>
    </>
  ) : null

  // Stop turns red only under session full-auto — the alarming color marks
  // the elevated mode, not the everyday stop action.
  const actionButton = streaming ? (
    <>
      {queueMode && (value.trim() || (attachments?.length ?? 0) > 0) && !uploading && (
        <>
          {/* "Send now" winds the running turn down and starts this message
              right after — attachments ride along like any other send. Both
              actions hide while a chip is still uploading (mirrors `canSend`):
              the send paths only carry resolved ids and would silently drop
              an in-flight upload. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onSendNow}
            className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-4"
            title={t("sendNowTitle")}
          >
            <Zap />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onSend}
            className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-4"
            title={t("queueSendTitle")}
          >
            <SendHorizontal />
          </Button>
        </>
      )}
      <Button
        size="icon"
        variant={autoConfirm ? "destructive" : "default"}
        data-acc="send-btn"
        onClick={onStop}
        className="h-6 w-6 shrink-0 rounded-sm [&_svg]:size-3"
        title={t("stop")}
      >
        <Square className="fill-current" />
      </Button>
    </>
  ) : (
    <Button
      data-acc="send-btn"
      onClick={onSend}
      disabled={!canSend}
      size="icon"
      className="h-6 w-6 shrink-0 rounded-sm [&_svg]:size-4"
      title={t("send")}
    >
      <SendHorizontal className="fill-current" />
    </Button>
  )

  // Session full-auto badge, docked left of the action button so it reads as
  // one "auto mode" cluster with the (now red) stop control. Click = off.
  const autoBadge = autoConfirm ? (
    <button
      type="button"
      onClick={onAutoConfirmOff}
      title={t("fullAutoBadgeHint")}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-destructive/50 bg-destructive/10 px-1.5 text-[10px] font-medium leading-none text-destructive transition-colors hover:bg-destructive/20"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
      {t("fullAutoBadge")}
      <X className="h-2.5 w-2.5" />
    </button>
  ) : null

  const box = (
    <div className="relative">
      {palette}
      <div data-acc="chat-input" className={cn("rounded-[6px] border border-input bg-background", streaming && "streaming-border")}>
        {skillContext}
        {attachmentChips}
        <textarea
          ref={textareaRef}
          value={value}
          role="combobox"
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-controls={paletteOpen ? paletteId : undefined}
          aria-expanded={paletteOpen}
          aria-activedescendant={
            paletteOpen && items.length > 0
              ? `${paletteId}-option-${Math.min(selIndex, items.length - 1)}`
              : undefined
          }
          rows={centered ? 2 : 3}
          disabled={streaming && !queueEnabled}
          className={cn(
            "w-full resize-none bg-transparent px-3 text-sm",
            hasSkillContext
              ? "pt-2 pb-2 min-h-[48px]"
              : centered
                ? "pt-3 pb-2 min-h-[72px]"
                : "pt-3 pb-2 min-h-[72px]",
            centered ? "max-h-[200px]" : "max-h-[160px]",
            "placeholder:text-muted-foreground/40 focus-visible:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <Separator className="mx-3 w-auto opacity-30" />
        <div className="flex items-center justify-between px-3 pb-3 pt-2">
          {/* -ml-1.5 cancels the badge's hover-pill padding so its icon
              left-aligns with the textarea text above (both at px-3). */}
          {modelName ? (
            <div className="-ml-1.5 flex min-w-0 items-center gap-0.5">
              <ModelBadge
                modelName={modelName}
                models={models}
                defaultModel={defaultModel}
                onSelect={onSelectModel}
                disabled={streaming}
              />
              <EffortBadge
                levels={effortLevels ?? []}
                selected={selectedEffort ?? ""}
                defaultEffort={defaultEffort}
                onSelect={onSelectEffort}
                disabled={streaming}
              />
            </div>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            {attachButton}
            {autoBadge}
            {actionButton}
          </div>
        </div>
      </div>
    </div>
  )

  if (centered) {
    return (
      <div className="w-full max-w-2xl px-4">
        {box}
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground/50">
          {t("aiDisclaimer")}
        </p>
      </div>
    )
  }

  return (
    <div className="bg-background px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {box}
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground/50">
          {t("aiDisclaimer")}
        </p>
      </div>
    </div>
  )
}
