import { useEffect, useRef } from 'react'

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconEllipsisOutline16,
  IconFolderOpenOutline16,
  IconPanelLeftOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { openOfficialSettings } from './settings-navigation.js'
import {
  DESKTOP_LOCALE_NAMESPACE,
  type DesktopTranslate,
} from './locales.js'

const styles = `
[data-dsh-desktop-chrome="true"] {
  --dsh-desktop-sidebar-width: 280px;
  --dsh-desktop-titlebar-height: 52px;
  box-sizing: border-box;
  padding-top: var(--dsh-desktop-titlebar-height);
}
[data-dsh-desktop-chrome="true"] > [data-side] {
  top: var(--dsh-desktop-titlebar-height) !important;
}
.dsh-desktop-titlebar,
.dsh-desktop-titlebar * {
  box-sizing: border-box;
  letter-spacing: 0;
}
.dsh-desktop-titlebar {
  -webkit-app-region: drag;
  align-items: stretch;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 94%, transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e7e7e3);
  color: var(--dsw-alias-label-primary, #17191c);
  display: grid;
  grid-template-columns: max(var(--dsh-desktop-sidebar-width), 184px) minmax(0, 1fr) auto;
  height: var(--dsh-desktop-titlebar-height);
  left: 0;
  pointer-events: auto;
  position: absolute;
  right: 0;
  top: 0;
  user-select: none;
}
.dsh-desktop-titlebar-nav {
  align-items: center;
  border-right: 1px solid var(--dsw-alias-border-l1, #e7e7e3);
  display: flex;
  gap: 3px;
  min-width: 0;
  padding: 0 10px 0 78px;
}
.dsh-desktop-titlebar-title {
  align-items: center;
  display: flex;
  font-size: 14px;
  font-weight: 600;
  gap: 9px;
  min-width: 0;
  padding: 0 16px;
}
.dsh-desktop-titlebar-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-desktop-titlebar-actions {
  align-items: center;
  display: flex;
  padding: 0 10px;
}
.dsh-desktop-titlebar-button {
  -webkit-app-region: no-drag;
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary, #5f6268);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}
.dsh-desktop-titlebar-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
  color: var(--dsw-alias-label-primary, #17191c);
}
.dsh-desktop-titlebar-button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f9cf4);
  outline-offset: 1px;
}
@media (max-width: 760px) {
  .dsh-desktop-titlebar {
    grid-template-columns: 184px minmax(0, 1fr) auto;
  }
  .dsh-desktop-titlebar-title {
    padding-inline: 10px;
  }
}
`

export type DesktopTitlebarSlotProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof DESKTOP_LOCALE_NAMESPACE>

function basename(path: string | undefined): string | undefined {
  const parts = path?.split(/[\\/]+/).filter(Boolean)
  return parts?.at(-1)
}

export function DesktopTitlebar({
  layout,
  t,
  useSessions,
}: DesktopTitlebarSlotProps & {
  layout: { toggleSidebar(): void }
  t: DesktopTranslate
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const current = useSessions(state => state.current === undefined ? undefined : state.byId[state.current])
  const title = current?.displayTitle ?? t('New Session')
  const workspace = basename(current?.cwd)

  useEffect(() => {
    const overlay = rootRef.current?.closest<HTMLElement>('[data-shell-overlay]')
    const frame = overlay?.parentElement
    const sidebar = frame?.firstElementChild
    if (frame === undefined || frame === null || !(sidebar instanceof HTMLElement)) return

    frame.dataset.dshDesktopChrome = 'true'
    const projectSidebarWidth = (): void => {
      frame.style.setProperty('--dsh-desktop-sidebar-width', `${String(sidebar.getBoundingClientRect().width)}px`)
    }
    projectSidebarWidth()
    const observer = new ResizeObserver(projectSidebarWidth)
    observer.observe(sidebar)
    return () => {
      observer.disconnect()
      delete frame.dataset.dshDesktopChrome
      frame.style.removeProperty('--dsh-desktop-sidebar-width')
    }
  }, [])

  return (
    <div ref={rootRef} className="dsh-desktop-titlebar" data-testid="desktop-titlebar">
      <style>{styles}</style>
      <nav className="dsh-desktop-titlebar-nav" aria-label={t('Window navigation')}>
        <Tooltip label={t('Toggle sidebar')} side="bottom">
          <button
            type="button"
            className="dsh-desktop-titlebar-button"
            aria-label={t('Toggle sidebar')}
            onClick={() => layout.toggleSidebar()}
          >
            <IconPanelLeftOutline16 />
          </button>
        </Tooltip>
        <Tooltip label={t('Go back')} side="bottom">
          <button
            type="button"
            className="dsh-desktop-titlebar-button"
            aria-label={t('Go back')}
            onClick={() => window.history.back()}
          >
            <IconChevronLeftOutline14 />
          </button>
        </Tooltip>
        <Tooltip label={t('Go forward')} side="bottom">
          <button
            type="button"
            className="dsh-desktop-titlebar-button"
            aria-label={t('Go forward')}
            onClick={() => window.history.forward()}
          >
            <IconChevronRightOutline14 />
          </button>
        </Tooltip>
      </nav>
      <div className="dsh-desktop-titlebar-title" title={current?.cwd ?? title}>
        <IconFolderOpenOutline16 />
        <span>{workspace === undefined || workspace === title ? title : `${workspace} / ${title}`}</span>
      </div>
      <div className="dsh-desktop-titlebar-actions">
        <Tooltip label={t('Open Settings')} side="bottom">
          <button
            type="button"
            className="dsh-desktop-titlebar-button"
            aria-label={t('Open Settings')}
            onClick={() => { void openOfficialSettings() }}
          >
            <IconEllipsisOutline16 />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
