import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  Button,
  IconBrowseOutline16,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEllipsisOutline16,
  IconGlobeOutline14,
  IconPanelLeftOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  BrowserFrame,
  BrowserHistoryEntry,
  BrowserManagementPage,
  BrowserState,
  BrowserUiKeyboardAction,
  BrowserUiKeyboardInput,
  BrowserUiNavigateInput,
  BrowserUiOpenManagementInput,
  BrowserUiPointerInput,
  BrowserUiScrollInput,
  BrowserUiTabInput,
  BrowserUiViewportInput,
  UpdateBrowserSettingsInput,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  SettingsGroup,
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from './settings-ui.js'
import {
  activeBrowserAddress,
  browserAddressLabel,
  browserKeyboardAction,
  normalizeBrowserAddress,
  normalizedBrowserPoint,
} from './browser-view-model.js'
import type { DesktopTranslate } from './locales.js'

export interface DesktopBrowserBridge {
  getState(): Promise<BrowserState>
  update(input: UpdateBrowserSettingsInput): Promise<BrowserState>
  navigate(input: BrowserUiNavigateInput): Promise<BrowserState>
  openManagement(input: BrowserUiOpenManagementInput): Promise<BrowserState>
  activateTab(input: BrowserUiTabInput): Promise<BrowserState>
  pointer(input: BrowserUiPointerInput): Promise<BrowserState>
  scrollAt(input: BrowserUiScrollInput): Promise<BrowserState>
  keyboard(input: BrowserUiKeyboardInput): Promise<BrowserState>
  newTab(): Promise<BrowserState>
  closeTab(input: BrowserUiTabInput): Promise<BrowserState>
  back(): Promise<BrowserState>
  forward(): Promise<BrowserState>
  reload(): Promise<BrowserState>
  refreshFrame(): Promise<BrowserState>
  resizeViewport(input: BrowserUiViewportInput): Promise<BrowserState>
  stop(): Promise<BrowserState>
  listHistory(): Promise<BrowserHistoryEntry[]>
  clearHistory(): Promise<BrowserState>
  clearData(): Promise<BrowserState>
  onChanged(listener: (state: BrowserState) => void): () => void
  onFrame(listener: (frame: BrowserFrame | undefined) => void): () => void
}

const styles = `
.dsh-desktop-browser-icon {
  align-items: center;
  display: flex;
  height: 100%;
  justify-content: center;
  width: 100%;
}
.dsh-desktop-browser-history {
  display: grid;
  max-height: min(460px, 58vh);
  min-width: min(620px, 78vw);
  overflow: auto;
}
.dsh-desktop-browser-history-row {
  display: grid;
  gap: 2px;
  min-height: 50px;
  padding: 8px 2px;
}
.dsh-desktop-browser-history-row + .dsh-desktop-browser-history-row {
  border-top: 1px solid var(--dsw-alias-border-l1, #ecece8);
}
.dsh-desktop-browser-history-title {
  font-size: 13px;
  line-height: 19px;
}
.dsh-desktop-browser-history-meta {
  color: var(--dsw-alias-label-tertiary, #74777d);
  font-size: 11px;
  line-height: 17px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-desktop-browser-confirm {
  display: grid;
  gap: 12px;
  max-width: 480px;
}
.dsh-desktop-browser-management-modal {
  max-width: 1100px;
  width: min(1100px, 88vw);
}
.dsh-desktop-browser-management {
  height: min(650px, 72vh);
  min-height: 420px;
  min-width: 0;
  width: 100%;
}
.dsh-desktop-browser-view,
.dsh-desktop-browser-view * {
  box-sizing: border-box;
  letter-spacing: 0;
}
.dsh-desktop-browser-view {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #17191c);
  display: grid;
  grid-template-rows: 52px 48px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.dsh-desktop-browser-tabs {
  align-items: center;
  background: var(--dsw-alias-bg-base, #fff);
  display: flex;
  min-width: 0;
  padding: 7px 8px;
}
.dsh-desktop-browser-tab-list {
  align-items: center;
  display: flex;
  gap: 3px;
  min-width: 0;
  overflow-x: auto;
}
.dsh-desktop-browser-tab {
  align-items: center;
  border-radius: 8px;
  display: grid;
  flex: 0 0 190px;
  grid-template-columns: minmax(0, 1fr) 28px;
  height: 32px;
  max-width: 220px;
}
.dsh-desktop-browser-tab[data-active="true"] {
  background: color-mix(
    in srgb,
    var(--dsw-alias-label-primary, #17191c) 7%,
    var(--dsw-alias-bg-base, #fff)
  );
}
.dsh-desktop-browser-tab-main,
.dsh-desktop-browser-icon-button {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.dsh-desktop-browser-tab-main {
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-columns: 18px minmax(0, 1fr);
  height: 100%;
  padding: 0 5px 0 10px;
  text-align: left;
}
.dsh-desktop-browser-tab-main span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-desktop-browser-window-actions {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  margin-left: auto;
  padding-left: 6px;
}
.dsh-desktop-browser-panel-icon {
  transform: scaleX(-1);
}
.dsh-desktop-browser-icon-button {
  align-items: center;
  border-radius: 5px;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}
.dsh-desktop-browser-icon-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0ed);
}
.dsh-desktop-browser-icon-button:disabled {
  cursor: default;
  opacity: .35;
}
.dsh-desktop-browser-toolbar {
  align-items: center;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #deded9);
  display: grid;
  gap: 6px;
  grid-template-columns: 28px 28px 28px minmax(120px, 1fr) 28px;
  padding: 8px 10px;
}
.dsh-desktop-browser-address {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  color: inherit;
  font: inherit;
  font-size: 14px;
  height: 31px;
  min-width: 0;
  outline: none;
  padding: 0 11px;
  text-align: center;
  width: 100%;
}
.dsh-desktop-browser-address:focus {
  background: var(--dsw-alias-bg-overlay, #f2f2ef);
  border-color: var(--dsw-alias-state-business-primary, #2f9cf4);
  text-align: left;
}
.dsh-desktop-browser-stage {
  background: var(--dsw-alias-bg-base, #fff);
  display: grid;
  min-height: 0;
  overflow: hidden;
  place-items: center;
  position: relative;
}
.dsh-desktop-browser-stage[data-busy="true"] {
  cursor: progress;
}
.dsh-desktop-browser-stage[data-interactive="true"]:focus-visible {
  box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary, #2f9cf4);
  outline: none;
}
.dsh-desktop-browser-stage img {
  display: block;
  height: 100%;
  width: 100%;
}
.dsh-desktop-browser-empty {
  color: var(--dsw-alias-label-tertiary, #74777d);
  display: grid;
  font-size: 15px;
  gap: 12px;
  justify-items: center;
  padding: 24px;
  text-align: center;
}
.dsh-desktop-browser-empty-icon {
  color: var(--dsw-alias-label-secondary, #5f6268);
}
.dsh-desktop-browser-empty strong {
  color: var(--dsw-alias-label-primary, #17191c);
  font-size: 20px;
  font-weight: 600;
}
.dsh-desktop-browser-error {
  background: var(--dsw-alias-interactive-bg-hover-danger, #fdefed);
  bottom: 10px;
  color: var(--dsw-alias-state-error-primary, #b42318);
  font-size: 12px;
  left: 10px;
  line-height: 18px;
  max-width: calc(100% - 20px);
  padding: 7px 9px;
  position: absolute;
}
@media (max-width: 720px) {
  .dsh-desktop-browser-tab { flex-basis: 150px; }
  .dsh-desktop-browser-toolbar { grid-template-columns: 28px 28px 28px minmax(80px, 1fr) 28px; }
  .dsh-desktop-browser-history { min-width: min(620px, 82vw); }
  .dsh-desktop-browser-management-modal { width: 94vw; }
  .dsh-desktop-browser-management { height: 68vh; min-height: 360px; }
}
`

function browserManagementTitle(page: BrowserManagementPage, t: DesktopTranslate): string {
  if (page === 'import') return t('Import Browser Data')
  if (page === 'passwords') return t('Password Manager')
  return t('Contact Information')
}

function browserStatus(state: BrowserState | undefined, t: DesktopTranslate): string {
  if (state === undefined) return t('Controlled browser loading')
  if (!state.settings.enabled) return t('Controlled browser off')
  if (state.runtimeStatus === 'ready') return t('Controlled browser ready')
  if (state.runtimeStatus === 'starting') return t('Controlled browser starting')
  if (state.runtimeStatus === 'error') return t('Controlled browser needs attention')
  return t('Controlled browser stopped')
}

export function BrowserSettingsSection({
  bridge,
  t,
}: {
  bridge?: DesktopBrowserBridge
  t: DesktopTranslate
}): React.JSX.Element {
  const [state, setState] = useState<BrowserState>()
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [managementPage, setManagementPage] = useState<BrowserManagementPage>()

  const run = (operation: () => Promise<BrowserState>): void => {
    setBusy(true)
    setError(undefined)
    void operation().then(setState).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browser settings could not be updated.'))
    }).finally(() => setBusy(false))
  }

  useEffect(() => {
    if (bridge === undefined) {
      setError(t('Browser is unavailable in this desktop build.'))
      return
    }
    let active = true
    const stop = bridge.onChanged(next => {
      if (active) setState(next)
    })
    void bridge.getState().then(next => {
      if (active) setState(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : t('Browser is unavailable.'))
    })
    return () => {
      active = false
      stop()
    }
  }, [bridge, t])

  const update = (input: UpdateBrowserSettingsInput): void => {
    if (bridge !== undefined) run(() => bridge.update(input))
  }

  const openHistory = (): void => {
    if (bridge === undefined) return
    setHistoryOpen(true)
    setError(undefined)
    void bridge.listHistory().then(setHistory).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browsing history could not be loaded.'))
    })
  }

  const clearHistory = (): void => {
    if (bridge === undefined) return
    setBusy(true)
    void bridge.clearHistory().then(next => {
      setState(next)
      setHistory([])
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browsing history could not be cleared.'))
    }).finally(() => setBusy(false))
  }

  const clearData = (): void => {
    if (bridge === undefined) return
    setBusy(true)
    setError(undefined)
    void bridge.clearData().then(next => {
      setState(next)
      setHistory([])
      setClearOpen(false)
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browsing data could not be cleared.'))
    }).finally(() => setBusy(false))
  }

  const openManagement = (page: BrowserManagementPage): void => {
    if (bridge === undefined) return
    setBusy(true)
    setError(undefined)
    void bridge.openManagement({ page }).then(next => {
      setState(next)
      setManagementPage(page)
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browser management could not be opened.'))
    }).finally(() => setBusy(false))
  }

  return (
    <SettingsPage title={t('Browser')} subtitle={t('Manage the controlled browser used by DSH.')}>
      <style>{styles}</style>
      <SettingsGroup>
        <SettingsRow
          icon={<span className="dsh-desktop-browser-icon"><IconBrowseOutline16 /></span>}
          title={t('Browser')}
          description={browserStatus(state, t)}
          control={state === undefined ? undefined : (
            <SettingsToggle
              label={t('Enable controlled browser')}
              checked={state.settings.enabled}
              disabled={busy}
              onChange={enabled => update({ enabled })}
            />
          )}
        />
      </SettingsGroup>

      <SettingsSection
        title={t('General')}
        action={(
          <Button
            size="sm"
            variant="outline"
            disabled={busy || bridge === undefined || state?.settings.enabled !== true}
            onClick={() => openManagement('import')}
          >
            {t('Import...')}
          </Button>
        )}
      >
        <SettingsGroup>
          <SettingsRow
            title={t('Web URLs and links open in')}
            description={t('Default destination for web links')}
            control={state === undefined ? undefined : (
              <SettingsSelect
                label={t('Web URL target')}
                value={state.settings.webUrlTarget}
                disabled={busy}
                onChange={value => update({ webUrlTarget: value as 'system' | 'controlled' })}
              >
                <option value="system">{t('Default browser')}</option>
                <option value="controlled">{t('DSH Browser')}</option>
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title={t('Local URLs open in')}
            description={t('Default destination for local development links')}
            control={state === undefined ? undefined : (
              <SettingsSelect
                label={t('Local URL target')}
                value={state.settings.localUrlTarget}
                disabled={busy}
                onChange={value => update({ localUrlTarget: value as 'system' | 'controlled' })}
              >
                <option value="controlled">{t('DSH Browser')}</option>
                <option value="system">{t('Default browser')}</option>
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title={t('Browsing data')}
            description={t('Cookies, site storage, permissions, cache, downloads, and history')}
            control={(
              <Button size="sm" variant="outline" disabled={busy || bridge === undefined} onClick={() => setClearOpen(true)}>
                {t('Clear')}
              </Button>
            )}
          />
          <SettingsRow
            title={t('Browsing history')}
            description={t(state?.historyCount === 1 ? '{count} visited page' : '{count} visited pages', {
              count: String(state?.historyCount ?? 0),
            })}
            control={(
              <Button size="sm" variant="outline" disabled={busy || bridge === undefined} onClick={openHistory}>
                {t('Manage')}
              </Button>
            )}
          />
          <SettingsRow
            title={t('Annotated screenshots')}
            description={t('Control when page images accompany browser observations')}
            control={state === undefined ? undefined : (
              <SettingsSelect
                label={t('Browser screenshot policy')}
                value={state.settings.screenshotPolicy}
                disabled={busy}
                onChange={value => update({ screenshotPolicy: value as 'always' | 'on-demand' | 'never' })}
              >
                <option value="always">{t('Always include')}</option>
                <option value="on-demand">{t('On demand')}</option>
                <option value="never">{t('Never include')}</option>
              </SettingsSelect>
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('Autofill and passwords')}>
        <SettingsGroup>
          <SettingsRow
            title={t('Password Manager')}
            description={t('Add, delete, and edit saved passwords')}
            control={(
              <Button
                size="sm"
                variant="outline"
                disabled={busy || bridge === undefined || state?.settings.enabled !== true}
                onClick={() => openManagement('passwords')}
              >
                {t('Manage')}
              </Button>
            )}
          />
          <SettingsRow
            title={t('Contact Information')}
            description={t('Add, delete, and edit saved addresses, phone numbers, and email addresses')}
            control={(
              <Button
                size="sm"
                variant="outline"
                disabled={busy || bridge === undefined || state?.settings.enabled !== true}
                onClick={() => openManagement('contacts')}
              >
                {t('Manage')}
              </Button>
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      {error !== undefined && <SettingsNotice level="error">{error}</SettingsNotice>}
      {error === undefined && state?.statusMessage !== undefined && (
        <SettingsNotice level="info">{state.statusMessage}</SettingsNotice>
      )}

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title={t('Browsing History')}
        closeLabel={t('Close browsing history')}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>{t('Done')}</Button>
            <Button
              variant="outline"
              icon={<IconTrashOutline16 />}
              disabled={busy || history.length === 0}
              onClick={clearHistory}
            >
              {t('Clear History')}
            </Button>
          </div>
        )}
      >
        <div className="dsh-desktop-browser-history">
          {history.length === 0 && <div className="dsh-desktop-browser-history-row">{t('No browsing history')}</div>}
          {history.map(entry => (
            <div className="dsh-desktop-browser-history-row" key={entry.id}>
              <span className="dsh-desktop-browser-history-title">{entry.title || entry.url}</span>
              <span className="dsh-desktop-browser-history-meta">{entry.url}</span>
              <span className="dsh-desktop-browser-history-meta">{new Date(entry.visitedAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title={t('Clear Browsing Data')}
        closeLabel={t('Close clear browsing data confirmation')}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="outline" disabled={busy} onClick={() => setClearOpen(false)}>{t('Cancel')}</Button>
            <Button variant="primary" icon={<IconTrashOutline16 />} disabled={busy} onClick={clearData}>
              {t('Clear Data')}
            </Button>
          </div>
        )}
      >
        <div className="dsh-desktop-browser-confirm">
          <span>{t('Cookies, site storage, permissions, cache, downloads, and browsing history will be removed.')}</span>
          {state?.settings.storageMode === 'persistent' && (
            <span>{t('You will be signed out of websites in the persistent browser session.')}</span>
          )}
        </div>
      </Modal>

      <Modal
        open={managementPage !== undefined}
        onClose={() => setManagementPage(undefined)}
        title={managementPage === undefined ? t('Browser Management') : browserManagementTitle(managementPage, t)}
        closeLabel={t('Close browser management')}
        className="dsh-desktop-browser-management-modal"
      >
        <div className="dsh-desktop-browser-management">
          <BrowserView bridge={bridge} t={t} />
        </div>
      </Modal>
    </SettingsPage>
  )
}

export function BrowserView({
  bridge,
  onClose,
  onOpenSettings,
  t,
}: {
  bridge?: DesktopBrowserBridge
  onClose?: () => void
  onOpenSettings?: () => void
  t: DesktopTranslate
}): React.JSX.Element {
  const [state, setState] = useState<BrowserState>()
  const [frame, setFrame] = useState<BrowserFrame>()
  const [address, setAddress] = useState('')
  const [addressFocused, setAddressFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const busyRef = useRef(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef('')
  const interactionRef = useRef<{ snapshotId: string; tabId: string }>()
  const keyboardQueueRef = useRef<BrowserUiKeyboardAction[]>([])
  const keyboardRunningRef = useRef(false)
  const keyboardTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const pendingScrollRef = useRef<{
    normalizedX: number
    normalizedY: number
    deltaX: number
    deltaY: number
  }>()
  const scrollRunningRef = useRef(false)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (bridge === undefined) {
      setError(t('Browser is unavailable in this desktop build.'))
      return
    }
    let active = true
    const offChanged = bridge.onChanged(next => {
      if (!active) return
      setState(next)
      setAddress(activeBrowserAddress(next))
      interactionRef.current = next.lastObservation === undefined
        ? undefined
        : { snapshotId: next.lastObservation.snapshotId, tabId: next.lastObservation.tabId }
    })
    const offFrame = bridge.onFrame(next => {
      if (!active) return
      interactionRef.current = next === undefined
        ? undefined
        : { snapshotId: next.snapshotId, tabId: next.tabId }
      setFrame(next)
    })
    void bridge.getState().then(async next => {
      if (!active) return
      setState(next)
      setAddress(activeBrowserAddress(next))
      interactionRef.current = next.lastObservation === undefined
        ? undefined
        : { snapshotId: next.lastObservation.snapshotId, tabId: next.lastObservation.tabId }
      if (next.settings.enabled && next.runtimeStatus === 'ready') await bridge.refreshFrame()
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : t('Browser is unavailable.'))
    })
    return () => {
      active = false
      offChanged()
      offFrame()
    }
  }, [bridge, t])

  const frameUrl = useMemo(() => {
    if (frame === undefined) return undefined
    const bytes = new Uint8Array(frame.data)
    return URL.createObjectURL(new Blob([bytes], { type: frame.mediaType }))
  }, [frame])

  useEffect(() => () => {
    if (frameUrl !== undefined) URL.revokeObjectURL(frameUrl)
  }, [frameUrl])

  useEffect(() => () => {
    if (keyboardTimerRef.current !== undefined) clearTimeout(keyboardTimerRef.current)
    if (scrollTimerRef.current !== undefined) clearTimeout(scrollTimerRef.current)
    keyboardQueueRef.current = []
    pendingScrollRef.current = undefined
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (bridge === undefined || stage === null || state?.settings.enabled !== true) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: BrowserUiViewportInput | undefined
    const flush = (): void => {
      timer = undefined
      const input = pending
      pending = undefined
      if (!active || input === undefined) return
      const key = `${String(input.pixelWidth)}x${String(input.pixelHeight)}`
      if (viewportRef.current === key) return
      viewportRef.current = key
      void bridge.resizeViewport(input).then(next => {
        if (!active) return
        setState(next)
        setAddress(activeBrowserAddress(next))
      }).catch(cause => {
        if (!active) return
        viewportRef.current = ''
        setError(cause instanceof Error ? cause.message : t('The browser viewport could not be updated.'))
      })
    }
    const queue = (): void => {
      const bounds = stage.getBoundingClientRect()
      const pixelWidth = Math.floor(bounds.width)
      const pixelHeight = Math.floor(bounds.height)
      if (pixelWidth < 240 || pixelHeight < 240) return
      pending = { pixelWidth: Math.min(2_560, pixelWidth), pixelHeight: Math.min(2_560, pixelHeight) }
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(flush, 80)
    }
    const observer = new ResizeObserver(queue)
    observer.observe(stage)
    queue()
    return () => {
      active = false
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [bridge, state?.settings.enabled, t])

  const run = (operation: () => Promise<BrowserState>): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    void operation().then(next => {
      setState(next)
      setAddress(activeBrowserAddress(next))
      interactionRef.current = next.lastObservation === undefined
        ? undefined
        : { snapshotId: next.lastObservation.snapshotId, tabId: next.lastObservation.tabId }
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('The browser operation failed.'))
    }).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }

  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    const url = normalizeBrowserAddress(address)
    if (bridge === undefined || url === '') return
    setAddress(url)
    run(() => bridge.navigate({ url }))
  }

  const tabs = state?.tabs ?? []
  const activeTab = tabs.find(tab => tab.id === state?.activeTabId)
  const blankTab = activeTab === undefined || activeTab.url === 'about:blank'
  const showFrame = frameUrl !== undefined && frame?.tabId === activeTab?.id && !blankTab
  const disabled = bridge === undefined || busy || state?.settings.enabled !== true
  const interactive = bridge !== undefined && showFrame && state?.settings.enabled === true

  const pointerInput = (
    event: ReactMouseEvent<HTMLDivElement>,
    button: 'left' | 'right',
  ): void => {
    if (bridge === undefined || frame === undefined || disabled) return
    const point = normalizedBrowserPoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      frame,
    )
    if (point === undefined) return
    event.preventDefault()
    event.currentTarget.focus()
    run(() => bridge.pointer({
      snapshotId: frame.snapshotId,
      tabId: frame.tabId,
      ...point,
      button,
    }))
  }

  const flushScroll = (): void => {
    scrollTimerRef.current = undefined
    if (scrollRunningRef.current || pendingScrollRef.current === undefined) return
    if (busyRef.current) {
      scrollTimerRef.current = setTimeout(flushScroll, 24)
      return
    }
    const input = pendingScrollRef.current
    const identity = interactionRef.current
    pendingScrollRef.current = undefined
    if ((input.deltaX === 0 && input.deltaY === 0) || bridge === undefined ||
      identity === undefined || state?.settings.enabled !== true) return
    scrollRunningRef.current = true
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    void bridge.scrollAt({ ...identity, ...input }).then(next => {
      const observation = next.lastObservation
      if (observation === undefined) throw new Error(t('The controlled browser stopped before scrolling completed.'))
      interactionRef.current = { snapshotId: observation.snapshotId, tabId: observation.tabId }
      setState(next)
      setAddress(activeBrowserAddress(next))
    }).catch(cause => {
      pendingScrollRef.current = undefined
      setError(cause instanceof Error ? cause.message : t('The browser scroll operation failed.'))
    }).finally(() => {
      scrollRunningRef.current = false
      busyRef.current = false
      setBusy(false)
      if (pendingScrollRef.current !== undefined && scrollTimerRef.current === undefined) {
        scrollTimerRef.current = setTimeout(flushScroll, 0)
      }
    })
  }

  const scrollInput = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (bridge === undefined || frame === undefined || !interactive ||
      (busyRef.current && !scrollRunningRef.current)) return
    const point = normalizedBrowserPoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      frame,
    )
    if (point === undefined || (event.deltaX === 0 && event.deltaY === 0)) return
    event.preventDefault()
    const pending = pendingScrollRef.current
    const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.pixelHeight : 1
    pendingScrollRef.current = {
      ...point,
      deltaX: Math.max(-20_000, Math.min(20_000, (pending?.deltaX ?? 0) + event.deltaX * deltaScale)),
      deltaY: Math.max(-20_000, Math.min(20_000, (pending?.deltaY ?? 0) + event.deltaY * deltaScale)),
    }
    if (scrollTimerRef.current === undefined && !scrollRunningRef.current) {
      scrollTimerRef.current = setTimeout(flushScroll, 24)
    }
  }

  const flushKeyboard = (): void => {
    keyboardTimerRef.current = undefined
    if (keyboardRunningRef.current || keyboardQueueRef.current.length === 0) return
    if (busyRef.current) {
      keyboardTimerRef.current = setTimeout(flushKeyboard, 24)
      return
    }
    const initialIdentity = interactionRef.current
    if (bridge === undefined || initialIdentity === undefined || state?.settings.enabled !== true) {
      keyboardQueueRef.current = []
      return
    }
    keyboardRunningRef.current = true
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    void (async () => {
      let identity = initialIdentity
      while (keyboardQueueRef.current.length > 0) {
        const actions = keyboardQueueRef.current.splice(0, 64)
        const next = await bridge.keyboard({ ...identity, actions })
        const observation = next.lastObservation
        if (observation === undefined) throw new Error(t('The controlled browser stopped before keyboard input completed.'))
        identity = { snapshotId: observation.snapshotId, tabId: observation.tabId }
        interactionRef.current = identity
        setState(next)
        setAddress(activeBrowserAddress(next))
      }
    })().catch(cause => {
      keyboardQueueRef.current = []
      setError(cause instanceof Error ? cause.message : t('The browser keyboard operation failed.'))
    }).finally(() => {
      keyboardRunningRef.current = false
      busyRef.current = false
      setBusy(false)
      if (keyboardQueueRef.current.length > 0 && keyboardTimerRef.current === undefined) {
        keyboardTimerRef.current = setTimeout(flushKeyboard, 0)
      }
    })
  }

  const keyboardInput = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!interactive) return
    const action = browserKeyboardAction({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })
    if (action === undefined) return
    event.preventDefault()
    const last = keyboardQueueRef.current.at(-1)
    if (action.kind === 'text' && last?.kind === 'text' && last.text.length + action.text.length <= 8_192) {
      last.text += action.text
      return
    }
    if (keyboardQueueRef.current.length >= 256) {
      setError(t('Browser input is still catching up. Pause briefly before typing more.'))
      return
    }
    keyboardQueueRef.current.push(action)
    if (keyboardTimerRef.current === undefined && !keyboardRunningRef.current) {
      keyboardTimerRef.current = setTimeout(flushKeyboard, 24)
    }
  }

  return (
    <section className="dsh-desktop-browser-view" aria-label={t('Browser')}>
      <style>{styles}</style>
      <div className="dsh-desktop-browser-tabs">
        <div className="dsh-desktop-browser-tab-list" role="tablist" aria-label={t('Browser tabs')}>
          {tabs.map(tab => (
            <div className="dsh-desktop-browser-tab" data-active={tab.id === state?.activeTabId} key={tab.id}>
              <button
                type="button"
                className="dsh-desktop-browser-tab-main"
                role="tab"
                aria-selected={tab.id === state?.activeTabId}
                title={tab.title || tab.url || t('New tab')}
                disabled={disabled}
                onClick={() => { if (bridge !== undefined) run(() => bridge.activateTab({ tabId: tab.id })) }}
              >
                <IconGlobeOutline14 size={16} />
                <span>{tab.title || (tab.url === 'about:blank' ? t('New tab') : tab.url)}</span>
              </button>
              <button
                type="button"
                className="dsh-desktop-browser-icon-button"
                title={t('Close tab')}
                aria-label={t('Close {name}', { name: tab.title || t('tab') })}
                disabled={disabled}
                onClick={() => { if (bridge !== undefined) run(() => bridge.closeTab({ tabId: tab.id })) }}
              >
                <IconCloseOutline16 />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="dsh-desktop-browser-icon-button"
            title={t('New tab')}
            aria-label={t('New browser tab')}
            disabled={disabled}
            onClick={() => { if (bridge !== undefined) run(() => bridge.newTab()) }}
          >
            <IconPlusOutline16 />
          </button>
        </div>
        {onClose !== undefined && (
          <div className="dsh-desktop-browser-window-actions">
            <button
              type="button"
              className="dsh-desktop-browser-icon-button"
              title={t('Close right sidebar')}
              aria-label={t('Close right sidebar')}
              onClick={onClose}
            >
              <IconPanelLeftOutline16 className="dsh-desktop-browser-panel-icon" />
            </button>
          </div>
        )}
      </div>
      <form className="dsh-desktop-browser-toolbar" onSubmit={navigate}>
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title={t('Back')}
          aria-label={t('Go back')}
          disabled={disabled || state?.canGoBack !== true}
          onClick={() => { if (bridge !== undefined) run(() => bridge.back()) }}
        >
          <IconChevronLeftOutline14 />
        </button>
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title={t('Forward')}
          aria-label={t('Go forward')}
          disabled={disabled || state?.canGoForward !== true}
          onClick={() => { if (bridge !== undefined) run(() => bridge.forward()) }}
        >
          <IconChevronRightOutline14 />
        </button>
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title={t('Reload')}
          aria-label={t('Reload page')}
          disabled={disabled || state?.activeTabId === undefined}
          onClick={() => { if (bridge !== undefined) run(() => bridge.reload()) }}
        >
          <IconRefreshOutline16 />
        </button>
        <input
          className="dsh-desktop-browser-address"
          aria-label={t('Browser address')}
          placeholder={t('Enter URL')}
          value={addressFocused ? address : browserAddressLabel(address)}
          disabled={disabled}
          onChange={event => setAddress(event.currentTarget.value)}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
        />
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title={t('Browser Settings')}
          aria-label={t('Browser Settings')}
          disabled={onOpenSettings === undefined}
          onClick={onOpenSettings}
        >
          <IconEllipsisOutline16 />
        </button>
      </form>
      <div
        ref={stageRef}
        className="dsh-desktop-browser-stage"
        data-busy={busy}
        data-interactive={interactive}
        tabIndex={interactive ? 0 : -1}
        role="application"
        aria-label={t('Controlled browser page')}
        aria-busy={busy}
        onClick={event => pointerInput(event, 'left')}
        onContextMenu={event => pointerInput(event, 'right')}
        onKeyDown={keyboardInput}
        onWheel={scrollInput}
      >
        {showFrame ? (
          <img src={frameUrl} alt={state?.lastObservation?.title || t('Controlled browser page')} draggable={false} />
        ) : (
          <div className="dsh-desktop-browser-empty">
            <IconGlobeOutline14 className="dsh-desktop-browser-empty-icon" size={48} />
            {state?.settings.enabled === true && blankTab && state.runtimeStatus !== 'starting' ? (
              <>
                <strong>{t('Start browsing')}</strong>
                <span>{t('Enter a URL to begin')}</span>
              </>
            ) : (
              <strong>{state?.settings.enabled === true
                ? t('Starting browser')
                : t('Enable Browser in Settings')}</strong>
            )}
          </div>
        )}
        {error !== undefined && <div className="dsh-desktop-browser-error" role="alert">{error}</div>}
      </div>
    </section>
  )
}
