import { useSyncExternalStore } from 'react'

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconBrowseOutline16,
  IconCloseOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { BrowserView, type DesktopBrowserBridge } from './browser.js'
import { BrowserPanelController } from './browser-panel-controller.js'
import {
  DESKTOP_LOCALE_NAMESPACE,
  type DesktopTranslate,
} from './locales.js'

const styles = `
.dsh-desktop-browser-panel-toggle,
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
.dsh-desktop-browser-panel-toggle {
  border-radius: 6px;
  height: 28px;
  width: 28px;
}
.dsh-desktop-browser-panel-toggle:hover,
.dsh-desktop-browser-panel-toggle[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
  color: var(--dsw-alias-label-primary, #17191c);
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

export type BrowserPanelToggleSlotProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof DESKTOP_LOCALE_NAMESPACE>

export function BrowserPanelToggle({
  controller,
  onOpenChange,
  t,
}: BrowserPanelToggleSlotProps & {
  controller: BrowserPanelController
  onOpenChange(open: boolean): void
  t: DesktopTranslate
}): React.JSX.Element {
  const open = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const label = open ? t('Close Browser') : t('Open Browser')

  return (
    <>
      <style>{styles}</style>
      <Tooltip label={label} side="bottom">
        <button
          type="button"
          className="dsh-desktop-browser-panel-toggle"
          data-active={open}
          aria-label={label}
          aria-pressed={open}
          onClick={() => { onOpenChange(!open) }}
        >
          <IconBrowseOutline16 />
        </button>
      </Tooltip>
    </>
  )
}

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
  )
}
