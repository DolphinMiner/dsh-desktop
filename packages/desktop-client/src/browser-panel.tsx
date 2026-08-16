import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCloseOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { BrowserView, type DesktopBrowserBridge } from './browser.js'
import {
  DESKTOP_LOCALE_NAMESPACE,
  type DesktopTranslate,
} from './locales.js'

const styles = `
.dsh-desktop-browser-panel-close {
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--dsw-alias-label-secondary, #5f6268);
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  padding: 0;
}
.dsh-desktop-browser-panel {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #17191c);
  display: grid;
  grid-template-rows: 44px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.dsh-desktop-browser-panel-header {
  align-items: center;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #deded9);
  display: flex;
  font-size: 13px;
  font-weight: 500;
  justify-content: space-between;
  padding: 0 10px 0 14px;
}
.dsh-desktop-browser-panel-close {
  border-radius: 5px;
  height: 28px;
  width: 28px;
}
.dsh-desktop-browser-panel-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
}
.dsh-desktop-browser-panel-body {
  min-height: 0;
  min-width: 0;
}
`

export type BrowserPanelDetailsSlotProps =
  & PropsRuntime<'details'>
  & PropsLocale<typeof DESKTOP_LOCALE_NAMESPACE>

export function BrowserPanel({
  bridge,
  onClose,
  t,
}: BrowserPanelDetailsSlotProps & {
  bridge?: DesktopBrowserBridge
  onClose(): void
  t: DesktopTranslate
}): React.JSX.Element {
  return (
    <>
      <style>{styles}</style>
      <section className="dsh-desktop-browser-panel" aria-label={t('Browser')}>
        <header className="dsh-desktop-browser-panel-header">
          <span>{t('Browser')}</span>
          <Tooltip label={t('Close Browser')} side="bottom">
            <button
              type="button"
              className="dsh-desktop-browser-panel-close"
              aria-label={t('Close Browser')}
              onClick={onClose}
            >
              <IconCloseOutline16 />
            </button>
          </Tooltip>
        </header>
        <div className="dsh-desktop-browser-panel-body">
          <BrowserView bridge={bridge} t={t} />
        </div>
      </section>
    </>
  )
}
