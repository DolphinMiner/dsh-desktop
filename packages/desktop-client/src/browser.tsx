import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'

import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconBrowseOutline16,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconPauseOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  BrowserFrame,
  BrowserHistoryEntry,
  BrowserState,
  BrowserUiNavigateInput,
  BrowserUiTabInput,
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
import { activeBrowserAddress, normalizeBrowserAddress } from './browser-view-model.js'

export interface DesktopBrowserBridge {
  getState(): Promise<BrowserState>
  update(input: UpdateBrowserSettingsInput): Promise<BrowserState>
  navigate(input: BrowserUiNavigateInput): Promise<BrowserState>
  activateTab(input: BrowserUiTabInput): Promise<BrowserState>
  newTab(): Promise<BrowserState>
  closeTab(input: BrowserUiTabInput): Promise<BrowserState>
  back(): Promise<BrowserState>
  forward(): Promise<BrowserState>
  reload(): Promise<BrowserState>
  refreshFrame(): Promise<BrowserState>
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
.dsh-desktop-browser-view,
.dsh-desktop-browser-view * {
  box-sizing: border-box;
  letter-spacing: 0;
}
.dsh-desktop-browser-view {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #17191c);
  display: grid;
  grid-template-rows: 38px 48px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.dsh-desktop-browser-tabs {
  align-items: end;
  background: var(--dsw-alias-bg-layer-1, #f7f7f5);
  border-bottom: 1px solid var(--dsw-alias-border-l2, #deded9);
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  padding: 5px 8px 0;
}
.dsh-desktop-browser-tab {
  align-items: center;
  border-radius: 6px 6px 0 0;
  display: grid;
  flex: 0 0 190px;
  grid-template-columns: minmax(0, 1fr) 28px;
  height: 32px;
  max-width: 220px;
}
.dsh-desktop-browser-tab[data-active="true"] {
  background: var(--dsw-alias-bg-base, #fff);
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
  height: 100%;
  overflow: hidden;
  padding: 0 5px 0 10px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: var(--dsw-alias-bg-overlay, #f2f2ef);
  border: 1px solid transparent;
  border-radius: 7px;
  color: inherit;
  font: inherit;
  font-size: 12px;
  height: 31px;
  min-width: 0;
  outline: none;
  padding: 0 11px;
  width: 100%;
}
.dsh-desktop-browser-address:focus {
  border-color: var(--dsw-alias-state-business-primary, #2f9cf4);
}
.dsh-desktop-browser-stage {
  background: #eef0f2;
  display: grid;
  min-height: 0;
  overflow: hidden;
  place-items: center;
  position: relative;
}
.dsh-desktop-browser-stage img {
  height: 100%;
  object-fit: contain;
  width: 100%;
}
.dsh-desktop-browser-empty {
  color: var(--dsw-alias-label-tertiary, #74777d);
  display: grid;
  font-size: 13px;
  gap: 10px;
  justify-items: center;
  padding: 24px;
  text-align: center;
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
}
`

function browserStatus(state: BrowserState | undefined): string {
  if (state === undefined) return 'Loading'
  if (!state.settings.enabled) return 'Off'
  if (state.runtimeStatus === 'ready') return 'Ready'
  if (state.runtimeStatus === 'starting') return 'Starting'
  if (state.runtimeStatus === 'error') return 'Needs attention'
  return 'Stopped'
}

export function BrowserSettingsSection({
  bridge,
}: {
  bridge?: DesktopBrowserBridge
}): React.JSX.Element {
  const [state, setState] = useState<BrowserState>()
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)

  const run = (operation: () => Promise<BrowserState>): void => {
    setBusy(true)
    setError(undefined)
    void operation().then(setState).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Browser settings could not be updated.')
    }).finally(() => setBusy(false))
  }

  useEffect(() => {
    if (bridge === undefined) {
      setError('Browser is unavailable in this desktop build.')
      return
    }
    let active = true
    const stop = bridge.onChanged(next => {
      if (active) setState(next)
    })
    void bridge.getState().then(next => {
      if (active) setState(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Browser is unavailable.')
    })
    return () => {
      active = false
      stop()
    }
  }, [bridge])

  const update = (input: UpdateBrowserSettingsInput): void => {
    if (bridge !== undefined) run(() => bridge.update(input))
  }

  const openHistory = (): void => {
    if (bridge === undefined) return
    setHistoryOpen(true)
    setError(undefined)
    void bridge.listHistory().then(setHistory).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Browsing history could not be loaded.')
    })
  }

  const clearHistory = (): void => {
    if (bridge === undefined) return
    setBusy(true)
    void bridge.clearHistory().then(next => {
      setState(next)
      setHistory([])
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Browsing history could not be cleared.')
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
      setError(cause instanceof Error ? cause.message : 'Browsing data could not be cleared.')
    }).finally(() => setBusy(false))
  }

  return (
    <SettingsPage title="Browser" subtitle="Manage the controlled browser used by DSH.">
      <style>{styles}</style>
      <SettingsGroup>
        <SettingsRow
          icon={<span className="dsh-desktop-browser-icon"><IconBrowseOutline16 /></span>}
          title="Browser"
          description={`Controlled browser ${browserStatus(state).toLocaleLowerCase()}`}
          control={state === undefined ? undefined : (
            <SettingsToggle
              label="Enable controlled browser"
              checked={state.settings.enabled}
              disabled={busy}
              onChange={enabled => update({ enabled })}
            />
          )}
        />
      </SettingsGroup>

      <SettingsSection title="General">
        <SettingsGroup>
          <SettingsRow
            title="Web URLs and links open in"
            description="Default destination for web links"
            control={state === undefined ? undefined : (
              <SettingsSelect
                label="Web URL target"
                value={state.settings.webUrlTarget}
                disabled={busy}
                onChange={value => update({ webUrlTarget: value as 'system' | 'controlled' })}
              >
                <option value="system">Default browser</option>
                <option value="controlled">DSH Browser</option>
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title="Local URLs open in"
            description="Default destination for local development links"
            control={state === undefined ? undefined : (
              <SettingsSelect
                label="Local URL target"
                value={state.settings.localUrlTarget}
                disabled={busy}
                onChange={value => update({ localUrlTarget: value as 'system' | 'controlled' })}
              >
                <option value="controlled">DSH Browser</option>
                <option value="system">Default browser</option>
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title="Browsing data"
            description="Cookies, site storage, permissions, cache, downloads, and history"
            control={(
              <Button size="sm" variant="outline" disabled={busy || bridge === undefined} onClick={() => setClearOpen(true)}>
                Clear
              </Button>
            )}
          />
          <SettingsRow
            title="Browsing history"
            description={`${String(state?.historyCount ?? 0)} visited ${state?.historyCount === 1 ? 'page' : 'pages'}`}
            control={(
              <Button size="sm" variant="outline" disabled={busy || bridge === undefined} onClick={openHistory}>
                Manage
              </Button>
            )}
          />
          <SettingsRow
            title="Annotated screenshots"
            description="Control when page images accompany browser observations"
            control={state === undefined ? undefined : (
              <SettingsSelect
                label="Browser screenshot policy"
                value={state.settings.screenshotPolicy}
                disabled={busy}
                onChange={value => update({ screenshotPolicy: value as 'always' | 'on-demand' | 'never' })}
              >
                <option value="always">Always include</option>
                <option value="on-demand">On demand</option>
                <option value="never">Never include</option>
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title="Browser session"
            description="Choose whether sign-in and site data survive app restarts"
            control={state === undefined ? undefined : (
              <SettingsSelect
                label="Browser storage mode"
                value={state.settings.storageMode}
                disabled={busy}
                onChange={value => update({ storageMode: value as 'isolated' | 'persistent' })}
              >
                <option value="isolated">Isolated</option>
                <option value="persistent">Persistent</option>
              </SettingsSelect>
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
        title="Browsing History"
        closeLabel="Close browsing history"
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>Done</Button>
            <Button
              variant="outline"
              icon={<IconTrashOutline16 />}
              disabled={busy || history.length === 0}
              onClick={clearHistory}
            >
              Clear History
            </Button>
          </div>
        )}
      >
        <div className="dsh-desktop-browser-history">
          {history.length === 0 && <div className="dsh-desktop-browser-history-row">No browsing history</div>}
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
        title="Clear Browsing Data"
        closeLabel="Close clear browsing data confirmation"
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="outline" disabled={busy} onClick={() => setClearOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={<IconTrashOutline16 />} disabled={busy} onClick={clearData}>
              Clear Data
            </Button>
          </div>
        )}
      >
        <div className="dsh-desktop-browser-confirm">
          <span>Cookies, site storage, permissions, cache, downloads, and browsing history will be removed.</span>
          {state?.settings.storageMode === 'persistent' && (
            <span>You will be signed out of websites in the persistent browser session.</span>
          )}
        </div>
      </Modal>
    </SettingsPage>
  )
}

export function BrowserView({
  bridge,
}: ConvViewProps & {
  bridge?: DesktopBrowserBridge
}): React.JSX.Element {
  const [state, setState] = useState<BrowserState>()
  const [frame, setFrame] = useState<BrowserFrame>()
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (bridge === undefined) {
      setError('Browser is unavailable in this desktop build.')
      return
    }
    let active = true
    const offChanged = bridge.onChanged(next => {
      if (!active) return
      setState(next)
      setAddress(activeBrowserAddress(next))
    })
    const offFrame = bridge.onFrame(next => {
      if (active) setFrame(next)
    })
    void bridge.getState().then(async next => {
      if (!active) return
      setState(next)
      setAddress(activeBrowserAddress(next))
      if (next.settings.enabled && next.runtimeStatus === 'ready') await bridge.refreshFrame()
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Browser is unavailable.')
    })
    return () => {
      active = false
      offChanged()
      offFrame()
    }
  }, [bridge])

  const frameUrl = useMemo(() => {
    if (frame === undefined) return undefined
    const bytes = new Uint8Array(frame.data)
    return URL.createObjectURL(new Blob([bytes], { type: frame.mediaType }))
  }, [frame])

  useEffect(() => () => {
    if (frameUrl !== undefined) URL.revokeObjectURL(frameUrl)
  }, [frameUrl])

  const run = (operation: () => Promise<BrowserState>): void => {
    setBusy(true)
    setError(undefined)
    void operation().then(setState).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'The browser operation failed.')
    }).finally(() => setBusy(false))
  }

  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    const url = normalizeBrowserAddress(address)
    if (bridge === undefined || url === '') return
    setAddress(url)
    run(() => bridge.navigate({ url }))
  }

  const tabs = state?.tabs ?? []
  const disabled = bridge === undefined || busy || state?.settings.enabled !== true

  return (
    <section className="dsh-desktop-browser-view" aria-label="Browser">
      <style>{styles}</style>
      <div className="dsh-desktop-browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map(tab => (
          <div className="dsh-desktop-browser-tab" data-active={tab.id === state?.activeTabId} key={tab.id}>
            <button
              type="button"
              className="dsh-desktop-browser-tab-main"
              role="tab"
              aria-selected={tab.id === state?.activeTabId}
              title={tab.title || tab.url || 'New tab'}
              disabled={disabled}
              onClick={() => { if (bridge !== undefined) run(() => bridge.activateTab({ tabId: tab.id })) }}
            >
              {tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}
            </button>
            <button
              type="button"
              className="dsh-desktop-browser-icon-button"
              title="Close tab"
              aria-label={`Close ${tab.title || 'tab'}`}
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
          title="New tab"
          aria-label="New browser tab"
          disabled={disabled}
          onClick={() => { if (bridge !== undefined) run(() => bridge.newTab()) }}
        >
          <IconPlusOutline16 />
        </button>
      </div>
      <form className="dsh-desktop-browser-toolbar" onSubmit={navigate}>
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title="Back"
          aria-label="Go back"
          disabled={disabled || state?.canGoBack !== true}
          onClick={() => { if (bridge !== undefined) run(() => bridge.back()) }}
        >
          <IconChevronLeftOutline14 />
        </button>
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title="Forward"
          aria-label="Go forward"
          disabled={disabled || state?.canGoForward !== true}
          onClick={() => { if (bridge !== undefined) run(() => bridge.forward()) }}
        >
          <IconChevronRightOutline14 />
        </button>
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title="Reload"
          aria-label="Reload page"
          disabled={disabled || state?.activeTabId === undefined}
          onClick={() => { if (bridge !== undefined) run(() => bridge.reload()) }}
        >
          <IconRefreshOutline16 />
        </button>
        <input
          className="dsh-desktop-browser-address"
          aria-label="Browser address"
          placeholder="Search or enter website"
          value={address}
          disabled={disabled}
          onChange={event => setAddress(event.currentTarget.value)}
        />
        <button
          type="button"
          className="dsh-desktop-browser-icon-button"
          title="Stop browser"
          aria-label="Stop controlled browser"
          disabled={bridge === undefined || state?.settings.enabled !== true}
          onClick={() => { if (bridge !== undefined) run(() => bridge.stop()) }}
        >
          <IconPauseOutline16 />
        </button>
      </form>
      <div className="dsh-desktop-browser-stage">
        {frameUrl !== undefined ? (
          <img src={frameUrl} alt={state?.lastObservation?.title || 'Controlled browser page'} draggable={false} />
        ) : (
          <div className="dsh-desktop-browser-empty">
            <IconBrowseOutline16 />
            <span>{state?.settings.enabled === true
              ? state.runtimeStatus === 'starting'
                ? 'Starting browser'
                : 'Enter a URL to begin'
              : 'Enable Browser in Settings'}</span>
          </div>
        )}
        {error !== undefined && <div className="dsh-desktop-browser-error" role="alert">{error}</div>}
      </div>
    </section>
  )
}
