import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconBrowseOutline16,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCodeOutline16,
  IconEllipsisOutline16,
  IconFolderOpenOutline16,
  IconPanelLeftOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { BrowserView, type DesktopBrowserBridge } from './browser.js'
import {
  FilesAccessoryView,
  TerminalAccessoryView,
  type DesktopFilesBridge,
  type DesktopTerminalBridge,
} from './desktop-accessory.js'
import {
  DesktopAccessoryController,
  type DesktopAccessoryView,
} from './desktop-accessory-controller.js'
import {
  DESKTOP_LOCALE_NAMESPACE,
  type DesktopTranslate,
} from './locales.js'
import { openOfficialSettings } from './settings-navigation.js'

const styles = `
[data-dsh-desktop-chrome="true"] {
  --dsh-desktop-accessory-width: clamp(360px, 32vw, 620px);
  --dsh-desktop-sidebar-width: 280px;
  --dsh-desktop-titlebar-height: 52px;
  box-sizing: border-box;
  padding-top: var(--dsh-desktop-titlebar-height);
}
[data-dsh-desktop-chrome="true"] > [data-side] {
  top: var(--dsh-desktop-titlebar-height) !important;
}
[data-dsh-desktop-chrome="true"][data-dsh-desktop-accessory-open="true"] {
  grid-template-columns: var(--dsh-desktop-sidebar-width) minmax(0, 1fr) var(--dsh-desktop-accessory-width) !important;
}
.dsh-desktop-shell {
  inset: 0;
  pointer-events: none !important;
  position: absolute;
}
.dsh-desktop-titlebar,
.dsh-desktop-titlebar *,
.dsh-desktop-accessory,
.dsh-desktop-accessory * {
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
[data-dsh-desktop-accessory-open="true"] .dsh-desktop-titlebar {
  grid-template-columns: max(var(--dsh-desktop-sidebar-width), 184px) minmax(0, 1fr) var(--dsh-desktop-accessory-width);
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
  justify-content: flex-end;
  min-width: 0;
  padding: 0 10px;
}
[data-dsh-desktop-accessory-open="true"] .dsh-desktop-titlebar-actions {
  border-left: 1px solid var(--dsw-alias-border-l1, #e7e7e3);
}
.dsh-desktop-titlebar-button,
.dsh-desktop-accessory-button,
.dsh-desktop-accessory-header-button {
  -webkit-app-region: no-drag;
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--dsw-alias-label-secondary, #5f6268);
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  padding: 0;
}
.dsh-desktop-titlebar-button,
.dsh-desktop-accessory-header-button {
  border-radius: 6px;
  height: 28px;
  width: 28px;
}
.dsh-desktop-titlebar-button:hover,
.dsh-desktop-accessory-header-button:hover,
.dsh-desktop-accessory-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
  color: var(--dsw-alias-label-primary, #17191c);
}
.dsh-desktop-titlebar-button:focus-visible,
.dsh-desktop-accessory-header-button:focus-visible,
.dsh-desktop-accessory-button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f9cf4);
  outline-offset: 1px;
}
.dsh-desktop-titlebar-panel-icon {
  transform: scaleX(-1);
}
.dsh-desktop-accessory {
  background: var(--dsw-alias-bg-base, #fff);
  border-left: 1px solid var(--dsw-alias-border-l2, #deded9);
  bottom: 0;
  color: var(--dsw-alias-label-primary, #17191c);
  min-height: 0;
  min-width: 0;
  pointer-events: auto;
  position: absolute;
  right: 0;
  top: var(--dsh-desktop-titlebar-height);
  width: var(--dsh-desktop-accessory-width);
}
.dsh-desktop-accessory[data-view="browser"] {
  top: 0;
}
.dsh-desktop-accessory-launcher {
  align-content: center;
  display: grid;
  gap: 2px;
  height: 100%;
  margin: 0 auto;
  max-width: 300px;
  padding: 24px;
  width: 100%;
}
.dsh-desktop-accessory-button {
  border-radius: 6px;
  color: var(--dsw-alias-label-primary, #17191c);
  display: grid;
  font: inherit;
  font-size: 15px;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  height: 48px;
  padding: 0 12px;
  text-align: left;
  width: 100%;
}
.dsh-desktop-accessory-shortcut {
  background: var(--dsw-alias-bg-layer-1, #f3f3f0);
  border-radius: 5px;
  color: var(--dsw-alias-label-tertiary, #74777d);
  font-size: 11px;
  line-height: 20px;
  min-width: 32px;
  padding: 0 5px;
  text-align: center;
}
.dsh-desktop-accessory-view {
  display: grid;
  grid-template-rows: 44px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.dsh-desktop-accessory-header {
  align-items: center;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #deded9);
  display: grid;
  font-size: 13px;
  font-weight: 500;
  grid-template-columns: 28px minmax(0, 1fr) 28px;
  padding: 0 10px;
}
.dsh-desktop-accessory-header span {
  text-align: center;
}
.dsh-desktop-accessory-empty {
  align-content: center;
  color: var(--dsw-alias-label-tertiary, #74777d);
  display: grid;
  gap: 10px;
  justify-items: center;
  padding: 24px;
  text-align: center;
}
.dsh-desktop-files {
  display: grid;
  grid-template-rows: 42px minmax(0, 1fr) auto;
  min-height: 0;
}
.dsh-desktop-files-location {
  align-items: center;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #e7e7e3);
  display: grid;
  font-size: 13px;
  grid-template-columns: 28px minmax(0, 1fr) 28px;
  padding: 0 10px;
}
.dsh-desktop-files-location > span {
  overflow: hidden;
  padding: 0 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-desktop-files-up {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 5px;
  color: var(--dsw-alias-label-secondary, #5f6268);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}
.dsh-desktop-files-up:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
}
.dsh-desktop-files-up:disabled {
  opacity: .35;
}
.dsh-desktop-files-list {
  min-height: 0;
  overflow: auto;
  padding: 6px 8px;
}
.dsh-desktop-files-row {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 5px;
  color: inherit;
  cursor: pointer;
  display: grid;
  font: inherit;
  font-size: 13px;
  gap: 8px;
  grid-template-columns: 18px minmax(0, 1fr);
  height: 34px;
  padding: 0 9px;
  text-align: left;
  width: 100%;
}
.dsh-desktop-files-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
}
.dsh-desktop-files-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-desktop-accessory-error {
  background: var(--dsw-alias-interactive-bg-hover-danger, #fdefed);
  color: var(--dsw-alias-state-error-primary, #b42318);
  font-size: 12px;
  line-height: 18px;
  padding: 8px 10px;
}
.dsh-desktop-terminal {
  background: #17191c;
  color: #f3f4f6;
  display: grid;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  grid-template-rows: minmax(0, 1fr) auto auto;
  min-height: 0;
}
.dsh-desktop-terminal-output {
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  margin: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-desktop-terminal-input {
  align-items: center;
  border-top: 1px solid #34373d;
  display: grid;
  gap: 7px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-height: 42px;
  padding: 6px 10px;
}
.dsh-desktop-terminal-input input {
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  min-width: 0;
  outline: 0;
}
.dsh-desktop-terminal-input button {
  background: #303238;
  border: 0;
  border-radius: 5px;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 5px 8px;
}
@media (max-width: 760px) {
  [data-dsh-desktop-chrome="true"] {
    --dsh-desktop-accessory-width: min(360px, calc(100vw - 184px));
    --dsh-desktop-sidebar-width: 56px !important;
  }
  .dsh-desktop-titlebar-title {
    padding-inline: 10px;
  }
}
`

export type DesktopShellSlotProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof DESKTOP_LOCALE_NAMESPACE>

function basename(path: string | undefined): string | undefined {
  const parts = path?.split(/[\\/]+/).filter(Boolean)
  return parts?.at(-1)
}

function AccessoryLauncher({
  controller,
  t,
}: {
  controller: DesktopAccessoryController
  t: DesktopTranslate
}): React.JSX.Element {
  const entries: Array<{
    icon: React.ReactNode
    label: string
    shortcut?: string
    view: Exclude<DesktopAccessoryView, 'launcher'>
  }> = [
    { icon: <IconFolderOpenOutline16 />, label: t('Files'), shortcut: '⌘P', view: 'files' },
    { icon: <IconBrowseOutline16 />, label: t('Browser'), shortcut: '⌘T', view: 'browser' },
    { icon: <IconCodeOutline16 />, label: t('Terminal'), view: 'terminal' },
  ]
  return (
    <nav className="dsh-desktop-accessory-launcher" aria-label={t('Right sidebar tools')}>
      {entries.map(entry => (
        <button
          type="button"
          className="dsh-desktop-accessory-button"
          key={entry.view}
          onClick={() => controller.open(entry.view)}
        >
          {entry.icon}
          <span>{entry.label}</span>
          {entry.shortcut !== undefined && <kbd className="dsh-desktop-accessory-shortcut">{entry.shortcut}</kbd>}
        </button>
      ))}
    </nav>
  )
}

export function DesktopShell({
  accessory,
  browser,
  files,
  layout,
  t,
  terminal,
  useSessions,
  useWorkspaces,
}: DesktopShellSlotProps & {
  accessory: DesktopAccessoryController
  browser?: DesktopBrowserBridge
  files?: DesktopFilesBridge
  layout: { toggleSidebar(): void }
  t: DesktopTranslate
  terminal?: DesktopTerminalBridge
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLElement>()
  const current = useSessions(state => state.current === undefined ? undefined : state.byId[state.current])
  const title = current?.displayTitle ?? t('New Session')
  const workspace = basename(current?.cwd)
  const workspaceState = useWorkspaces(state => state)
  const recentWorkspace = workspaceState.items.find(item => item.workspaceId === workspaceState.recentWorkspaceId)
  const workspaceRoot = current?.cwd ?? recentWorkspace?.path ?? workspaceState.items[0]?.path
  const accessoryState = useSyncExternalStore(
    accessory.subscribe,
    accessory.getSnapshot,
    accessory.getSnapshot,
  )

  useEffect(() => {
    const overlay = rootRef.current?.closest<HTMLElement>('[data-shell-overlay]')
    const frame = overlay?.parentElement
    const sidebar = frame?.firstElementChild
    if (frame === undefined || frame === null || !(sidebar instanceof HTMLElement)) return

    frameRef.current = frame
    frame.dataset.dshDesktopChrome = 'true'
    const projectSidebarWidth = (): void => {
      frame.style.setProperty('--dsh-desktop-sidebar-width', `${String(sidebar.getBoundingClientRect().width)}px`)
    }
    projectSidebarWidth()
    const observer = new ResizeObserver(projectSidebarWidth)
    observer.observe(sidebar)
    return () => {
      observer.disconnect()
      frameRef.current = undefined
      delete frame.dataset.dshDesktopChrome
      delete frame.dataset.dshDesktopAccessoryOpen
      frame.style.removeProperty('--dsh-desktop-sidebar-width')
    }
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (frame === undefined) return
    if (accessoryState.open) frame.dataset.dshDesktopAccessoryOpen = 'true'
    else delete frame.dataset.dshDesktopAccessoryOpen
  }, [accessoryState.open])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && accessory.getSnapshot().open) {
        event.preventDefault()
        accessory.close()
        return
      }
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        accessory.open('files')
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        accessory.open('browser')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [accessory])

  return (
    <div ref={rootRef} className="dsh-desktop-shell">
      <style>{styles}</style>
      <div className="dsh-desktop-titlebar" data-testid="desktop-titlebar">
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
          <Tooltip label={accessoryState.open ? t('Close right sidebar') : t('Open right sidebar')} side="bottom">
            <button
              type="button"
              className="dsh-desktop-titlebar-button"
              aria-label={accessoryState.open ? t('Close right sidebar') : t('Open right sidebar')}
              aria-pressed={accessoryState.open}
              onClick={() => accessory.toggle()}
            >
              <IconPanelLeftOutline16 className="dsh-desktop-titlebar-panel-icon" />
            </button>
          </Tooltip>
        </div>
      </div>
      {accessoryState.open && (
        <aside
          className="dsh-desktop-accessory"
          data-testid="desktop-accessory"
          data-view={accessoryState.view}
        >
          {accessoryState.view === 'launcher' && <AccessoryLauncher controller={accessory} t={t} />}
          {accessoryState.view === 'browser' && (
            <BrowserView
              bridge={browser}
              onClose={() => accessory.close()}
              onOpenSettings={() => { void openOfficialSettings('browser') }}
              t={t}
            />
          )}
          {accessoryState.view === 'files' && (
            <FilesAccessoryView
              bridge={files}
              onBack={() => accessory.open()}
              onClose={() => accessory.close()}
              t={t}
              workspaceRoot={workspaceRoot}
            />
          )}
          {accessoryState.view === 'terminal' && (
            <TerminalAccessoryView
              bridge={terminal}
              onBack={() => accessory.open()}
              onClose={() => accessory.close()}
              t={t}
              workspaceRoot={workspaceRoot}
            />
          )}
        </aside>
      )}
    </div>
  )
}
