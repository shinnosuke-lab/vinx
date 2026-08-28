import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Gauge, Sparkles } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

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

interface EffortBadgeProps {
  /** The `reasoning_effort` levels the current model accepts. Empty hides the
   *  badge entirely — the model takes no effort parameter. */
  levels: string[]
  /** Currently selected effort ("" = the provider default). */
  selected: string
  /** The provider's server-side default level (labels the "default" row). */
  defaultEffort?: string | null
  /** Called with the chosen level ("" = back to default). */
  onSelect?: (effort: string) => void
  disabled?: boolean
}

/** Reasoning-effort switcher next to the model badge. Options come from the
 *  model's capability record; hidden when the model has no adjustable effort. */
export function EffortBadge({ levels, selected, defaultEffort, onSelect, disabled }: EffortBadgeProps) {
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

  if (levels.length === 0 || !onSelect) return null

  const defaultLabel = defaultEffort
    ? `${t("effortDefault")} (${defaultEffort})`
    : t("effortDefault")
  const badgeLabel = selected || t("effortDefault")

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("effortBadgeHint")}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{badgeLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 z-30 mb-2 w-52 overflow-hidden rounded-md border border-border bg-card shadow-md animate-in fade-in-0 zoom-in-95 duration-100"
          role="listbox"
        >
          <ul className="py-1">
            {["", ...levels].map((level) => {
              const isSelected = level === selected
              return (
                <li key={level || "__default"}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onSelect(level)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                      isSelected && "bg-muted/40",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {level || defaultLabel}
                    </span>
                    {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                </li>
              )
            })}
          </ul>
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
          className="absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-card shadow-md animate-in fade-in-0 zoom-in-95 duration-100"
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
