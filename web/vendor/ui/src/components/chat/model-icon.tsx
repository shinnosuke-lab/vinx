import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Gauge, Layers, SlidersHorizontal, Sparkles, Zap } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import type { CatalogParameterDefinition } from "@agentchat/client"

interface ProviderInfo {
  name: string
  color: string
  /** Data URI logo; absent means unrecognized provider (generic AI sparkles). */
  icon?: string
}

// TODO: Replace placeholder base64 strings with actual provider logos.
// Format: "data:image/png;base64,iVBORw0KGgoA..." or "data:image/svg+xml;base64,..."
const PROVIDERS: { pattern: RegExp; info: ProviderInfo }[] = [
  {
    pattern: /deepseek/i,
    info: {
      name: "DeepSeek",
      color: "#4D6BFE",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAAMFBMVEVHcExNa/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5Na/5glKuKAAAAD3RSTlMA05QmPhvxp+O+dGJWhBD9rd47AAAA0UlEQVQokcWR2RbDIAhEARXXhP//26IYY9o+9pzOQ9C5LkwE+K9CiaTllIfrCJkRReTUWRMyu/VPlKU+rVodOJ+TTvBmwg7Aa83djAAkD3kAXsMg8k6dDehj46LZ9xvZO3+knVIRqaNfSaN4wxGKLWgGr8jjfMRJw/BYM5m6yzKjmYVywL6XzmgRp7N+493WPE3bXltX5nw5ONeFee1941zeqaDivB96vYLGOkby3moO8KSJejfxtPdLG/W82hRslPMBu8rEXOCbQqu1ha/o13oBhAwQQ4gEzPgAAAAASUVORK5CYII=",
    },
  },
  {
    pattern: /gpt|openai|o1|o3|o4/i,
    info: {
      name: "OpenAI",
      color: "#10A37F",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAAAAABXZoBIAAABEElEQVR4AbTJIWyDQACG0d+rWsxENQ6Jwi0YFLIWRTKFxecc6pIzJzF4QTKDT23lSby5BPUt6ZJe2i1ze/aJP/x/+ly5/z2PU7ne1rIYm4/tR9YDsNeaFqP3l9wFx6AJgPLylLN6rrpEcBaiQko6dR/YDq4659po55SL8D1ujI0MLGpbl/K84nr8SWbSCBj5lNrvWewQCy1wU0gZsDV+ABi603nHtI9sJ0KW9d/paCxBjwy6wawyQiwdg2VPiZeBY5S10j3XjJRNoxWMqn20DB4tKeeWTUWhDfqJsX9rSRl0gLUQe20McpCSSwWAUxdBgaek0rQ6lQEwFS/JZ1cNebWFrVaElInLlNmv0TNpYgIAMy6KDbFgKo8AAAAASUVORK5CYII=",
    },
  },
  {
    pattern: /claude|anthropic/i,
    info: {
      name: "Claude",
      color: "#D97757",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAAHlBMVEXaakbadlbacU/WXzP++vj77ur12tPhknruxLjorp60qBrXAAAABHRSTlP+/v7+ukpK/AAAAQJJREFUKJG1UUluBCEMLLz7/x9OGeiew0g5JUYIcC02gPVL4A/AlC/yc0BZEU0/nJvkfo4IdywpI4hXQYhDJN1bqF9C3k0OuCQTKEoRxumU3waogntB3FojtGwOkxbIrO0eaHO1SqODHF/IpqSbczaH2VZ9lMKSZiQQojn0BYkwNDdiFtlsyXFAdFV1Z4bd8Oi8SqyqCD7CkUYvVcVju31V1wVH6o2n5sArLDZamhW8mbxjms22Yice7BbYklN1qGnJzqy5HfrMrctIXTRkKb5P+OTPDXEWPiv4AGmhze1NH6x8jTG0PPU28mqDf9zOr5PIT/ZSxqin2Gn1zX/WR/O/8QPwmAb3rsSAHQAAAABJRU5ErkJggg==",
    },
  },
  {
    pattern: /moonshot|kimi|\bk[23]\b/i,
    info: {
      name: "Moonshot",
      color: "#4A6CF7",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAY1BMVEUeIiIuNj8xOkIgHh4JCg0KDA0AAAAXGRoREhMxOUIfHx8AAQEPEBIJCgoXGx4XFxcvNj3///8qLzQbIieenp/z9PSrrKzU1NQjJytPUFAjKzG3uLnAwcHo6elfYGB+gIHf398mibWgAAAAC3RSTlME2cR4eHPZ2cR1c5gxMC4AAAC0SURBVBiVHY/ZFsMgCETpmrQgirtVk/7/VxY7b3cYDgMAvC7Of2oNzNsDVFe3WJEt0a7zxeyO5pHImDusfIi5p5QtGnzC4ikiI8eIKlA++yhT0sHKBj7VJUllxDy/g9WowfWeRDTvY1UjcJOUcy/yjYcxpIYvGshIRy5VDWY8Rx6z9NOjIQvaD6fM1mIpSNbCRoQY04wNF29w176IoTXdt5bfALvBv/68r3cfTzR6jyxvN4Af9P8QWBnvgt8AAAAASUVORK5CYII=",
    },
  },
  {
    pattern: /glm|zhipu|chatglm/i,
    info: {
      name: "Zhipu",
      color: "#3370FF",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAAAAABWESUoAAABAElEQVR4AYTSIQjDQAyF4djKmsozJ2ISPz1P61XNvJ2an54tHJysV/PzMHue6foybnRJ2RUy+qvA+2Qg76TgbfQDqQOzLglIgGyGkL6gs3YR7RcA/w0W8IbFujUkJ/kFzArwFAcp9iRnuPkCuCFrMzyzdN6AsILjNUv3igtA6KXqoPsEVAImDV4KWuQSrNWj7qFhC/he9wRsAapnBUwmgIfuF8cWcBfdH8AWINZ9bsgEkBT0ni3QDLqPNVsAW91fQNoGEEwKDpWXkEpQ3XW/HrMWXAH8OUtPmFYwbMAthqXI/RikeMICsHcSFb/HAnaeduftu88IZhxCWY+4zEsAAAAUGgKJx0VsFAAAAABJRU5ErkJggg==",
    },
  },
  {
    pattern: /qwen|tongyi/i,
    info: {
      name: "Qwen",
      color: "#615DEF",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAgVBMVEVHcExOK/JrW/ZtW/WCfPmQivlgRvN6b/dqKe5DIfBdRfRmXPZbL/FrYfZjEuygnvz///9mSfNnPvFpM+9kUPRjVvX19P9yZffNx/ull/fU0fxfSfSEZPNaPfNsWvXq6P5dDe2Be/ng3P1iL/Cfi/ZVLvLCufqQevWvpPm7rfhdIu/9w95rAAAAEHRSTlMAVFs8G/2B/fwizuGqsOnB9Hg6rAAAAblJREFUOI11k9l2gzAMRFnClqStDTaLzb4n//+BlWSfliSHeQHsixiNsOP8qy2iaPhyTnUfi6KIBv9sPwmY0kBEZ8A1Z2xo4TPhxep1390ZY6MGAr8zDEFQ/bwAHPbZzEWLSGSQo51wxQILF4YgJAisOxfUjmCBL03TaK2FlOZLHgF6LddyLjuWr+VBSqnyRsU12ss3lbN3PdDERcoGtx5r907kVyzwJaXe8PGzREBJ3CSUGOFRpbVVFEVzBZJk0ZNS6BZfqKcpy7IUpAuF2kPHlBCiwRS63uxzvow5ipmxJADwhnJ8GqKZrYnx7hibAFS4YEsseL+TzYQIAPhCrRIxPbDFZf9r1AkBSKnVLEaCmtYmHZcIBJ4KW4USdANj00EHorAvAPCU5l3HU43XFlY0To5+0SsBTxp433dwWRdYEQKmimH6aDKdph5d1dTiBGEQEdqkeAPZziXLxw2tVRPGhYANW+jaJNOt1GKPebqe55kYnJtYOjNftZmhABAe/kdfV7bAXpJRzPP1SNB0q3mjjFJIK3VfD0ViFYKFtQfg+nGurL5hYjEAyRngVzsA8f1sH454jDos/AK3Qzi8Bbl/tAAAAABJRU5ErkJggg==",
    },
  },
  {
    pattern: /gemini|google/i,
    info: {
      name: "Google",
      color: "#4285F4",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAYAAAByDd+UAAACbElEQVR4AWJwL/ChKyZL0y9XpzJAr/UAG0sYhWE4xrVt27Zt27Zt1ba7Rm27vbZt226/9sxmNtN1MZvkTSZ8cs7op8wG/ho58iVlFvDzuKn1f44ciQ8TZoCu+QZpOsGXsRPxasYCXFu4R8gr+MG+WyUWu71wKzLXOGCFxKMSb+DXCRNPcjHldgWc9p88yQv4efnw1ZqY495M7Dp2G5Mtvq8uVfDLnPG99GFLLF9hivUXDLL536tUwM8rR/Z6vWYGbu1cg8x9FirsUEYhbLjVH8ok1OgaXx4epsbkx4RwsEjTwvpZ5LIZXa/ep/GzdYdThF23n4YUp20QeVnDxikW2x2u6MS6W6rqcgLoegInO1ugklHwW0KD+r/E9YTvA1uCui4YiDTlBAaz8BdihV8WFrjdU2OakGadT0BQUH0t8G9SlR1/46u9/BpTH2wPktsymF/MAlgEH8JyhQqc6HUf/Zw+oZftT4OYBvyyoC1q8Hd6tR0/s2q//JTTEBRhF892R9jpUQy4Lnk3A44U5KCf7w30c3lDoHFMJ6ix0ucX2wgIY0GHs/MYcGq0E4ZJoxi0j/tT7pSGICG7UqMPTcb1wSdZcFPOBsxKPIYxoQL0FWQanbKz8YdGd15XZ672uzoDh88t505JqOaULFy814JbwM2ZvTSnJJSm1ERL/OJzUe6UA5UympKLlt6njbtedsr+YR7oLA1XowN9nq3m5fe05OSqkyNTN6Nd9FG0DfZj0O6irJO8/Q/pZ8uCLMrrD5hqHb9b2CBhIwPSNe9nmqapS+oTSNWI2Vufd5CqnLDiJWW2c2nZxCU7KP7BUigf+OW0iDHe5JwAAAAASUVORK5CYII=",
    },
  },
  {
    pattern: /doubao|skylark/i,
    info: {
      name: "Doubao",
      color: "#1677FF",
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAAdVBMVEVHcEwUc/8Vd/8Wef8WeP8Tcf8UdP8WeP8Vd/8Wef835OIWeP845+EVdf88890hmvgWef835OM44uIVdv8Tcf8xz+gnr/I34+IwzOk35OI35OI34+I34uI35eIbiPs44uI35eI34uIsvu4vyOs02OY12+Ulp/ScqRn0AAAAJ3RSTlMATp/Z/zmAscgdq2P//zb/8BNJ6v+w/2b//5/x/+H/RoPA//D/8+iImGFcAAAA4ElEQVR4AXzQhRKDMBBFUWTxaFkkZam3//+J3aSubzyHmUsSvS2Oo99Lkj+Ypn8Q4LdlANlPzAHyn1gAlN/Oy0vye9THKo/Vp1Ucq2OPzSc2HBOJx+ITE5BKaMloIrt4wxawEz0CLxrqj6fB0Y0Bs+X0ajGjIxcwn+n9aeRKkFj5aCpo/UQbVQL2jL1HdLR5wu0GfZLcDiHEt0847RmJdwjYu6eodT0CJ8kJ4EktSN1x4Nv7E6LLM4Cg4Y5LAYA7x3iNHugRnTmFh4CXKH/49D/GtNMxrG2NMad5stF5AwMA0lEQ5SYJyj4AAAAASUVORK5CYII=",
    },
  },
]

export function resolveProvider(modelName: string): ProviderInfo {
  for (const { pattern, info } of PROVIDERS) {
    if (pattern.test(modelName)) return info
  }
  return {
    name: "AI",
    color: "currentColor",
  }
}

function ProviderIcon({ modelName, className }: { modelName: string; className?: string }) {
  const provider = resolveProvider(modelName)
  return provider.icon ? (
    <img
      src={provider.icon}
      alt={provider.name}
      className={cn("h-4 w-4 shrink-0 rounded-sm object-contain", className)}
    />
  ) : (
    <Sparkles aria-label={provider.name} className={cn("h-4 w-4 shrink-0", className)} />
  )
}

interface ModelBadgeProps {
  modelName: string
  /** Models advertised by the upstream. When empty the badge stays read-only. */
  models?: string[]
  /** The configured default model (tagged and pinned to the top of the menu). */
  defaultModel?: string
  /** Called with the chosen model (or the default) when the user switches. */
  onSelect?: (model: string) => void
  /** Disable interaction (e.g. while a turn is streaming). */
  disabled?: boolean
}

/** `extra high` → `Extra High`, `low` → `Low`; leaves `300k`-style tokens
 *  and already-cased text (`Max`) intact. */
function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

interface TuningBadgeProps {
  /** Catalog parameter definitions of the current model (may be empty). */
  parameterDefinitions?: CatalogParameterDefinition[]
  /** Selected parameter values by definition id ("" / absent = default). */
  selectedParameters?: Record<string, string>
  onSelectParameter?: (id: string, value: string) => void
  /** Whether the current model supports a max mode (shows the toggle row). */
  supportsMaxMode?: boolean
  maxMode?: boolean
  onToggleMaxMode?: (on: boolean) => void
  /** Legacy `reasoning_effort` levels (openai-style backends). Rendered as its
   *  own section when the model has no catalog parameter definitions. */
  effortLevels?: string[]
  /** Currently selected effort ("" = the provider default). */
  selectedEffort?: string
  /** The provider's server-side default level (labels the "default" chip). */
  defaultEffort?: string | null
  onSelectEffort?: (effort: string) => void
  disabled?: boolean
}

/** One compact icon button bundling every per-turn model tuning control —
 *  catalog parameter definitions (Reasoning/Context…), the max-mode toggle and
 *  the legacy reasoning-effort switcher — into a single popup with grouped
 *  sections, instead of a row of separate chips that overflows the toolbar.
 *  The popup stays open while values are adjusted; outside click / Esc closes. */
export function TuningBadge({
  parameterDefinitions = [],
  selectedParameters = {},
  onSelectParameter,
  supportsMaxMode,
  maxMode,
  onToggleMaxMode,
  effortLevels = [],
  selectedEffort = "",
  defaultEffort,
  onSelectEffort,
  disabled,
}: TuningBadgeProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDocMouseDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const hasParameters = parameterDefinitions.length > 0 && !!onSelectParameter
  // The effort section only appears when the model has no catalog parameters:
  // catalog models express reasoning via their parameters, mixing both would be noise.
  const hasEffort = !hasParameters && effortLevels.length > 0 && !!onSelectEffort
  // The explicit max toggle also hides once parameter definitions exist: in
  // the parameter world max mode is a property of the chosen tuple (the catalog's
  // own picker has no separate switch either — `effort=max` / `context=1m`
  // simply land on a max variant, which the backend derives server-side).
  const hasMax = !hasParameters && !!supportsMaxMode && !!onToggleMaxMode
  if (!hasParameters && !hasEffort && !hasMax) return null

  // Anything off-default? → mark the trigger so the state stays visible even
  // with the popup closed.
  const tuned =
    (hasParameters && parameterDefinitions.some((d) => selectedParameters[d.id]?.trim())) ||
    (hasEffort && !!selectedEffort) ||
    (hasMax && !!maxMode)

  const sectionIcon = (id: string) =>
    id === "context" ? Layers : id === "reasoning" || id === "thinking" ? Zap : Gauge

  /** Chip text for a raw parameter value. Boolean parameters read as a
   *  switch — Off / On — whatever the catalog ships (the wire values `false`
   *  / `true` read as code, and e.g. `fast` names only its `true` side, so
   *  using displayName there would give an asymmetric `false | Fast`; the
   *  section header already says what is being switched). Enum values use
   *  the catalog's `displayName` (`300K`, `Extra High`), falling back to
   *  Title Case of the raw value. */
  const chipLabel = (def: CatalogParameterDefinition, value: string) => {
    if (def.kind === "boolean" || value === "true" || value === "false") {
      return value === "true" ? t("tuningOn") : t("tuningOff")
    }
    const v = def.values.find((x) => x.value === value)
    return v?.displayName?.trim() ? v.displayName : titleCase(value)
  }

  const chip = (selected: boolean) =>
    cn(
      "whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 transition-colors",
      selected
        ? "border-primary/40 bg-primary/15 text-primary"
        : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
    )

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("tuningBadgeHint")}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex h-6 items-center gap-0.5 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "bg-muted/50 text-foreground",
        )}
      >
        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        {tuned && (
          <span className="animate-pop-in absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </button>

      {open && (
        <div
          data-side="top"
          className="acc-pop absolute bottom-full left-0 z-30 mb-2 min-w-60 max-w-[26rem] overflow-hidden rounded-md border border-border bg-card shadow-md"
          role="menu"
        >
          {/* `w-max` lets the widest chip row size the popup (up to max-w) so
              rows stay on one line where possible; `flex-wrap` still catches
              a catalog with many values. */}
          <div className="w-max min-w-60 max-w-[26rem] max-h-72 overflow-y-auto py-1">
            {hasParameters &&
              parameterDefinitions.map((def) => {
                const Icon = sectionIcon(def.id)
                const selected = selectedParameters[def.id] ?? ""
                return (
                  <div key={def.id} className="px-2.5 py-1.5">
                    <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      <Icon className="h-3 w-3" />
                      {def.name?.trim() || def.id}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {def.values.map((v) => {
                        const isSelected = v.value === selected
                        return (
                          <button
                            key={v.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isSelected}
                            onClick={() =>
                              // Re-clicking the active chip clears back to the
                              // model default ("" = don't send this parameter).
                              onSelectParameter?.(def.id, isSelected ? "" : v.value)
                            }
                            className={chip(isSelected)}
                          >
                            {chipLabel(def, v.value)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

            {hasEffort && (
              <div className="px-2.5 py-1.5">
                <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  <Gauge className="h-3 w-3" />
                  {t("effortBadgeHint")}
                </div>
                <div className="flex flex-wrap gap-1">
                  {["", ...effortLevels].map((level) => {
                    const isSelected = level === selectedEffort
                    const label = level
                      ? titleCase(level)
                      : defaultEffort
                        ? `${t("effortDefault")} (${titleCase(defaultEffort)})`
                        : t("effortDefault")
                    return (
                      <button
                        key={level || "__default"}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => onSelectEffort?.(level)}
                        className={chip(isSelected)}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {hasMax && (
              <>
                {(hasParameters || hasEffort) && (
                  <div className="mx-2.5 my-1 border-t border-border/60" />
                )}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!!maxMode}
                  onClick={() => onToggleMaxMode?.(!maxMode)}
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/60"
                >
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {t("tuningMaxMode")}
                  </span>
                  <span
                    className={cn(
                      "relative h-3.5 w-6 rounded-full transition-colors",
                      maxMode ? "bg-primary" : "bg-muted-foreground/30",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 h-2.5 w-2.5 rounded-full bg-card transition-transform",
                        maxMode ? "translate-x-3" : "translate-x-0.5",
                      )}
                    />
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Show the current model; when the upstream advertises a list, clicking opens
 *  an upward dropdown to switch it for this session. Falls back to a read-only
 *  badge otherwise (unchanged behavior). */
export function ModelBadge({
  modelName,
  models = [],
  defaultModel,
  onSelect,
  disabled,
}: ModelBadgeProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  const interactive = !!onSelect && models.length > 0

  // Default model first (tagged), then the rest in upstream order, de-duped.
  // The currently-active model is always included so a stale/off-list selection
  // still renders as a checkmarked row rather than silently vanishing.
  const ordered = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (m: string) => {
      if (m && !seen.has(m)) {
        seen.add(m)
        out.push(m)
      }
    }
    if (defaultModel) push(defaultModel)
    push(modelName)
    models.forEach(push)
    return out
  }, [models, defaultModel, modelName])

  const showFilter = ordered.length > 10
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? ordered.filter((m) => m.toLowerCase().includes(q)) : ordered
  }, [ordered, query])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDocMouseDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  if (!interactive) {
    return (
      <div className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground">
        <ProviderIcon modelName={modelName} />
        <span className="truncate">{modelName}</span>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-6 max-w-[16rem] items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <ProviderIcon modelName={modelName} />
        <span className="truncate">{modelName}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          data-side="top"
          className="acc-pop absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-card shadow-md"
          role="listbox"
        >
          {showFilter && (
            <div className="border-b border-border p-1.5">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchModels")}
                className="w-full rounded-[4px] bg-muted/40 px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/50"
              />
            </div>
          )}
          <ul className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">—</li>
            ) : (
              filtered.map((m) => {
                const selected = m === modelName
                return (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelect?.(m)
                        setOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                        selected && "bg-muted/40",
                      )}
                    >
                      <ProviderIcon modelName={m} />
                      <span className="min-w-0 flex-1 truncate">{m}</span>
                      {defaultModel && m === defaultModel && (
                        <span className="shrink-0 rounded-[3px] bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {t("modelDefaultTag")}
                        </span>
                      )}
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
