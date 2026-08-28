import { Terminal } from 'lucide-react'
import { t } from './i18n'

interface ToolbarProps {
  paneCount: number
  splitDir: 'horizontal' | 'vertical'
  onAdd: () => void
  onToggleSplit: () => void
}

/**
 * Top strip: brand + "new terminal" (adds a pane) + split-direction toggle.
 * No gateway-MAC badge (agent-core runs the shell locally, so there's no
 * remote target to show). Right-side
 * actions are icon-only; labels live in the `title` tooltips.
 */
export default function Toolbar({ paneCount, splitDir, onAdd, onToggleSplit }: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <Terminal className="toolbar-icon" size={16} />
        <span className="toolbar-title">{t('appTitle')}</span>
      </div>
      <div className="toolbar-right">
        <button className="toolbar-btn toolbar-btn-icon" onClick={onAdd} title={t('newTerminal')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        {paneCount > 1 && (
          <button
            className="toolbar-btn toolbar-btn-icon"
            onClick={onToggleSplit}
            title={splitDir === 'horizontal' ? t('splitHorizontal') : t('splitVertical')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {splitDir === 'horizontal' ? (
                <>
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <polyline points="19 12 12 19 5 12"></polyline>
                  <polyline points="19 5 12 12 5 5"></polyline>
                </>
              ) : (
                <>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                  <polyline points="12 5 19 12 12 19"></polyline>
                  <polyline points="5 5 12 12 5 19"></polyline>
                </>
              )}
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
