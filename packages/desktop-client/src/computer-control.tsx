import { useEffect, useMemo, useState } from 'react'

import {
  Button,
  IconBrowseOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
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
import { computerActionStatusLabel, computerPermissionLabel } from './view-model.js'

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
.dsh-desktop-computer-advanced {
  display: grid;
  gap: 14px;
  min-width: min(520px, 78vw);
}
.dsh-desktop-computer-advanced-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-desktop-computer-history {
  border-top: 1px solid var(--dsw-alias-border-l1, #ecece8);
  display: grid;
  max-height: 280px;
  overflow: auto;
}
.dsh-desktop-computer-history-row {
  align-items: center;
  display: flex;
  font-size: 12px;
  gap: 14px;
  justify-content: space-between;
  min-height: 42px;
  padding: 7px 2px;
}
.dsh-desktop-computer-history-row + .dsh-desktop-computer-history-row {
  border-top: 1px solid var(--dsw-alias-border-l1, #ecece8);
}
.dsh-desktop-computer-history-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.dsh-desktop-computer-history-meta {
  color: var(--dsw-alias-label-tertiary, #74777d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

function managedBrowserDescription(state: BrowserState | undefined): string {
  if (state === undefined) return 'Managed browser loading'
  if (!state.settings.enabled) return 'Managed browser off'
  if (state.runtimeStatus === 'ready') return 'Managed browser ready'
  if (state.runtimeStatus === 'starting') return 'Managed browser starting'
  if (state.runtimeStatus === 'error') return 'Managed browser needs attention'
  return 'Managed browser stopped'
}

export function ComputerControlSection({
  bridge,
  browser,
  openBrowserSettings,
}: {
  bridge?: DesktopComputerBridge
  browser?: DesktopBrowserBridge
  openBrowserSettings?: () => Promise<void>
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ComputerControlSnapshot>()
  const [browserState, setBrowserState] = useState<BrowserState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [applicationsOpen, setApplicationsOpen] = useState(false)

  const run = (operation: () => Promise<ComputerControlSnapshot>): void => {
    setBusy(true)
    setError(undefined)
    void operation().then(setSnapshot).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Computer Control could not be updated.')
    }).finally(() => setBusy(false))
  }

  useEffect(() => {
    if (bridge === undefined) {
      setError('Computer Control is unavailable in this desktop build.')
      return
    }
    let active = true
    const stop = bridge.onChanged(next => {
      if (active) setSnapshot(next)
    })
    void bridge.refresh().then(next => {
      if (active) setSnapshot(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Computer Control is unavailable.')
    })
    return () => {
      active = false
      stop()
    }
  }, [bridge])

  useEffect(() => {
    if (browser === undefined) return
    let active = true
    const stop = browser.onChanged(next => {
      if (active) setBrowserState(next)
    })
    void browser.getState().then(next => {
      if (active) setBrowserState(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Browser status is unavailable.')
    })
    return () => {
      active = false
      stop()
    }
  }, [browser])

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
      setError(cause instanceof Error ? cause.message : 'System Settings could not be opened.')
    })
  }

  const updateBrowser = (enabled: boolean): void => {
    if (browser === undefined) return
    setBusy(true)
    setError(undefined)
    void browser.update({ enabled }).then(setBrowserState).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Browser could not be updated.')
    }).finally(() => setBusy(false))
  }

  const manageBrowser = (): void => {
    if (openBrowserSettings === undefined) return
    setError(undefined)
    void openBrowserSettings().catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Browser settings could not be opened.')
    })
  }

  return (
    <SettingsPage
      title="Computer Control"
      subtitle="Manage how DSH can use other applications on your Mac."
    >
      <style>{styles}</style>
      <SettingsSection
        title="Control"
        action={(
          <Button
            size="sm"
            variant="outline"
            disabled={busy || snapshot === undefined}
            onClick={() => setApplicationsOpen(true)}
          >
            Manage Apps
          </Button>
        )}
      >
        <SettingsGroup>
          <SettingsRow
            title="Any application"
            description="Allow DSH to control applications unless you turn one off below"
            control={snapshot === undefined ? undefined : (
              <SettingsToggle
                label="Allow any application"
                checked={snapshot.policy.allowAnyApplication}
                disabled={busy}
                onChange={allowAnyApplication => updatePolicy({ allowAnyApplication })}
              />
            )}
          />
          <SettingsRow
            icon={<span className="dsh-desktop-computer-app-icon"><IconBrowseOutline16 /></span>}
            title="DSH Browser"
            description={managedBrowserDescription(browserState)}
            control={(
              <span className="dsh-desktop-computer-row-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || openBrowserSettings === undefined}
                  onClick={manageBrowser}
                >
                  Manage
                </Button>
                {browserState !== undefined && (
                  <SettingsToggle
                    label="Enable managed browser"
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
                ? 'Frontmost application'
                : application.canSetPolicy ? 'Running' : 'Running · stable app identity unavailable'}
              control={(
                <SettingsToggle
                  label={`Allow ${application.name}`}
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
            title="Lock Screen Operations"
            description="Allow control while this Mac is locked"
            control={snapshot === undefined ? undefined : (
              <SettingsToggle
                label="Allow lock screen operations"
                checked={snapshot.policy.lockScreenOperations}
                disabled={busy}
                onChange={lockScreenOperations => updatePolicy({ lockScreenOperations })}
              />
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Always allowed applications">
        <SettingsGroup>
          {offlineAllowed.length === 0 ? (
            <SettingsRow title="None" />
          ) : offlineAllowed.map(application => (
            <SettingsRow
              key={application.id}
              icon={<AppIcon application={application} />}
              title={application.name}
              description="Not currently running"
              control={(
                <SettingsToggle
                  label={`Allow ${application.name}`}
                  checked
                  disabled={busy}
                  onChange={allowed => updateApplication(application, allowed)}
                />
              )}
            />
          ))}
        </SettingsGroup>
      </SettingsSection>

      {showPermissions && bridge !== undefined && (
        <SettingsSection title="Permissions">
          <SettingsGroup>
            <SettingsRow
              title="Screen Recording"
              description={computerPermissionLabel(permissions.screenRecording)}
              control={permissionNeedsAttention(permissions.screenRecording) ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconRightUpOutline16 />}
                  onClick={() => openPermission('screen-recording')}
                >
                  Open Settings
                </Button>
              ) : undefined}
            />
            <SettingsRow
              title="Accessibility"
              description={computerPermissionLabel(permissions.accessibility)}
              control={permissionNeedsAttention(permissions.accessibility) ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconRightUpOutline16 />}
                  onClick={() => openPermission('accessibility')}
                >
                  Open Settings
                </Button>
              ) : undefined}
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection title="Advanced">
        <SettingsGroup>
          <SettingsRow
            title="Activity and emergency stop"
            description={snapshot?.actionsPaused === true ? 'Computer actions are paused' : 'Computer actions are available'}
            control={(
              <Button size="sm" variant="outline" onClick={() => setAdvancedOpen(true)}>
                Manage
              </Button>
            )}
          />
        </SettingsGroup>
      </SettingsSection>

      {error !== undefined && <SettingsNotice level="error">{error}</SettingsNotice>}
      {error === undefined && snapshot?.statusMessage !== undefined && (
        <SettingsNotice level="info">{snapshot.statusMessage}</SettingsNotice>
      )}

      <Modal
        open={applicationsOpen}
        onClose={() => setApplicationsOpen(false)}
        title="Applications"
        description="Choose which running applications DSH can control."
        closeLabel="Close application management"
        className="dsh-desktop-computer-applications-modal"
      >
        <div className="dsh-desktop-computer-applications">
          <SettingsGroup>
            {manageableApplications.length === 0 ? (
              <SettingsRow title="No applications available" />
            ) : manageableApplications.map(application => (
              <SettingsRow
                key={application.id}
                icon={<AppIcon application={application} />}
                title={application.name}
                description={application.frontmost
                  ? 'Frontmost application'
                  : application.running ? 'Running' : 'Not currently running'}
                control={(
                  <SettingsToggle
                    label={`Allow ${application.name}`}
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

      <Modal
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        title="Computer Control"
        closeLabel="Close advanced Computer Control"
      >
        <div className="dsh-desktop-computer-advanced">
          <div className="dsh-desktop-computer-advanced-actions">
            {snapshot?.actionsPaused === true ? (
              <Button
                size="sm"
                variant="outline"
                icon={<IconPlayOutline16 />}
                disabled={busy || bridge === undefined}
                onClick={() => { if (bridge !== undefined) run(() => bridge.resumeActions()) }}
              >
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                icon={<IconPauseOutline16 />}
                disabled={busy || bridge === undefined}
                onClick={() => { if (bridge !== undefined) run(() => bridge.pauseActions()) }}
              >
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              icon={<IconRefreshOutline16 />}
              disabled={busy || bridge === undefined}
              onClick={() => { if (bridge !== undefined) run(() => bridge.refresh()) }}
            >
              Refresh applications
            </Button>
          </div>
          <div className="dsh-desktop-computer-history" aria-label="Recent computer actions">
            {snapshot?.recentActions.length === 0 && (
              <div className="dsh-desktop-computer-history-row">No recent actions</div>
            )}
            {snapshot?.recentActions.map(action => (
              <div className="dsh-desktop-computer-history-row" key={action.actionId}>
                <span className="dsh-desktop-computer-history-copy">
                  <span>{action.kind} · {action.targetName}</span>
                  <span className="dsh-desktop-computer-history-meta">
                    {new Date(action.updatedAt).toLocaleString()}
                  </span>
                </span>
                <span>{computerActionStatusLabel(action.status)}</span>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </SettingsPage>
  )
}
