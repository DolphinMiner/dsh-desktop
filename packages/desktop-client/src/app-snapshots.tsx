import { useEffect, useSyncExternalStore, useState } from 'react'

import type { ClientContext, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button,
  IconFullscreenOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AppSnapshotCapture,
  AppSnapshotErrorNotice,
  AppSnapshotSettings,
  AppSnapshotState,
  UpdateAppSnapshotSettingsInput,
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
import { attachAppSnapshotCapture, mountAppSnapshotDelivery } from './app-snapshot-delivery.js'
import type { DesktopTranslate } from './locales.js'
import { openOfficialSettings } from './settings-navigation.js'

export interface DesktopAppSnapshotsBridge {
  getState(): Promise<AppSnapshotState>
  refresh(): Promise<AppSnapshotState>
  update(input: UpdateAppSnapshotSettingsInput): Promise<AppSnapshotState>
  capture(): Promise<void>
  openScreenRecordingSettings(): Promise<void>
  onChanged(listener: (state: AppSnapshotState) => void): () => void
  onCaptured(listener: (capture: AppSnapshotCapture) => void): () => void
  onError(listener: (notice: AppSnapshotErrorNotice) => void): () => void
}

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface SnapshotPresentation {
  previewUrl?: string
  capture?: AppSnapshotCapture
  notice?: { level: 'info' | 'error'; message: string }
}

const presentationListeners = new Set<() => void>()
let presentation: SnapshotPresentation = {}

function publishPresentation(next: SnapshotPresentation): void {
  if (presentation.previewUrl !== undefined && presentation.previewUrl !== next.previewUrl) {
    URL.revokeObjectURL(presentation.previewUrl)
  }
  presentation = next
  for (const listener of presentationListeners) listener()
}

function presentationSource(): SnapshotSource<SnapshotPresentation> {
  return {
    getSnapshot: () => presentation,
    subscribe(listener) {
      presentationListeners.add(listener)
      return () => { presentationListeners.delete(listener) }
    },
  }
}

const PRESENTATION_SOURCE = presentationSource()

function useSnapshot<T>(source: SnapshotSource<T>): T {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}

function rememberCapture(capture: AppSnapshotCapture, notice?: SnapshotPresentation['notice']): void {
  const existingPreview = presentation.capture?.id === capture.id
    ? presentation.previewUrl
    : undefined
  const previewUrl = existingPreview ?? URL.createObjectURL(new Blob(
    [capture.data.slice().buffer as ArrayBuffer],
    { type: capture.mediaType },
  ))
  publishPresentation({
    previewUrl,
    capture,
    ...(notice === undefined ? {} : { notice }),
  })
}

export function installAppSnapshotDelivery(
  ctx: ClientContext,
  bridge: DesktopAppSnapshotsBridge,
): () => void {
  const stopCapture = bridge.onCaptured(capture => {
    rememberCapture(capture)
    void attachAppSnapshotCapture(ctx, capture).then(title => {
      rememberCapture(capture, { level: 'info', message: `Added to ${title}.` })
    }).catch(error => {
      rememberCapture(capture, {
        level: 'error',
        message: error instanceof Error ? error.message : 'The app snapshot could not be added.',
      })
    })
  })
  const stopError = bridge.onError(notice => {
    publishPresentation({ notice: { level: 'error', message: notice.message } })
    void openOfficialSettings('snapshots').catch(() => undefined)
  })
  return () => {
    stopCapture()
    stopError()
  }
}

export function installAppSnapshotIntegration(
  ctx: ClientContext,
  bridge: DesktopAppSnapshotsBridge,
): void {
  mountAppSnapshotDelivery(ctx, scope => installAppSnapshotDelivery(scope, bridge))
}

const shortcutLabels: Readonly<Record<AppSnapshotSettings['shortcut'], string>> = {
  'CommandOrControl+Shift+2': '⌘ ⇧ 2',
  'CommandOrControl+Shift+A': '⌘ ⇧ A',
  'CommandOrControl+Option+2': '⌘ ⌥ 2',
}

export function AppSnapshotsSection({
  bridge,
  sessions,
  t,
}: {
  bridge?: DesktopAppSnapshotsBridge
  sessions: SnapshotSource<SessionListState>
  t: DesktopTranslate
}): React.JSX.Element {
  const sessionState = useSnapshot(sessions)
  const snapshotPresentation = useSnapshot(PRESENTATION_SOURCE)
  const [state, setState] = useState<AppSnapshotState>()
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string>()

  useEffect(() => {
    if (bridge === undefined) return
    let active = true
    const stop = bridge.onChanged(next => {
      if (active) setState(next)
    })
    void bridge.getState().then(next => {
      if (active) setState(next)
    }).catch(error => {
      if (active) setLocalError(error instanceof Error ? error.message : t('App Snapshots are unavailable.'))
    })
    return () => {
      active = false
      stop()
    }
  }, [bridge])

  const update = (input: UpdateAppSnapshotSettingsInput): void => {
    if (bridge === undefined) return
    setBusy(true)
    setLocalError(undefined)
    void bridge.update(input).then(setState).catch(error => {
      setLocalError(error instanceof Error ? error.message : t('The App Snapshot setting could not be saved.'))
    }).finally(() => setBusy(false))
  }

  const settings = state?.settings
  const destinationValue = settings?.destination.kind === 'session'
    ? `session:${settings.destination.sessionId}`
    : 'automatic'
  const permissionDenied = state !== undefined && state.permissions.screenRecording !== 'granted'

  return (
    <SettingsPage title={t('App Snapshots')}>
      <SettingsGroup>
        <SettingsRow
          icon={<IconFullscreenOutline16 />}
          title={t('Capture the frontmost app')}
          description={t('Add a visual snapshot and extracted on-screen text to a conversation draft.')}
        />
      </SettingsGroup>

      <div className="dsh-desktop-settings-grid">
        <SettingsGroup>
          <SettingsRow
            title={t('Shortcut')}
            description={state?.shortcutRegistered === false ? t('Shortcut unavailable') : undefined}
            control={settings === undefined ? undefined : (
              <SettingsSelect
                label={t('Shortcut')}
                value={settings.shortcut}
                disabled={busy}
                onChange={value => update({ shortcut: value as AppSnapshotSettings['shortcut'] })}
              >
                {Object.entries(shortcutLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title={t('Snapshot destination')}
            description={t('Automatic uses the current conversation')}
            control={settings === undefined ? undefined : (
              <SettingsSelect
                label={t('Snapshot destination')}
                value={destinationValue}
                disabled={busy}
                onChange={value => update({
                  destination: value === 'automatic'
                    ? { kind: 'automatic' }
                    : { kind: 'session', sessionId: value.slice('session:'.length) },
                })}
              >
                <option value="automatic">{t('Automatic')}</option>
                {sessionState.ids.map(id => (
                  <option key={id} value={`session:${id}`}>{sessionState.byId[id]?.displayTitle ?? id}</option>
                ))}
              </SettingsSelect>
            )}
          />
          <SettingsRow
            title={t('Play sound')}
            control={settings === undefined ? undefined : (
              <SettingsToggle
                label={t('Play App Snapshot capture sound')}
                checked={settings.captureSound}
                disabled={busy}
                onChange={captureSound => update({ captureSound })}
              />
            )}
          />
        </SettingsGroup>

        <div className="dsh-desktop-settings-preview" aria-label={t('Latest App Snapshot preview')}>
          {snapshotPresentation.previewUrl === undefined
            ? <span className="dsh-desktop-settings-preview-empty">{t('Your latest app snapshot appears here')}</span>
            : <img src={snapshotPresentation.previewUrl} alt={t('Latest captured application')} />}
          {snapshotPresentation.capture !== undefined && (
            <span className="dsh-desktop-settings-preview-caption">
              {snapshotPresentation.capture.sourceName} · {snapshotPresentation.capture.pixelWidth} × {snapshotPresentation.capture.pixelHeight}
            </span>
          )}
        </div>
      </div>

      {permissionDenied && (
        <SettingsSection title={t('Permission')}>
          <SettingsGroup>
            <SettingsRow
              title={t('Screen Recording')}
              description={t('Allow DSH Desktop to capture the frontmost application window.')}
              control={(
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconRefreshOutline16 />}
                  onClick={() => {
                    void bridge?.openScreenRecordingSettings().then(() => bridge.refresh()).then(setState)
                  }}
                >
                  {t('Open Settings')}
                </Button>
              )}
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {(localError ?? state?.statusMessage) !== undefined && (
        <SettingsNotice level="error">{localError ?? state?.statusMessage}</SettingsNotice>
      )}
      {snapshotPresentation.notice !== undefined && (
        <SettingsNotice level={snapshotPresentation.notice.level}>{snapshotPresentation.notice.message}</SettingsNotice>
      )}
    </SettingsPage>
  )
}
