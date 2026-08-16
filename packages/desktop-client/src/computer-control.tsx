import { useEffect, useMemo, useState } from 'react'

import {
  Button,
  IconBrowseOutline16,
  IconRightUpOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  BrowserState,
  ComputerApplicationAccess,
  ComputerControlSnapshot,
  ComputerPermissionStatus,
  UpdateComputerControlPolicyInput,
} from '@dolphinminer/dsh-desktop-protocol'

import type { DesktopBrowserBridge } from './browser.js'

import {
  SettingsGroup,
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from './settings-ui.js'
import type { DesktopTranslate } from './locales.js'
import { computerPermissionLabel } from './view-model.js'

export interface DesktopComputerBridge {
  getState(): Promise<ComputerControlSnapshot>
  refresh(): Promise<ComputerControlSnapshot>
  updatePolicy(input: UpdateComputerControlPolicyInput): Promise<ComputerControlSnapshot>
  pauseActions(): Promise<ComputerControlSnapshot>
  resumeActions(): Promise<ComputerControlSnapshot>
  stop(): Promise<ComputerControlSnapshot>
  openPermissionSettings(kind: 'screen-recording' | 'accessibility'): Promise<void>
  onChanged(listener: (snapshot: ComputerControlSnapshot) => void): () => void
}

const styles = `
.dsh-desktop-computer-app-icon {
  align-items: center;
  color: var(--dsw-alias-label-secondary, #45484d);
  display: flex;
  font-size: 13px;
  font-weight: 600;
  height: 100%;
  justify-content: center;
  width: 100%;
}
.dsh-desktop-computer-row-actions {
  align-items: center;
  display: flex;
  gap: 10px;
}
.dsh-desktop-computer-applications {
  max-height: min(560px, 65vh);
  min-width: 0;
  overflow: auto;
  width: 100%;
}
.dsh-desktop-computer-applications-modal {
  max-width: 680px;
  width: min(680px, 82vw);
}
`

function AppIcon({ application }: { application: ComputerApplicationAccess }): React.JSX.Element {
  return (
    <span className="dsh-desktop-computer-app-icon">
      {application.name.trim().slice(0, 1).toLocaleUpperCase() || 'A'}
    </span>
  )
}

function permissionNeedsAttention(status: ComputerPermissionStatus): boolean {
  return status !== 'granted' && status !== 'unavailable'
}

function managedBrowserDescription(state: BrowserState | undefined, t: DesktopTranslate): string {
  if (state === undefined) return t('Managed browser loading')
  if (!state.settings.enabled) return t('Managed browser off')
  if (state.runtimeStatus === 'ready') return t('Managed browser ready')
  if (state.runtimeStatus === 'starting') return t('Managed browser starting')
  if (state.runtimeStatus === 'error') return t('Managed browser needs attention')
  return t('Managed browser stopped')
}

function permissionDescription(status: ComputerPermissionStatus, t: DesktopTranslate): string {
  return t(computerPermissionLabel(status))
}

export function ComputerControlSection({
  bridge,
  browser,
  openBrowserSettings,
  t,
}: {
  bridge?: DesktopComputerBridge
  browser?: DesktopBrowserBridge
  openBrowserSettings?: () => Promise<void>
  t: DesktopTranslate
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ComputerControlSnapshot>()
  const [browserState, setBrowserState] = useState<BrowserState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [applicationsOpen, setApplicationsOpen] = useState(false)

  const run = (operation: () => Promise<ComputerControlSnapshot>): void => {
    setBusy(true)
    setError(undefined)
    void operation().then(setSnapshot).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Computer Control could not be updated.'))
    }).finally(() => setBusy(false))
  }

  useEffect(() => {
    if (bridge === undefined) {
      setError(t('Computer Control is unavailable in this desktop build.'))
      return
    }
    let active = true
    const stop = bridge.onChanged(next => {
      if (active) setSnapshot(next)
    })
    const refresh = (): void => {
      void bridge.refresh().then(next => {
        if (active) setSnapshot(next)
      }).catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : t('Computer Control is unavailable.'))
      })
    }
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      stop()
    }
  }, [bridge, t])

  useEffect(() => {
    if (browser === undefined) return
    let active = true
    const stop = browser.onChanged(next => {
      if (active) setBrowserState(next)
    })
    void browser.getState().then(next => {
      if (active) setBrowserState(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : t('Browser status is unavailable.'))
    })
    return () => {
      active = false
      stop()
    }
  }, [browser, t])

  const configuredRunning = useMemo(
    () => snapshot?.applications.filter(application => application.running && application.policy !== 'default') ?? [],
    [snapshot],
  )
  const manageableApplications = useMemo(
    () => snapshot?.applications.filter(application => application.running || application.policy !== 'default') ?? [],
    [snapshot],
  )
  const offlineAllowed = useMemo(
    () => snapshot?.applications.filter(application => !application.running && application.allowed) ?? [],
    [snapshot],
  )
  const permissions = snapshot?.permissions
  const showPermissions = permissions !== undefined && (
    permissionNeedsAttention(permissions.screenRecording) ||
    permissionNeedsAttention(permissions.accessibility)
  )

  const updatePolicy = (input: UpdateComputerControlPolicyInput): void => {
    if (bridge === undefined) return
    run(() => bridge.updatePolicy(input))
  }

  const updateApplication = (application: ComputerApplicationAccess, allowed: boolean): void => {
    if (application.bundleId === undefined) return
    updatePolicy({
      application: { bundleId: application.bundleId, name: application.name, allowed },
    })
  }

  const openPermission = (kind: 'screen-recording' | 'accessibility'): void => {
    if (bridge === undefined) return
    void bridge.openPermissionSettings(kind).then(() => bridge.refresh()).then(setSnapshot).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('System Settings could not be opened.'))
    })
  }

  const updateBrowser = (enabled: boolean): void => {
    if (browser === undefined) return
    setBusy(true)
    setError(undefined)
    void browser.update({ enabled }).then(setBrowserState).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browser could not be updated.'))
    }).finally(() => setBusy(false))
  }

  const manageBrowser = (): void => {
    if (openBrowserSettings === undefined) return
    setError(undefined)
    void openBrowserSettings().catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Browser settings could not be opened.'))
    })
  }

  return (
    <SettingsPage
      title={t('Computer Control')}
      subtitle={t('Manage how DSH can use other applications on your Mac.')}
    >
      <style>{styles}</style>
      {showPermissions && bridge !== undefined && (
        <>
          <SettingsNotice level="error">
            {t('macOS is blocking Computer Control. App switches below only configure DSH policy and cannot grant system access.')}
          </SettingsNotice>
          <SettingsSection title={t('macOS permissions')}>
            <SettingsGroup>
              {permissionNeedsAttention(permissions.screenRecording) && (
                <SettingsRow
                  title={t('Screen Recording')}
                  description={t('Required to see application windows. Status: {status}', {
                    status: permissionDescription(permissions.screenRecording, t),
                  })}
                  control={(
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRightUpOutline16 />}
                      onClick={() => openPermission('screen-recording')}
                    >
                      {t('Open System Settings')}
                    </Button>
                  )}
                />
              )}
              {permissionNeedsAttention(permissions.accessibility) && (
                <SettingsRow
                  title={t('Accessibility')}
                  description={t('Required to click, type, and read interface elements. Status: {status}', {
                    status: permissionDescription(permissions.accessibility, t),
                  })}
                  control={(
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRightUpOutline16 />}
                      onClick={() => openPermission('accessibility')}
                    >
                      {t('Open System Settings')}
                    </Button>
                  )}
                />
              )}
            </SettingsGroup>
          </SettingsSection>
        </>
      )}
      <SettingsSection
        title={t('Control')}
        action={(
          <Button
            size="sm"
            variant="outline"
            disabled={busy || snapshot === undefined}
            onClick={() => setApplicationsOpen(true)}
          >
            {t('Manage Apps')}
          </Button>
        )}
      >
        <SettingsGroup>
          <SettingsRow
            title={t('Any application')}
            description={t('Allow DSH to control applications unless you turn one off below')}
            control={snapshot === undefined ? undefined : (
              <SettingsToggle
                label={t('Allow any application')}
                checked={snapshot.policy.allowAnyApplication}
                disabled={busy}
                onChange={allowAnyApplication => updatePolicy({ allowAnyApplication })}
              />
            )}
          />
          <SettingsRow
            icon={<span className="dsh-desktop-computer-app-icon"><IconBrowseOutline16 /></span>}
            title={t('DSH Browser')}
            description={managedBrowserDescription(browserState, t)}
            control={(
              <span className="dsh-desktop-computer-row-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || openBrowserSettings === undefined}
                  onClick={manageBrowser}
                >
                  {t('Manage')}
                </Button>
                {browserState !== undefined && (
                  <SettingsToggle
                    label={t('Enable managed browser')}
                    checked={browserState.settings.enabled}
                    disabled={busy}
                    onChange={updateBrowser}
                  />
                )}
              </span>
            )}
          />
          {configuredRunning.map(application => (
            <SettingsRow
              key={application.id}
              icon={<AppIcon application={application} />}
              title={application.name}
              description={application.frontmost
                ? t('Frontmost application')
                : application.canSetPolicy ? t('Running') : t('Running · stable app identity unavailable')}
              control={(
                <SettingsToggle
                  label={t('Allow {name}', { name: application.name })}
                  checked={application.allowed}
                  disabled={busy || !application.canSetPolicy}
                  onChange={allowed => updateApplication(application, allowed)}
                />
              )}
            />
          ))}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection>
        <SettingsGroup>
          <SettingsRow
            title={t('Lock Screen Operations')}
            description={t('Allow control while this Mac is locked')}
            control={snapshot === undefined ? undefined : (
              <SettingsToggle
                label={t('Allow lock screen operations')}
                checked={snapshot.policy.lockScreenOperations}
                disabled={busy}
                onChange={lockScreenOperations => updatePolicy({ lockScreenOperations })}
              />
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('Always allowed applications')}>
        <SettingsGroup>
          {offlineAllowed.length === 0 ? (
            <SettingsRow title={t('None')} />
          ) : offlineAllowed.map(application => (
            <SettingsRow
              key={application.id}
              icon={<AppIcon application={application} />}
              title={application.name}
              description={t('Not currently running')}
              control={(
                <SettingsToggle
                  label={t('Allow {name}', { name: application.name })}
                  checked
                  disabled={busy}
                  onChange={allowed => updateApplication(application, allowed)}
                />
              )}
            />
          ))}
        </SettingsGroup>
      </SettingsSection>

      {error !== undefined && <SettingsNotice level="error">{error}</SettingsNotice>}
      {error === undefined && snapshot?.statusMessage !== undefined && (
        <SettingsNotice level="info">{snapshot.statusMessage}</SettingsNotice>
      )}

      <Modal
        open={applicationsOpen}
        onClose={() => setApplicationsOpen(false)}
        title={t('Applications')}
        description={t('Choose which running applications DSH can control.')}
        closeLabel={t('Close application management')}
        className="dsh-desktop-computer-applications-modal"
      >
        <div className="dsh-desktop-computer-applications">
          <SettingsGroup>
            {manageableApplications.length === 0 ? (
              <SettingsRow title={t('No applications available')} />
            ) : manageableApplications.map(application => (
              <SettingsRow
                key={application.id}
                icon={<AppIcon application={application} />}
                title={application.name}
                description={application.frontmost
                  ? t('Frontmost application')
                  : application.running ? t('Running') : t('Not currently running')}
                control={(
                  <SettingsToggle
                    label={t('Allow {name}', { name: application.name })}
                    checked={application.allowed}
                    disabled={busy || !application.canSetPolicy}
                    onChange={allowed => updateApplication(application, allowed)}
                  />
                )}
              />
            ))}
          </SettingsGroup>
        </div>
      </Modal>

    </SettingsPage>
  )
}
