import type { CSSProperties, FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconApiOutline14,
  IconBranchOutline16,
  IconBrowseOutline16,
  IconCheckOutline16,
  IconCloseOutline16,
  IconCordisPluginOutline14,
  IconDownloadOutline16,
  IconLinkOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectApiKeyInput,
  ConnectionAccess,
  ConnectionSnapshot,
  ConnectionSummary,
  DesktopPluginInstallResult,
  DesktopPluginPolicySnapshot,
  DisconnectConnectionInput,
  DesktopRendererCommand,
  DesktopWorktreeCleanupConfirmInput,
  DesktopWorktreeCleanupPreviewInput,
  DesktopWorktreeRecoveryConfirmInput,
  DesktopWorktreeRecoveryPreviewInput,
  DesktopWorktreeHandoffConfirmInput,
  DesktopWorktreeHandoffPreflightInput,
  InstallDesktopPluginInput,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
  WorktreeRecoveryPreview,
  WorktreeRecoveryResult,
  WorktreeHandoffBlocker,
  WorktreeHandoffDirection,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
  WorktreeSnapshot,
  WorktreeSummary,
  UpdateDesktopPluginPolicyInput,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  canReconnect,
  connectionStateDot,
  linearConnectionAction,
} from './view-model.js'
import { AutomationTaskCenter, type DesktopAutomationsBridge } from './automations.js'
import {
  AppSnapshotsSection,
  type DesktopAppSnapshotsBridge,
  installAppSnapshotIntegration,
} from './app-snapshots.js'
import { runDesktopCommand } from './desktop-command.js'
import { ComputerControlSection, type DesktopComputerBridge } from './computer-control.js'
import {
  BrowserSettingsSection,
  type DesktopBrowserBridge,
} from './browser.js'
import {
  BrowserPanel,
  BrowserPanelToggle,
  type BrowserPanelDetailsSlotProps,
  type BrowserPanelToggleSlotProps,
} from './browser-panel.js'
import { BrowserPanelController } from './browser-panel-controller.js'
import { DesktopTitlebar } from './desktop-shell.js'
import { GitReviewView, type DesktopGitBridge } from './git-review.js'
import { openOfficialSettings } from './settings-navigation.js'
import { SettingsStyles, SettingsToggle } from './settings-ui.js'
import {
  DESKTOP_LOCALE_NAMESPACE,
  en as desktopEn,
  zh as desktopZh,
  type DesktopTranslate,
} from './locales.js'

interface OAuthResultNotice {
  ok: boolean
  message: string
}

interface DesktopConnectionsBridge {
  list(): Promise<ConnectionSnapshot>
  connectApiKey(input: ConnectApiKeyInput): Promise<ConnectionSnapshot>
  disconnect(input: DisconnectConnectionInput): Promise<ConnectionSnapshot>
  beginOAuth(input: BeginOAuthInput): Promise<BeginOAuthResult>
  cancelOAuth(input: CancelOAuthInput): Promise<void>
  onChanged(listener: (snapshot: ConnectionSnapshot) => void): () => void
  onOAuthResult(listener: (result: OAuthResultNotice) => void): () => void
}

interface DesktopPluginPolicyBridge {
  getState(): Promise<DesktopPluginPolicySnapshot>
  update(input: UpdateDesktopPluginPolicyInput): Promise<DesktopPluginPolicySnapshot>
  installRegistry(input: InstallDesktopPluginInput): Promise<DesktopPluginInstallResult>
  installDirectory(): Promise<DesktopPluginInstallResult | undefined>
  onChanged(listener: (snapshot: DesktopPluginPolicySnapshot) => void): () => void
}

interface DesktopWorktreesBridge {
  list(): Promise<WorktreeSnapshot>
  reconcile(): Promise<WorktreeSnapshot>
  previewCleanup(input: DesktopWorktreeCleanupPreviewInput): Promise<WorktreeCleanupPreview>
  confirmCleanup(input: DesktopWorktreeCleanupConfirmInput): Promise<WorktreeCleanupResult>
  previewRecovery(input: DesktopWorktreeRecoveryPreviewInput): Promise<WorktreeRecoveryPreview>
  confirmRecovery(input: DesktopWorktreeRecoveryConfirmInput): Promise<WorktreeRecoveryResult>
  previewHandoff(input: DesktopWorktreeHandoffPreflightInput): Promise<WorktreeHandoffPreview>
  confirmHandoff(input: DesktopWorktreeHandoffConfirmInput): Promise<WorktreeHandoffResult>
  onChanged(listener: (snapshot: WorktreeSnapshot) => void): () => void
}

declare global {
  interface Window {
    dshDesktop?: {
      onCommand(listener: (command: DesktopRendererCommand) => void): () => void
      pickProjectDirectory(): Promise<string | null>
      plugins: DesktopPluginPolicyBridge
      appSnapshots: DesktopAppSnapshotsBridge
      browser: DesktopBrowserBridge
      git: DesktopGitBridge
      automations: DesktopAutomationsBridge
      worktrees: DesktopWorktreesBridge
      computer: DesktopComputerBridge
      connections: DesktopConnectionsBridge
    }
  }
}

const styles: Record<string, CSSProperties> = {
  root: {
    boxSizing: 'border-box',
    color: 'var(--dsw-alias-label-primary, #17191c)',
    letterSpacing: 0,
    margin: '0 auto',
    maxWidth: 760,
    padding: '8px 4px 40px',
    width: '100%',
  },
  header: {
    alignItems: 'center',
    display: 'flex',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  heading: { fontSize: 20, fontWeight: 650, lineHeight: '28px', margin: 0 },
  toolbar: { alignItems: 'center', display: 'flex', gap: 8 },
  form: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 6,
    boxSizing: 'border-box',
    display: 'grid',
    gap: 16,
    marginBottom: 24,
    padding: 18,
    width: '100%',
  },
  formHeader: { alignItems: 'center', display: 'flex', justifyContent: 'space-between' },
  formTitle: { fontSize: 15, fontWeight: 650, lineHeight: '22px', margin: 0 },
  field: { display: 'grid', gap: 7, minWidth: 0 },
  label: { color: 'var(--dsw-alias-label-secondary, #5f6268)', fontSize: 12, fontWeight: 600 },
  access: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  formActions: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 },
  notice: {
    borderRadius: 4,
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 13,
    lineHeight: '20px',
    marginBottom: 16,
    overflowWrap: 'anywhere',
    padding: '10px 12px',
  },
  empty: {
    borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)',
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 13,
    padding: '28px 4px',
  },
  list: { display: 'grid', gap: 10 },
  item: {
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 6,
    boxSizing: 'border-box',
    display: 'grid',
    gap: 12,
    minWidth: 0,
    padding: 16,
    width: '100%',
  },
  itemTop: { alignItems: 'flex-start', display: 'flex', gap: 12, justifyContent: 'space-between' },
  identity: { display: 'grid', gap: 3, minWidth: 0 },
  itemTitle: { fontSize: 14, fontWeight: 650, lineHeight: '20px', overflowWrap: 'anywhere' },
  metadata: {
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 12,
    lineHeight: '18px',
    overflowWrap: 'anywhere',
  },
  status: { alignItems: 'center', display: 'flex', flexShrink: 0, gap: 7, fontSize: 12 },
  pills: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 6 },
  itemBottom: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  statusMessage: {
    color: 'var(--dsw-alias-label-error, #b42318)',
    fontSize: 12,
    lineHeight: '18px',
    margin: 0,
    overflowWrap: 'anywhere',
  },
  confirm: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 },
  worktreeDetails: {
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'minmax(0, 1fr)',
  },
  worktreeDetail: { display: 'grid', gap: 2, minWidth: 0 },
  worktreeConfirmBody: { display: 'grid', gap: 16 },
  worktreeConfirmDetails: {
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'grid',
    gap: 10,
    paddingBottom: 16,
  },
  worktreeAcknowledge: {
    alignItems: 'flex-start',
    cursor: 'pointer',
    display: 'flex',
    fontSize: 13,
    gap: 9,
    lineHeight: '20px',
  },
  worktreeActions: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 },
  handoffScroll: {
    display: 'grid',
    gap: 14,
    maxHeight: 'min(460px, 58vh)',
    overflowY: 'auto',
    paddingRight: 4,
  },
  handoffPath: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    borderRadius: 4,
    display: 'grid',
    gap: 3,
    minWidth: 0,
    padding: '9px 10px',
  },
  handoffFiles: {
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    display: 'grid',
    maxHeight: 180,
    overflowY: 'auto',
  },
  handoffFile: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'grid',
    fontSize: 12,
    gap: 10,
    gridTemplateColumns: '96px minmax(0, 1fr)',
    minHeight: 34,
    padding: '5px 9px',
  },
  handoffPatch: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    boxSizing: 'border-box',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    lineHeight: '17px',
    margin: '8px 0 0',
    maxHeight: 220,
    overflow: 'auto',
    padding: 10,
    whiteSpace: 'pre',
    width: '100%',
  },
}

interface PendingOAuth {
  requestId: string
  flowId: string
  expiresAt: string
}

function errorMessage(error: unknown, fallback = 'The desktop operation failed.'): string {
  if (!(error instanceof Error)) return fallback
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim()
}

function connectionMeta(connection: ConnectionSummary): string {
  return [connection.workspace, connection.account].filter(Boolean).join(' / ') || 'Linear'
}

function localizedConnectionStatus(
  status: ConnectionSummary['status'],
  t: DesktopTranslate,
): string {
  if (status === 'connected') return t('Connected')
  if (status === 'connecting') return t('Connecting')
  if (status === 'expired') return t('Authorization expired')
  if (status === 'error') return t('Connection error')
  return t('Disconnected')
}

function ConnectionsSection({
  bridge,
  t,
}: {
  bridge?: DesktopConnectionsBridge
  t: DesktopTranslate
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<OAuthResultNotice>()
  const [showForm, setShowForm] = useState(false)
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [access, setAccess] = useState<ConnectionAccess>('read-only')
  const [connectionId, setConnectionId] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [pendingOAuth, setPendingOAuth] = useState<PendingOAuth>()
  const [confirmDisconnect, setConfirmDisconnect] = useState<string>()

  const connections = snapshot?.connections ?? []
  const oauthAvailable = snapshot?.oauth.linear.available ?? false
  const vaultAvailable = snapshot?.vault.available ?? false

  const refresh = async (): Promise<void> => {
    if (bridge === undefined) {
      setError(t('The desktop connection bridge is unavailable.'))
      setLoading(false)
      return
    }
    try {
      setSnapshot(await bridge.list())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    if (bridge === undefined) return
    const offChanged = bridge.onChanged(next => {
      setSnapshot(next)
      setLoading(false)
    })
    const offOAuth = bridge.onOAuthResult(result => {
      setNotice(result)
      setPendingOAuth(undefined)
      void refresh()
    })
    return () => {
      offChanged()
      offOAuth()
    }
  }, [bridge, t])

  const resetForm = (): void => {
    setShowForm(false)
    setLabel('')
    setApiKey('')
    setAccess('read-only')
    setConnectionId(undefined)
  }

  const submitApiKey = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (bridge === undefined || apiKey.trim().length === 0) return
    const operation = connectionId ?? 'new-api-key'
    setBusy(operation)
    setError(undefined)
    try {
      const next = await bridge.connectApiKey({
        requestId: crypto.randomUUID(),
        provider: 'linear',
        apiKey: apiKey.trim(),
        access,
        ...(label.trim().length === 0 ? {} : { label: label.trim() }),
        ...(connectionId === undefined ? {} : { connectionId }),
      })
      setSnapshot(next)
      resetForm()
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setBusy(undefined)
    }
  }

  const beginOAuth = async (target?: ConnectionSummary): Promise<void> => {
    if (bridge === undefined) return
    const requestId = crypto.randomUUID()
    setBusy(target?.id ?? 'new-oauth')
    setError(undefined)
    try {
      const result = await bridge.beginOAuth({
        requestId,
        provider: 'linear',
        access: target?.access ?? 'read-only',
        ...(target?.label === undefined ? {} : { label: target.label }),
        ...(target === undefined ? {} : { connectionId: target.id }),
      })
      setPendingOAuth({ requestId, flowId: result.flowId, expiresAt: result.expiresAt })
      setNotice({ ok: true, message: t('Waiting for Linear authorization.') })
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setBusy(undefined)
    }
  }

  const cancelOAuth = async (): Promise<void> => {
    if (bridge === undefined || pendingOAuth === undefined) return
    setBusy('oauth-cancel')
    try {
      await bridge.cancelOAuth({
        requestId: pendingOAuth.requestId,
        flowId: pendingOAuth.flowId,
      })
      setPendingOAuth(undefined)
      setNotice(undefined)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setBusy(undefined)
    }
  }

  const connectLinear = (connection?: ConnectionSummary): void => {
    const action = linearConnectionAction(connection?.authKind, oauthAvailable)
    setNotice(undefined)
    setError(undefined)
    if (action === 'oauth-unavailable') {
      resetForm()
      setError(t('Linear browser sign-in is unavailable in this build. Configure OAuth or use Advanced for a self-hosted API key.'))
      return
    }
    if (action === 'oauth') {
      resetForm()
      void beginOAuth(connection)
      return
    }
    if (connection === undefined) return
    setConnectionId(connection.id)
    setLabel(connection.label)
    setAccess(connection.access)
    setApiKey('')
    setShowForm(true)
  }

  const disconnect = async (id: string): Promise<void> => {
    if (bridge === undefined) return
    setBusy(id)
    setError(undefined)
    try {
      setSnapshot(await bridge.disconnect({ requestId: crypto.randomUUID(), connectionId: id }))
      setConfirmDisconnect(undefined)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setBusy(undefined)
    }
  }

  const sorted = useMemo(() => [...connections].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  ), [connections])

  return (
    <section style={{ ...styles.root, paddingTop: 6 }} aria-label={t('Apps')}>
      <header style={styles.header}>
        <span style={{ ...styles.metadata, fontSize: 13 }}>
          {t('Connect services that add tools to the Agent.')}
        </span>
        <div style={styles.toolbar}>
          <Button
            size="sm"
            variant="primary"
            icon={<IconLinkOutline16 />}
            disabled={!vaultAvailable || busy !== undefined}
            onClick={() => connectLinear()}
          >
            {t('Connect Linear')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!vaultAvailable}
            onClick={() => {
              if (showForm) resetForm()
              else {
                setError(undefined)
                setShowForm(true)
              }
            }}
          >
            {t('Advanced')}
          </Button>
        </div>
      </header>

      {showForm && (
        <form style={styles.form} onSubmit={event => void submitApiKey(event)}>
          <div style={styles.formHeader}>
            <h3 style={styles.formTitle}>
              {connectionId === undefined ? t('Advanced Linear connection') : t('Reconnect Linear with API key')}
            </h3>
            <Button
              type="button"
              size="sm"
              variant="toolbar"
              icon={<IconCloseOutline16 />}
              aria-label={t('Close connection form')}
              title={t('Close')}
              onClick={resetForm}
            />
          </div>
          <label style={styles.field}>
            <span style={styles.label}>{t('Connection name')}</span>
            <Input
              value={label}
              maxLength={160}
              placeholder={t('Linear workspace')}
              onChange={event => setLabel(event.currentTarget.value)}
            />
          </label>
          <div style={styles.field}>
            <span style={styles.label}>{t('Access')}</span>
            <div style={styles.access} role="group" aria-label={t('Linear access mode')}>
              <Pill type="button" active={access === 'read-only'} onClick={() => setAccess('read-only')}>
                {t('Read only')}
              </Pill>
              <Pill type="button" active={access === 'read-write'} onClick={() => setAccess('read-write')}>
                {t('Read and write')}
              </Pill>
            </div>
          </div>
          <label style={styles.field}>
            <span style={styles.label}>{t('Linear API key')}</span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder="lin_api_..."
              onChange={event => setApiKey(event.currentTarget.value)}
            />
          </label>
          <div style={styles.formActions}>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              icon={<IconLinkOutline16 />}
              disabled={apiKey.trim().length === 0 || busy !== undefined}
            >
              {t('Connect with API key')}
            </Button>
          </div>
        </form>
      )}

      {notice !== undefined && (
        <div
          role="status"
          style={{
            ...styles.notice,
            background: notice.ok
              ? 'var(--dsw-alias-state-success-secondary, #ecf8ef)'
              : 'var(--dsw-alias-state-error-secondary, #fef0ef)',
          }}
        >
          {notice.message}
          {pendingOAuth !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === 'oauth-cancel'}
              onClick={() => void cancelOAuth()}
            >
              {t('Cancel')}
            </Button>
          )}
        </div>
      )}

      {error !== undefined && (
        <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-error-secondary, #fef0ef)' }}>
          {error}
        </div>
      )}

      {loading && <div style={styles.empty}>{t('Loading connections...')}</div>}
      {!loading && sorted.length === 0 && <div style={styles.empty}>{t('No connections')}</div>}
      <div style={styles.list}>
        {sorted.map(connection => (
          <article key={connection.id} style={styles.item}>
            <div style={styles.itemTop}>
              <div style={styles.identity}>
                <span style={styles.itemTitle}>{connection.label}</span>
                <span style={styles.metadata}>{connectionMeta(connection)}</span>
              </div>
              <span style={styles.status}>
                <StateDot state={connectionStateDot(connection.status)} />
                {localizedConnectionStatus(connection.status, t)}
              </span>
            </div>
            <div style={styles.pills}>
              <Pill>{connection.access === 'read-only' ? t('Read only') : t('Read and write')}</Pill>
              <Pill>{connection.authKind === 'oauth' ? t('OAuth') : t('API key')}</Pill>
              {connection.scopes.map(scope => <Pill key={scope}>{scope}</Pill>)}
              {connection.enabledTools.length > 0 && (
                <Pill>{t('{count} tools', { count: String(connection.enabledTools.length) })}</Pill>
              )}
            </div>
            {connection.statusMessage !== undefined && (
              <p style={styles.statusMessage}>{connection.statusMessage}</p>
            )}
            <div style={styles.itemBottom}>
              <span style={styles.metadata}>
                {connection.lastConnectedAt === undefined
                  ? t('Not connected yet')
                  : t('Last connected {time}', { time: new Date(connection.lastConnectedAt).toLocaleString() })}
              </span>
              {confirmDisconnect === connection.id ? (
                <div style={styles.confirm}>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(undefined)}>{t('Cancel')}</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === connection.id}
                    onClick={() => void disconnect(connection.id)}
                  >
                    {t('Disconnect')}
                  </Button>
                </div>
              ) : (
                <div style={styles.confirm}>
                  {canReconnect(connection.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRefreshOutline16 />}
                      disabled={busy !== undefined}
                      onClick={() => connectLinear(connection)}
                    >
                      {t('Reconnect')}
                    </Button>
                  )}
                  {connection.status !== 'disconnected' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconTrashOutline16 />}
                      disabled={busy !== undefined}
                      onClick={() => setConfirmDisconnect(connection.id)}
                    >
                      {t('Disconnect')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

type PluginCenterTabId = 'plugins' | 'apps' | 'mcp' | 'marketplace'
type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]

const PLUGIN_DIRECTORY_URL = 'https://github.com/topics/dsh-plugin'

const pluginCenterStyles = `
.dsh-plugin-center,
.dsh-plugin-center * {
  box-sizing: border-box;
  letter-spacing: 0;
}
.dsh-plugin-center {
  color: var(--dsw-alias-label-primary, #17191c);
  margin: 0 auto;
  max-width: 760px;
  min-width: 0;
  padding: 8px 4px 40px;
  width: 100%;
}
.dsh-plugin-center__header,
.dsh-plugin-center__toolbar,
.dsh-plugin-center__tabs-row,
.dsh-plugin-center__tabs,
.dsh-plugin-center__row,
.dsh-plugin-center__identity,
.dsh-plugin-center__status {
  align-items: center;
  display: flex;
}
.dsh-plugin-center__header {
  align-items: flex-start;
  gap: 16px;
  justify-content: space-between;
}
.dsh-plugin-center__title {
  font-size: 22px;
  font-weight: 500;
  line-height: 30px;
  margin: 0;
}
.dsh-plugin-center__subtitle,
.dsh-plugin-center__description,
.dsh-plugin-center__empty,
.dsh-plugin-center__status {
  color: var(--dsw-alias-label-tertiary, #74777d);
  font-size: 12px;
  line-height: 18px;
}
.dsh-plugin-center__subtitle {
  font-size: 13px;
  line-height: 20px;
  margin: 3px 0 0;
}
.dsh-plugin-center__toolbar {
  flex: 0 0 auto;
  gap: 8px;
}
.dsh-plugin-center__tabs-row {
  gap: 18px;
  justify-content: space-between;
  margin-top: 28px;
}
.dsh-plugin-center__tabs {
  background: var(--dsw-alias-bg-overlay, #f3f3f0);
  border-radius: 7px;
  gap: 2px;
  padding: 2px;
}
.dsh-plugin-center__tab {
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, #74777d);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  height: 28px;
  padding: 0 10px;
}
.dsh-plugin-center__tab[data-active="true"] {
  background: var(--dsw-alias-bg-module-platform, #fff);
  box-shadow: 0 1px 2px #00000012;
  color: var(--dsw-alias-label-primary, #17191c);
}
.dsh-plugin-center__tab:focus-visible,
.dsh-plugin-center__search input:focus-visible,
.dsh-plugin-center__link:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2f9cf4);
  outline-offset: 2px;
}
.dsh-plugin-center__count {
  color: var(--dsw-alias-label-quaternary, #9a9da2);
  margin-left: 4px;
}
.dsh-plugin-center__search {
  align-items: center;
  border: 1px solid var(--dsw-alias-border-l2, #deded9);
  border-radius: 16px;
  color: var(--dsw-alias-label-tertiary, #74777d);
  display: flex;
  height: 32px;
  padding: 0 10px;
  width: 224px;
}
.dsh-plugin-center__search input {
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  font-size: 12px;
  height: 100%;
  min-width: 0;
  outline: 0;
  padding: 0 0 0 7px;
  width: 100%;
}
.dsh-plugin-center__panel {
  margin-top: 28px;
  min-width: 0;
}
.dsh-plugin-center__panel-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}
.dsh-plugin-center__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.dsh-plugin-center__row {
  gap: 12px;
  min-height: 66px;
  padding: 10px 10px;
}
.dsh-plugin-center__row + .dsh-plugin-center__row {
  border-top: 1px solid var(--dsw-alias-border-l1, #ecece8);
}
.dsh-plugin-center__icon {
  align-items: center;
  background: var(--dsw-alias-bg-overlay, #f3f3f0);
  border: 1px solid var(--dsw-alias-border-l1, #ecece8);
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary, #45484d);
  display: flex;
  flex: 0 0 38px;
  height: 38px;
  justify-content: center;
  width: 38px;
}
.dsh-plugin-center__identity {
  align-items: flex-start;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}
.dsh-plugin-center__name {
  font-size: 13px;
  font-weight: 500;
  line-height: 19px;
  overflow-wrap: anywhere;
}
.dsh-plugin-center__description {
  overflow-wrap: anywhere;
}
.dsh-plugin-center__status {
  flex: 0 0 auto;
  gap: 7px;
}
.dsh-plugin-center__runtime-error {
  color: var(--dsw-alias-label-error, #b42318);
}
.dsh-plugin-center__empty {
  border-top: 1px solid var(--dsw-alias-border-l1, #ecece8);
  padding: 26px 10px;
}
.dsh-plugin-center__notice {
  background: var(--dsw-alias-state-error-secondary, #fef0ef);
  border-radius: 7px;
  color: var(--dsw-alias-label-error, #b42318);
  font-size: 12px;
  line-height: 18px;
  margin-bottom: 12px;
  padding: 8px 10px;
}
.dsh-plugin-center__notice--info {
  background: var(--dsw-alias-bg-overlay, #f3f3f0);
  color: var(--dsw-alias-label-secondary, #45484d);
}
.dsh-plugin-center__marketplace {
  border: 1px solid var(--dsw-alias-border-l2, #deded9);
  border-radius: 8px;
  overflow: hidden;
}
@media (max-width: 720px) {
  .dsh-plugin-center { padding-inline: 0; }
  .dsh-plugin-center__header,
  .dsh-plugin-center__tabs-row { align-items: stretch; flex-direction: column; }
  .dsh-plugin-center__toolbar { justify-content: flex-end; }
  .dsh-plugin-center__tabs { align-self: flex-start; max-width: 100%; overflow-x: auto; }
  .dsh-plugin-center__search { width: 100%; }
}
`

function openPluginDirectory(): void {
  window.open(PLUGIN_DIRECTORY_URL, '_blank', 'noopener,noreferrer')
}

function pluginDisplayName(moduleName: string): string {
  const packageName = moduleName.split('/').at(-1) ?? moduleName
  return packageName
    .replace(/^dsh-(?:skill|plugin)-/, '')
    .split('-')
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function isUserFacingPlugin(entry: PluginInventoryEntry): boolean {
  if (entry.moduleName.includes('/dsh-skill-')) return true
  if (/^(?:cordis|node|file):/.test(entry.moduleName) || entry.moduleName.startsWith('.')) return false
  return !entry.moduleName.startsWith('@deepseek-ai/') &&
    !entry.moduleName.startsWith('@dolphinminer/')
}

function pluginRuntimeLabel(
  entry: PluginInventoryEntry,
  desiredEnabled: boolean,
  t: DesktopTranslate,
): string {
  if (desiredEnabled !== entry.enabled) return desiredEnabled ? t('Unavailable') : t('Still running')
  if (!entry.enabled) return t('Disabled')
  if (entry.fiberPhase === 'active') return t('Installed')
  if (entry.fiberPhase === 'failed') return t('Unavailable')
  return t('Starting')
}

function PluginCatalogTab({
  entries,
  loading,
  failure,
  query,
  policy,
  pending,
  onToggle,
  t,
}: {
  entries: readonly PluginInventoryEntry[]
  loading: boolean
  failure?: string
  query: string
  policy?: DesktopPluginPolicySnapshot
  pending: ReadonlySet<string>
  onToggle: (entry: PluginInventoryEntry, enabled: boolean) => void
  t: DesktopTranslate
}): React.JSX.Element {
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = normalized.length === 0
    ? entries
    : entries.filter(entry =>
      pluginDisplayName(entry.moduleName).toLocaleLowerCase().includes(normalized) ||
      entry.moduleName.toLocaleLowerCase().includes(normalized),
    )
  return (
    <div>
      {failure !== undefined && <div className="dsh-plugin-center__notice" role="alert">{failure}</div>}
      {loading && <div className="dsh-plugin-center__empty">{t('Loading plugins...')}</div>}
      {!loading && filtered.length === 0 && (
        <div className="dsh-plugin-center__empty">
          {entries.length === 0 ? t('No user plugins are installed.') : t('No plugins match this search.')}
        </div>
      )}
      <ul className="dsh-plugin-center__list">
        {filtered.map(entry => {
          const entryId = String(entry.entryId)
          const override = policy?.overrides[entryId]
          const desiredEnabled = override?.moduleName === entry.moduleName ? override.enabled : entry.enabled
          const drifting = desiredEnabled !== entry.enabled
          return (
            <li className="dsh-plugin-center__row" key={entryId}>
              <span className="dsh-plugin-center__icon" aria-hidden="true">
                <IconCordisPluginOutline14 size={18} />
              </span>
              <span className="dsh-plugin-center__identity">
                <span className="dsh-plugin-center__name">{pluginDisplayName(entry.moduleName)}</span>
                <span className={`dsh-plugin-center__description${drifting ? ' dsh-plugin-center__runtime-error' : ''}`}>
                  {pluginRuntimeLabel(entry, desiredEnabled, t)} · {entry.moduleName}
                </span>
              </span>
              <SettingsToggle
                checked={desiredEnabled}
                label={t(desiredEnabled ? 'Disable {name}' : 'Enable {name}', {
                  name: pluginDisplayName(entry.moduleName),
                })}
                disabled={policy === undefined || pending.has(entryId)}
                onChange={enabled => onToggle(entry, enabled)}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function McpTab({
  snapshot,
  loading,
  failure,
  onManageApps,
  t,
}: {
  snapshot?: ConnectionSnapshot
  loading: boolean
  failure?: string
  onManageApps: () => void
  t: DesktopTranslate
}): React.JSX.Element {
  const servers = snapshot?.connections ?? []
  return (
    <div>
      <div className="dsh-plugin-center__panel-toolbar" style={{ gap: 8 }}>
        <Button size="sm" variant="outline" onClick={onManageApps}>{t('Manage Apps')}</Button>
      </div>
      {failure !== undefined && <div className="dsh-plugin-center__notice" role="alert">{failure}</div>}
      {loading && <div className="dsh-plugin-center__empty">{t('Loading MCP servers...')}</div>}
      {!loading && servers.length === 0 && <div className="dsh-plugin-center__empty">{t('No MCP servers')}</div>}
      <ul className="dsh-plugin-center__list">
        {servers.map(connection => (
          <li className="dsh-plugin-center__row" key={connection.id}>
            <span className="dsh-plugin-center__icon" aria-hidden="true">
              <IconApiOutline14 size={18} />
            </span>
            <span className="dsh-plugin-center__identity">
              <span className="dsh-plugin-center__name">{connection.label}</span>
              <span className="dsh-plugin-center__description">
                {t('{count} tools', { count: String(connection.enabledTools.length) })} · {connection.access === 'read-only'
                  ? t('Read only')
                  : t('Read and write')}
              </span>
            </span>
            <span className="dsh-plugin-center__status">
              <StateDot state={connectionStateDot(connection.status)} />
              {localizedConnectionStatus(connection.status, t)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function MarketplaceTab({ t }: { t: DesktopTranslate }): React.JSX.Element {
  return (
    <div className="dsh-plugin-center__marketplace">
      <div className="dsh-plugin-center__row">
        <span className="dsh-plugin-center__icon" aria-hidden="true">
          <IconBrowseOutline16 size={18} />
        </span>
        <span className="dsh-plugin-center__identity">
          <span className="dsh-plugin-center__name">{t('DeepSeek Harness plugin directory')}</span>
          <span className="dsh-plugin-center__description">{t('Community plugins tagged dsh-plugin on GitHub')}</span>
        </span>
        <Button size="sm" variant="outline" icon={<IconRightUpOutline16 />} onClick={openPluginDirectory}>
          {t('Browse')}
        </Button>
      </div>
    </div>
  )
}

function PluginsSettingsSection({
  bridge,
  listPlugins,
  pluginPolicyBridge,
  t,
}: {
  bridge?: DesktopConnectionsBridge
  listPlugins: () => Promise<PluginInventorySnapshot>
  pluginPolicyBridge?: DesktopPluginPolicyBridge
  t: DesktopTranslate
}): React.JSX.Element {
  const [active, setActive] = useState<PluginCenterTabId>('plugins')
  const [query, setQuery] = useState('')
  const [plugins, setPlugins] = useState<PluginInventorySnapshot>()
  const [connections, setConnections] = useState<ConnectionSnapshot>()
  const [pluginsLoading, setPluginsLoading] = useState(true)
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [pluginsFailure, setPluginsFailure] = useState<string>()
  const [pluginPolicyFailure, setPluginPolicyFailure] = useState<string>()
  const [connectionsFailure, setConnectionsFailure] = useState<string>()
  const [pendingPlugins, setPendingPlugins] = useState<ReadonlySet<string>>(() => new Set())
  const [pluginPolicySnapshot, setPluginPolicySnapshot] = useState<DesktopPluginPolicySnapshot>()
  const [installOpen, setInstallOpen] = useState(false)
  const [packageSpec, setPackageSpec] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installFailure, setInstallFailure] = useState<string>()
  const [installNotice, setInstallNotice] = useState<string>()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const refreshPlugins = async (): Promise<void> => {
    setPluginsLoading(true)
    try {
      setPlugins(await listPlugins())
      setPluginsFailure(undefined)
    } catch (cause) {
      setPluginsFailure(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setPluginsLoading(false)
    }
  }

  const refreshConnections = async (): Promise<void> => {
    if (bridge === undefined) {
      setConnectionsFailure(t('The desktop connection bridge is unavailable.'))
      setConnectionsLoading(false)
      return
    }
    setConnectionsLoading(true)
    try {
      setConnections(await bridge.list())
      setConnectionsFailure(undefined)
    } catch (cause) {
      setConnectionsFailure(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setConnectionsLoading(false)
    }
  }

  useEffect(() => {
    void refreshPlugins()
  }, [listPlugins, t])

  useEffect(() => {
    if (pluginPolicyBridge === undefined) {
      setPluginPolicyFailure(t('Plugin settings are unavailable.'))
      return
    }
    let active = true
    void pluginPolicyBridge.getState().then(snapshot => {
      if (!active) return
      setPluginPolicySnapshot(snapshot)
      setPluginPolicyFailure(snapshot.statusMessage)
    }).catch(cause => {
      if (active) setPluginPolicyFailure(errorMessage(cause, t('The desktop operation failed.')))
    })
    const dispose = pluginPolicyBridge.onChanged(snapshot => {
      setPluginPolicySnapshot(snapshot)
      setPluginPolicyFailure(snapshot.statusMessage)
    })
    return () => {
      active = false
      dispose()
    }
  }, [pluginPolicyBridge, t])

  useEffect(() => {
    void refreshConnections()
    if (bridge === undefined) return
    return bridge.onChanged(snapshot => {
      setConnections(snapshot)
      setConnectionsFailure(undefined)
      setConnectionsLoading(false)
    })
  }, [bridge, t])

  const pluginEntries = useMemo(
    () => (plugins?.entries ?? []).filter(isUserFacingPlugin),
    [plugins],
  )
  const connectedApps = connections?.connections.filter(connection => connection.status !== 'disconnected').length ?? 0
  const mcpServers = connections?.connections.length ?? 0
  const tabs: ReadonlyArray<{ id: PluginCenterTabId; label: string; count?: number }> = [
    { id: 'plugins', label: t('Plugins'), count: pluginEntries.length },
    { id: 'apps', label: t('Apps'), count: connectedApps },
    { id: 'mcp', label: t('MCP'), count: mcpServers },
    { id: 'marketplace', label: t('Marketplace'), count: 1 },
  ]

  const togglePlugin = async (entry: PluginInventoryEntry, enabled: boolean): Promise<void> => {
    const entryId = String(entry.entryId)
    setPendingPlugins(current => new Set([...current, entryId]))
    setPluginsFailure(undefined)
    try {
      const current = pluginPolicySnapshot
      if (pluginPolicyBridge === undefined || current === undefined) {
        throw new Error(t('Plugin settings are unavailable.'))
      }
      const saved = await pluginPolicyBridge.update({
        expectedRevision: current.revision,
        entryId,
        moduleName: entry.moduleName,
        enabled,
      })
      setPluginPolicySnapshot(saved)
      setPluginPolicyFailure(saved.statusMessage)
      const savedOverride = saved.overrides[entryId]
      if (savedOverride?.moduleName !== entry.moduleName || savedOverride.enabled !== enabled) {
        throw new Error(t('The plugin preference could not be saved.'))
      }

      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const next = await listPlugins()
        setPlugins(next)
        const runtime = next.entries.find(candidate => String(candidate.entryId) === entryId)
        if (runtime === undefined || runtime.moduleName !== entry.moduleName) {
          throw new Error(t('The plugin is no longer installed.'))
        }
        if (runtime.enabled === enabled && (!enabled || runtime.fiberPhase === 'active')) return
        if (enabled && runtime.fiberPhase === 'failed') throw new Error(t('The plugin failed to start.'))
        await new Promise(resolve => setTimeout(resolve, 125))
      }
      throw new Error(enabled ? t('The plugin did not start.') : t('The plugin did not stop.'))
    } catch (cause) {
      setPluginsFailure(errorMessage(cause, t('The desktop operation failed.')))
      if (pluginPolicyBridge !== undefined) {
        void pluginPolicyBridge.getState().then(setPluginPolicySnapshot).catch(() => undefined)
      }
    } finally {
      setPendingPlugins(current => {
        const next = new Set(current)
        next.delete(entryId)
        return next
      })
    }
  }

  const completeInstall = (result: DesktopPluginInstallResult | undefined): void => {
    if (result === undefined) return
    setInstallFailure(undefined)
    setInstallNotice(result.changed
      ? t('Installed {name}. Reloading Harness...', { name: result.packageName })
      : t('{name} is already installed.', { name: result.packageName }))
    if (!result.changed) {
      setActive('plugins')
      void refreshPlugins()
    }
  }

  const browseDirectory = async (): Promise<void> => {
    if (pluginPolicyBridge === undefined || installing) return
    setInstalling(true)
    setInstallFailure(undefined)
    setInstallNotice(undefined)
    try {
      completeInstall(await pluginPolicyBridge.installDirectory())
    } catch (cause) {
      setInstallFailure(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setInstalling(false)
    }
  }

  const installRegistry = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (pluginPolicyBridge === undefined || installing || packageSpec.trim() === '') return
    setInstalling(true)
    setInstallFailure(undefined)
    setInstallNotice(undefined)
    try {
      const result = await pluginPolicyBridge.installRegistry({ packageSpec: packageSpec.trim() })
      setInstallOpen(false)
      setPackageSpec('')
      completeInstall(result)
    } catch (cause) {
      setInstallFailure(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <section className="dsh-plugin-center" aria-label={t('Plugins')}>
      <SettingsStyles />
      <style>{pluginCenterStyles}</style>
      <header className="dsh-plugin-center__header">
        <div>
          <h2 className="dsh-plugin-center__title">{t('Plugins')}</h2>
          <p className="dsh-plugin-center__subtitle">{t('Manage plugins, apps, and MCP servers')}</p>
        </div>
        <div className="dsh-plugin-center__toolbar">
          <Button
            size="sm"
            variant="outline"
            icon={<IconBrowseOutline16 />}
            disabled={pluginPolicyBridge === undefined || installing}
            onClick={() => { void browseDirectory() }}
          >
            {t('Browse directory')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={pluginPolicyBridge === undefined || installing}
            onClick={() => {
              setInstallFailure(undefined)
              setInstallOpen(true)
            }}
          >
            {t('Add')}
          </Button>
        </div>
      </header>
      <div className="dsh-plugin-center__tabs-row">
        <div className="dsh-plugin-center__tabs" role="tablist" aria-label={t('Plugin categories')}>
          {tabs.map((tab, index) => (
            <button
              ref={element => { tabRefs.current[index] = element }}
              key={tab.id}
              type="button"
              className="dsh-plugin-center__tab"
              role="tab"
              aria-selected={active === tab.id}
              data-active={active === tab.id ? 'true' : undefined}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={event => {
                let nextIndex: number | undefined
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
                if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
                if (event.key === 'Home') nextIndex = 0
                if (event.key === 'End') nextIndex = tabs.length - 1
                if (nextIndex === undefined) return
                event.preventDefault()
                setActive(tabs[nextIndex]!.id)
                tabRefs.current[nextIndex]?.focus()
              }}
            >
              {tab.label}
              {tab.count !== undefined && <span className="dsh-plugin-center__count">{tab.count}</span>}
            </button>
          ))}
        </div>
        {active === 'plugins' && (
          <label className="dsh-plugin-center__search">
            <IconSearchOutline16 size={16} />
            <input
              type="search"
              value={query}
              aria-label={t('Search plugins')}
              placeholder={t('Search plugins')}
              onChange={event => setQuery(event.currentTarget.value)}
            />
          </label>
        )}
      </div>
      <div className="dsh-plugin-center__panel" role="tabpanel">
        {installFailure !== undefined && !installOpen && (
          <div className="dsh-plugin-center__notice" role="alert">{installFailure}</div>
        )}
        {installNotice !== undefined && installFailure === undefined && (
          <div className="dsh-plugin-center__notice dsh-plugin-center__notice--info" role="status">
            {installNotice}
          </div>
        )}
        {active === 'plugins' && (
          <PluginCatalogTab
            entries={pluginEntries}
            loading={pluginsLoading}
            failure={pluginsFailure ?? pluginPolicyFailure}
            query={query}
            policy={pluginPolicySnapshot}
            pending={pendingPlugins}
            onToggle={(entry, enabled) => { void togglePlugin(entry, enabled) }}
            t={t}
          />
        )}
        {active === 'apps' && <ConnectionsSection bridge={bridge} t={t} />}
        {active === 'mcp' && (
          <McpTab
            snapshot={connections}
            loading={connectionsLoading}
            failure={connectionsFailure}
            onManageApps={() => setActive('apps')}
            t={t}
          />
        )}
        {active === 'marketplace' && <MarketplaceTab t={t} />}
      </div>
      <Modal
        open={installOpen}
        onClose={() => { if (!installing) setInstallOpen(false) }}
        title={t('Add plugin')}
        closeLabel={t('Close plugin installer')}
        footer={(
          <div style={styles.formActions}>
            <Button variant="outline" disabled={installing} onClick={() => setInstallOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              type="submit"
              form="dsh-plugin-install-form"
              variant="primary"
              disabled={installing || packageSpec.trim() === ''}
            >
              {installing ? t('Adding...') : t('Add')}
            </Button>
          </div>
        )}
      >
        <form id="dsh-plugin-install-form" style={styles.form} onSubmit={event => { void installRegistry(event) }}>
          <label style={styles.field}>
            <span style={styles.label}>{t('npm package')}</span>
            <Input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              value={packageSpec}
              placeholder="@scope/dsh-plugin-name"
              onChange={event => setPackageSpec(event.currentTarget.value)}
            />
          </label>
          {installFailure !== undefined && (
            <div className="dsh-plugin-center__notice" role="alert">{installFailure}</div>
          )}
        </form>
      </Modal>
    </section>
  )
}

function worktreeBranch(worktree: WorktreeSummary): string {
  const branch = worktree.branch ?? worktree.baseRef
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

function worktreeStatus(worktree: WorktreeSummary, t: DesktopTranslate): {
  state: 'done' | 'warning' | 'ongoing' | 'error'
  label: string
} {
  if (worktree.lifecycle === 'provisioning') return { state: 'ongoing', label: t('Creating') }
  if (worktree.lifecycle === 'removing') return { state: 'ongoing', label: t('Cleaning up') }
  if (worktree.lifecycle === 'recovery-required') return { state: 'error', label: t('Needs attention') }
  if (worktree.lifecycle === 'orphaned') return { state: 'warning', label: t('Orphaned') }
  if (worktree.lifecycle === 'removed') return { state: 'done', label: t('Removed') }
  return { state: 'done', label: t('Ready') }
}

function worktreeRecoveryLabel(
  reason: WorktreeSummary['recoveryReason'],
  t: DesktopTranslate,
): string | undefined {
  if (reason === undefined) return undefined
  if (reason === 'create-ambiguous') return t('Creation result is ambiguous')
  if (reason === 'interrupted-create') return t('Creation was interrupted')
  if (reason === 'interrupted-remove') return t('Cleanup was interrupted')
  if (reason === 'inspection-failed') return t('Git inspection failed')
  if (reason === 'external-change') return t('Checkout identity changed')
  if (reason === 'locked') return t('Managed lock changed')
  if (reason === 'missing') return t('Checkout is missing')
  return t('Branch moved to another checkout')
}

function repositoryIdentityStateLabel(
  state: 'matching' | 'changed' | 'not-a-repository',
  t: DesktopTranslate,
): string {
  if (state === 'matching') return t('Matches original repository')
  if (state === 'changed') return t('Different repository identity')
  return t('Not a Git repository')
}

function worktreeRegistrationStateLabel(
  state: 'matching' | 'changed' | 'missing' | 'unavailable',
  t: DesktopTranslate,
): string {
  if (state === 'matching') return t('Matches registered checkout')
  if (state === 'changed') return t('Registration identity changed')
  if (state === 'missing') return t('Registration missing')
  return t('Unavailable because the original repository changed')
}

function handoffBlockerLabel(blocker: WorktreeHandoffBlocker, t: DesktopTranslate): string {
  if (blocker === 'source-detached') return t('The source checkout is detached.')
  if (blocker === 'source-conflicts') return t('Resolve source merge conflicts first.')
  if (blocker === 'source-diverged') return t('The source no longer descends from the managed base commit.')
  if (blocker === 'destination-detached') return t('The destination checkout is detached.')
  if (blocker === 'destination-head-changed') return t('The destination HEAD is no longer the managed base commit.')
  if (blocker === 'destination-dirty') return t('The destination contains changes. Preserve or remove them first.')
  if (blocker === 'destination-collision') return t('An ignored or untracked destination path collides with this transfer.')
  return t('The source has no changes relative to the managed base commit.')
}

function handoffFileStatus(
  status: WorktreeHandoffPreview['preflight']['files'][number]['status'],
  t: DesktopTranslate,
): string {
  if (status === 'added') return t('Added')
  if (status === 'modified') return t('Modified')
  if (status === 'deleted') return t('Deleted')
  if (status === 'renamed') return t('Renamed')
  if (status === 'copied') return t('Copied')
  if (status === 'type-changed') return t('Type changed')
  if (status === 'unmerged') return t('Conflict')
  return t('Untracked')
}

function cleanupChangeStatus(
  change: WorktreeCleanupPreview['inspection']['changes'][number],
  t: DesktopTranslate,
): string {
  if (change.kind === 'ignored') return t('Ignored')
  if (change.kind === 'untracked') return t('Untracked')
  if (change.kind === 'unmerged') return t('Conflict')
  if (change.kind === 'renamed') return t('Renamed')
  if (change.indexStatus !== '.' && change.worktreeStatus !== '.') return t('Staged + changed')
  return change.indexStatus !== '.' ? t('Staged') : t('Changed')
}

function WorktreesSection({ t }: { t: DesktopTranslate }): React.JSX.Element {
  const bridge = window.dshDesktop?.worktrees
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [cleanupPreviewingId, setCleanupPreviewingId] = useState<string>()
  const [cleanupPreview, setCleanupPreview] = useState<WorktreeCleanupPreview>()
  const [cleanupAcknowledged, setCleanupAcknowledged] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [recoveryPreviewingId, setRecoveryPreviewingId] = useState<string>()
  const [recoveryPreview, setRecoveryPreview] = useState<WorktreeRecoveryPreview>()
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [handoffPreviewingKey, setHandoffPreviewingKey] = useState<string>()
  const [handoffPreview, setHandoffPreview] = useState<WorktreeHandoffPreview>()
  const [handoffAcknowledged, setHandoffAcknowledged] = useState(false)
  const [transferring, setTransferring] = useState(false)

  const applySnapshot = (next: WorktreeSnapshot): void => {
    setSnapshot(current => current === undefined || next.revision >= current.revision ? next : current)
  }

  const refresh = async (): Promise<void> => {
    if (bridge === undefined) {
      setError(t('The desktop worktree bridge is unavailable.'))
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      applySnapshot(await bridge.reconcile())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (bridge === undefined) {
      setError(t('The desktop worktree bridge is unavailable.'))
      setLoading(false)
      return
    }
    let active = true
    const unsubscribe = bridge.onChanged(next => {
      if (active) applySnapshot(next)
    })
    void bridge.list().then(next => {
      if (active) {
        applySnapshot(next)
        setError(undefined)
      }
    }).catch(cause => {
      if (active) setError(errorMessage(cause, t('The desktop operation failed.')))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge, t])

  const inspectCleanup = async (worktreeId: string): Promise<void> => {
    if (bridge === undefined) return
    setCleanupPreviewingId(worktreeId)
    setError(undefined)
    setNotice(undefined)
    try {
      setCleanupPreview(await bridge.previewCleanup({ worktreeId }))
      setCleanupAcknowledged(false)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setCleanupPreviewingId(undefined)
    }
  }

  const closeCleanupPreview = (): void => {
    if (cleaning) return
    setCleanupPreview(undefined)
    setCleanupAcknowledged(false)
  }

  const confirmCleanup = async (): Promise<void> => {
    if (bridge === undefined || cleanupPreview?.canRemove !== true || !cleanupAcknowledged) return
    setCleaning(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await bridge.confirmCleanup({ previewId: cleanupPreview.previewId, confirmed: true })
      setCleanupPreview(undefined)
      setCleanupAcknowledged(false)
      applySnapshot(await bridge.list())
    } catch (cause) {
      setCleanupPreview(undefined)
      setCleanupAcknowledged(false)
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setCleaning(false)
    }
  }

  const reviewCleanupTransfer = (): void => {
    if (cleanupPreview?.canRemove !== false) return
    const worktreeId = cleanupPreview.worktree.id
    closeCleanupPreview()
    void inspectHandoff(worktreeId, 'worktree-to-local')
  }

  const inspectRecovery = async (
    worktreeId: string,
    action: DesktopWorktreeRecoveryPreviewInput['action'],
  ): Promise<void> => {
    if (bridge === undefined) return
    setRecoveryPreviewingId(worktreeId)
    setError(undefined)
    setNotice(undefined)
    try {
      const preview = await bridge.previewRecovery({ worktreeId, action })
      if (preview.action !== action) throw new Error(t('The desktop returned a different worktree recovery action.'))
      setRecoveryPreview(preview)
      setRecoveryAcknowledged(false)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setRecoveryPreviewingId(undefined)
    }
  }

  const closeRecoveryPreview = (): void => {
    if (recovering) return
    setRecoveryPreview(undefined)
    setRecoveryAcknowledged(false)
  }

  const confirmRecovery = async (): Promise<void> => {
    if (bridge === undefined || recoveryPreview === undefined || !recoveryAcknowledged) return
    const action = recoveryPreview.action
    setRecovering(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await bridge.confirmRecovery({ previewId: recoveryPreview.previewId, confirmed: true })
      if (result.action !== action) throw new Error(t('The desktop returned a different worktree recovery result.'))
      setRecoveryPreview(undefined)
      setRecoveryAcknowledged(false)
      setNotice(action === 'forget-missing'
        ? t('The stale missing-worktree record was forgotten. No files or Git branches were changed.')
        : action === 'stop-tracking'
          ? t('DSH Desktop stopped tracking the changed checkout. Its directory, files, Git metadata, and branch were left untouched.')
        : action === 'restore-moved'
          ? result.worktree.lifecycle === 'orphaned'
            ? t('The checkout was restored to its registered path with its files and branch intact. It is now orphaned.')
            : t('The checkout was restored to its registered path with its files and branch intact.')
        : result.worktree.lifecycle === 'orphaned'
          ? t('The interrupted cleanup was cancelled. The unchanged checkout is now orphaned.')
          : t('The interrupted cleanup was cancelled. The unchanged checkout is ready.'))
      applySnapshot(await bridge.list())
    } catch (cause) {
      setRecoveryPreview(undefined)
      setRecoveryAcknowledged(false)
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setRecovering(false)
    }
  }

  const inspectHandoff = async (
    worktreeId: string,
    direction: WorktreeHandoffDirection,
  ): Promise<void> => {
    if (bridge === undefined) return
    setHandoffPreviewingKey(`${worktreeId}:${direction}`)
    setError(undefined)
    setNotice(undefined)
    try {
      setHandoffPreview(await bridge.previewHandoff({ worktreeId, direction }))
      setHandoffAcknowledged(false)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setHandoffPreviewingKey(undefined)
    }
  }

  const closeHandoffPreview = (): void => {
    if (transferring) return
    setHandoffPreview(undefined)
    setHandoffAcknowledged(false)
  }

  const confirmHandoff = async (): Promise<void> => {
    if (bridge === undefined || handoffPreview === undefined || !handoffAcknowledged ||
      !handoffPreview.preflight.canTransfer) return
    setTransferring(true)
    setError(undefined)
    setNotice(undefined)
    const direction = handoffPreview.preflight.direction
    try {
      await bridge.confirmHandoff({ previewId: handoffPreview.previewId, confirmed: true })
      setHandoffPreview(undefined)
      setHandoffAcknowledged(false)
      setNotice(direction === 'local-to-worktree'
        ? t('Local changes were staged in the managed worktree. The local checkout is unchanged.')
        : t('Worktree changes were staged in the local checkout. The managed worktree is unchanged.'))
      applySnapshot(await bridge.list())
    } catch (cause) {
      setHandoffPreview(undefined)
      setHandoffAcknowledged(false)
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setTransferring(false)
    }
  }

  const worktrees = useMemo(() => [...(snapshot?.worktrees ?? [])].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  ), [snapshot])

  return (
    <section style={styles.root} aria-labelledby="desktop-worktrees-heading">
      <header style={styles.header}>
        <h2 id="desktop-worktrees-heading" style={styles.heading}>{t('Worktrees')}</h2>
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRefreshOutline16 />}
          aria-label={t('Recheck worktrees')}
          title={t('Recheck worktrees')}
          disabled={loading}
          onClick={() => void refresh()}
        />
      </header>

      {error !== undefined && (
        <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-error-secondary, #fef0ef)' }}>
          {error}
        </div>
      )}
      {notice !== undefined && (
        <div role="status" style={{ ...styles.notice, background: 'var(--dsw-alias-state-success-secondary, #eaf7ee)' }}>
          {notice}
        </div>
      )}

      {!loading && worktrees.length === 0 && <div style={styles.empty}>{t('No managed worktrees.')}</div>}
      <div style={styles.list}>
        {worktrees.map(worktree => {
          const status = worktreeStatus(worktree, t)
          const recovery = worktreeRecoveryLabel(worktree.recoveryReason, t)
          const cleanupAvailable = worktree.executionMode === 'worktree' &&
            (worktree.lifecycle === 'ready' || worktree.lifecycle === 'orphaned')
          const handoffAvailable = cleanupAvailable
          const keepInterruptedRemoval = worktree.lifecycle === 'recovery-required' &&
            worktree.recoveryReason === 'interrupted-remove'
          const forgetMissing = worktree.lifecycle === 'recovery-required' &&
            worktree.recoveryReason === 'missing'
          const restoreMoved = worktree.lifecycle === 'recovery-required' &&
            worktree.recoveryReason === 'moved'
          const stopTracking = worktree.lifecycle === 'recovery-required' &&
            worktree.recoveryReason === 'external-change'
          const operationsBusy = cleanupPreviewingId !== undefined || recoveryPreviewingId !== undefined ||
            handoffPreviewingKey !== undefined || cleaning || recovering || transferring
          return (
            <article key={worktree.id} style={styles.item}>
              <div style={styles.itemTop}>
                <div style={styles.identity}>
                  <span style={{ ...styles.itemTitle, alignItems: 'center', display: 'flex', gap: 6 }}>
                    <IconBranchOutline16 />
                    {worktreeBranch(worktree)}
                  </span>
                  <span style={styles.metadata}>{worktree.worktreePath ?? worktree.repositoryRoot}</span>
                </div>
                <span style={styles.status}>
                  <StateDot state={status.state} />
                  {status.label}
                </span>
              </div>
              <div style={styles.worktreeDetails}>
                <span style={styles.metadata}>{t('Repository: {path}', { path: worktree.repositoryRoot })}</span>
                <span style={styles.metadata}>
                  {t('Base: {ref} at {commit}', {
                    ref: worktree.baseRef,
                    commit: worktree.baseCommit.slice(0, 12),
                  })}
                </span>
                {worktree.sessionId !== undefined && (
                  <span style={styles.metadata}>{t('Session: {id}', { id: worktree.sessionId })}</span>
                )}
                {recovery !== undefined && <p style={styles.statusMessage}>{recovery}</p>}
              </div>
              <div style={styles.itemBottom}>
                <span style={styles.metadata}>
                  {worktree.sessionState === 'bound' ? t('Session bound') : t('Awaiting session')}
                </span>
                <div style={styles.worktreeActions}>
                  {keepInterruptedRemoval && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconCheckOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectRecovery(worktree.id, 'keep-interrupted-removal')}
                    >
                      {t('Keep checkout')}
                    </Button>
                  )}
                  {forgetMissing && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconTrashOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectRecovery(worktree.id, 'forget-missing')}
                    >
                      {t('Forget record')}
                    </Button>
                  )}
                  {restoreMoved && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRefreshOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectRecovery(worktree.id, 'restore-moved')}
                    >
                      {t('Restore path')}
                    </Button>
                  )}
                  {stopTracking && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconTrashOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectRecovery(worktree.id, 'stop-tracking')}
                    >
                      {t('Stop tracking')}
                    </Button>
                  )}
                  {handoffAvailable && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconDownloadOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectHandoff(worktree.id, 'local-to-worktree')}
                    >
                      {t('Import local')}
                    </Button>
                  )}
                  {handoffAvailable && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRightUpOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectHandoff(worktree.id, 'worktree-to-local')}
                    >
                      {t('Send to local')}
                    </Button>
                  )}
                  {cleanupAvailable && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconTrashOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectCleanup(worktree.id)}
                    >
                      {t('Clean up')}
                    </Button>
                  )}
                </div>
              </div>
            </article>
          )
        })}
      </div>

      <Modal
        open={cleanupPreview !== undefined}
        onClose={closeCleanupPreview}
        title={cleanupPreview?.canRemove === false ? t('Worktree has changes') : t('Clean up worktree')}
        closeLabel={t('Close cleanup preview')}
        description={cleanupPreview?.canRemove === false
          ? t('Cleanup is blocked so modified, untracked, and ignored files remain in the checkout.')
          : t('The clean checkout directory will be removed. Its Git branch will be kept.')}
        footer={(
          <div style={styles.formActions}>
            <Button variant="outline" disabled={cleaning} onClick={closeCleanupPreview}>
              {cleanupPreview?.canRemove === false ? t('Keep worktree') : t('Cancel')}
            </Button>
            {cleanupPreview?.canRemove === false ? (
              <Button
                variant="primary"
                icon={<IconRightUpOutline16 />}
                disabled={cleaning}
                onClick={reviewCleanupTransfer}
              >
                {t('Review transfer')}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<IconTrashOutline16 />}
                disabled={!cleanupAcknowledged || cleaning}
                onClick={() => void confirmCleanup()}
              >
                {t('Clean up')}
              </Button>
            )}
          </div>
        )}
      >
        {cleanupPreview !== undefined && (
          <div style={styles.worktreeConfirmBody}>
            <div style={styles.worktreeConfirmDetails}>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>{t('Branch')}</span>
                <span style={styles.metadata}>{worktreeBranch(cleanupPreview.worktree)}</span>
              </div>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>{t('Checkout')}</span>
                <span style={styles.metadata}>{cleanupPreview.inspection.worktreePath}</span>
              </div>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>{t('Commit')}</span>
                <span style={styles.metadata}>{cleanupPreview.inspection.head}</span>
              </div>
            </div>
            {cleanupPreview.canRemove ? (
              <label style={styles.worktreeAcknowledge}>
                <input
                  type="checkbox"
                  checked={cleanupAcknowledged}
                  disabled={cleaning}
                  onChange={event => setCleanupAcknowledged(event.currentTarget.checked)}
                  style={{ flex: '0 0 auto', height: 16, margin: '2px 0 0', width: 16 }}
                />
                <span>{t('I understand this removes the checkout directory and keeps the branch.')}</span>
              </label>
            ) : (
              <div style={styles.field}>
                <span style={styles.label}>{t('Preserved changes ({count})', {
                  count: String(cleanupPreview.inspection.changes.length),
                })}</span>
                <div style={styles.handoffFiles}>
                  {cleanupPreview.inspection.changes.map(change => (
                    <div key={change.path} style={styles.handoffFile}>
                      <span style={styles.label}>{cleanupChangeStatus(change, t)}</span>
                      <span style={styles.metadata}>
                        {change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`}
                      </span>
                    </div>
                  ))}
                </div>
                {cleanupPreview.inspection.changes.some(change => change.kind === 'ignored') && (
                  <p style={styles.statusMessage}>
                    {t('Ignored files stay only in this checkout and are not included in a Git transfer.')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={recoveryPreview !== undefined}
        onClose={closeRecoveryPreview}
        title={recoveryPreview?.action === 'forget-missing'
          ? t('Forget missing worktree')
          : recoveryPreview?.action === 'stop-tracking'
            ? t('Stop tracking changed checkout')
          : recoveryPreview?.action === 'restore-moved'
            ? t('Restore moved worktree')
            : t('Keep interrupted worktree')}
        closeLabel={t('Close recovery preview')}
        description={recoveryPreview?.action === 'forget-missing'
          ? t('Remove a stale desktop record only after Git metadata and the checkout path are both absent.')
          : recoveryPreview?.action === 'stop-tracking'
            ? t('Remove only the DSH Desktop assignment after the registered repository or checkout identity changed.')
          : recoveryPreview?.action === 'restore-moved'
            ? t('Move the exact managed checkout back to its registered path without changing its branch or files.')
            : t('Cancel the old cleanup intent while leaving the checkout, branch, and files unchanged.')}
        footer={(
          <div style={styles.formActions}>
            <Button variant="outline" disabled={recovering} onClick={closeRecoveryPreview}>{t('Cancel')}</Button>
            <Button
              variant="primary"
              icon={recoveryPreview?.action === 'forget-missing' || recoveryPreview?.action === 'stop-tracking'
                ? <IconTrashOutline16 />
                : recoveryPreview?.action === 'restore-moved'
                  ? <IconRefreshOutline16 />
                  : <IconCheckOutline16 />}
              disabled={!recoveryAcknowledged || recovering}
              onClick={() => void confirmRecovery()}
            >
              {recoveryPreview?.action === 'forget-missing'
                ? t('Forget record')
                : recoveryPreview?.action === 'stop-tracking'
                  ? t('Stop tracking')
                : recoveryPreview?.action === 'restore-moved'
                  ? t('Restore path')
                  : t('Keep checkout')}
            </Button>
          </div>
        )}
      >
        {recoveryPreview !== undefined && (
          <div style={styles.worktreeConfirmBody}>
            <div style={styles.worktreeConfirmDetails}>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>{t('Branch')}</span>
                <span style={styles.metadata}>{worktreeBranch(recoveryPreview.worktree)}</span>
              </div>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>
                  {recoveryPreview.action === 'restore-moved'
                    ? t('Current checkout')
                    : recoveryPreview.action === 'stop-tracking'
                      ? t('Registered checkout')
                      : t('Checkout')}
                </span>
                <span style={styles.metadata}>
                  {recoveryPreview.action === 'restore-moved'
                    ? recoveryPreview.inspection.current.worktreePath
                    : recoveryPreview.action === 'stop-tracking'
                      ? recoveryPreview.inspection.registeredPath
                      : recoveryPreview.inspection.worktreePath}
                </span>
              </div>
              {recoveryPreview.action === 'keep-interrupted-removal' ? (
                <>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Current commit')}</span>
                    <span style={styles.metadata}>{recoveryPreview.inspection.head}</span>
                  </div>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Checkout state')}</span>
                    <span style={styles.metadata}>
                      {recoveryPreview.inspection.clean
                        ? t('Clean')
                        : t('{count} preserved changes', {
                          count: String(recoveryPreview.inspection.changes.length),
                        })}
                    </span>
                  </div>
                </>
              ) : recoveryPreview.action === 'forget-missing' ? (
                <>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Git worktree metadata')}</span>
                    <span style={styles.metadata}>{t('Absent')}</span>
                  </div>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Checkout path')}</span>
                    <span style={styles.metadata}>{t('Absent')}</span>
                  </div>
                </>
              ) : recoveryPreview.action === 'stop-tracking' ? (
                <>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Original repository')}</span>
                    <span style={styles.metadata}>
                      {repositoryIdentityStateLabel(recoveryPreview.inspection.repositoryRootObservation.state, t)}
                    </span>
                  </div>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Checkout identity')}</span>
                    <span style={styles.metadata}>
                      {repositoryIdentityStateLabel(recoveryPreview.inspection.checkoutObservation.state, t)}
                    </span>
                  </div>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Git registration')}</span>
                    <span style={styles.metadata}>
                      {worktreeRegistrationStateLabel(recoveryPreview.inspection.registrationObservation.state, t)}
                    </span>
                  </div>
                  {recoveryPreview.inspection.repositoryRootObservation.state === 'changed' && (
                    <>
                      <div style={styles.worktreeDetail}>
                        <span style={styles.label}>{t('Observed repository')}</span>
                        <span style={styles.metadata}>
                          {recoveryPreview.inspection.repositoryRootObservation.identity.root}
                        </span>
                      </div>
                      <div style={styles.worktreeDetail}>
                        <span style={styles.label}>{t('Observed common directory')}</span>
                        <span style={styles.metadata}>
                          {recoveryPreview.inspection.repositoryRootObservation.identity.commonDir}
                        </span>
                      </div>
                    </>
                  )}
                  {recoveryPreview.inspection.checkoutObservation.state === 'changed' && (
                    <>
                      <div style={styles.worktreeDetail}>
                        <span style={styles.label}>{t('Checkout repository')}</span>
                        <span style={styles.metadata}>
                          {recoveryPreview.inspection.checkoutObservation.identity.root}
                        </span>
                      </div>
                      <div style={styles.worktreeDetail}>
                        <span style={styles.label}>{t('Checkout common directory')}</span>
                        <span style={styles.metadata}>
                          {recoveryPreview.inspection.checkoutObservation.identity.commonDir}
                        </span>
                      </div>
                    </>
                  )}
                  {recoveryPreview.inspection.registrationObservation.state === 'changed' && (
                    <>
                      <div style={styles.worktreeDetail}>
                        <span style={styles.label}>{t('Observed branch')}</span>
                        <span style={styles.metadata}>
                          {recoveryPreview.inspection.registrationObservation.entry.branch ??
                            (recoveryPreview.inspection.registrationObservation.entry.detached
                              ? t('Detached HEAD')
                              : recoveryPreview.inspection.registrationObservation.entry.bare
                                ? t('Bare repository')
                                : t('No branch'))}
                        </span>
                      </div>
                      {recoveryPreview.inspection.registrationObservation.entry.head !== undefined && (
                        <div style={styles.worktreeDetail}>
                          <span style={styles.label}>{t('Observed commit')}</span>
                          <span style={styles.metadata}>
                            {recoveryPreview.inspection.registrationObservation.entry.head}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                <>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Registered path')}</span>
                    <span style={styles.metadata}>{recoveryPreview.inspection.registeredPath}</span>
                  </div>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Current commit')}</span>
                    <span style={styles.metadata}>{recoveryPreview.inspection.current.head}</span>
                  </div>
                  <div style={styles.worktreeDetail}>
                    <span style={styles.label}>{t('Checkout state')}</span>
                    <span style={styles.metadata}>
                      {recoveryPreview.inspection.current.clean
                        ? t('Clean')
                        : t('{count} preserved changes', {
                          count: String(recoveryPreview.inspection.current.changes.length),
                        })}
                    </span>
                  </div>
                </>
              )}
            </div>
            {recoveryPreview.action === 'keep-interrupted-removal' && !recoveryPreview.inspection.clean && (
              <div style={styles.field}>
                <span style={styles.label}>
                  {t('Preserved checkout changes ({count})', {
                    count: String(recoveryPreview.inspection.changes.length),
                  })}
                </span>
                <div style={styles.handoffFiles}>
                  {recoveryPreview.inspection.changes.map(change => (
                    <div key={change.path} style={styles.handoffFile}>
                      <span style={styles.label}>{cleanupChangeStatus(change, t)}</span>
                      <span style={styles.metadata}>
                        {change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {recoveryPreview.action === 'restore-moved' && !recoveryPreview.inspection.current.clean && (
              <div style={styles.field}>
                <span style={styles.label}>
                  {t('Preserved checkout changes ({count})', {
                    count: String(recoveryPreview.inspection.current.changes.length),
                  })}
                </span>
                <div style={styles.handoffFiles}>
                  {recoveryPreview.inspection.current.changes.map(change => (
                    <div key={`${change.kind}:${change.path}`} style={styles.handoffFile}>
                      <span style={styles.label}>{cleanupChangeStatus(change, t)}</span>
                      <span style={styles.metadata}>
                        {change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <label style={styles.worktreeAcknowledge}>
              <input
                type="checkbox"
                checked={recoveryAcknowledged}
                disabled={recovering}
                onChange={event => setRecoveryAcknowledged(event.currentTarget.checked)}
                style={{ flex: '0 0 auto', height: 16, margin: '2px 0 0', width: 16 }}
              />
              <span>
                {recoveryPreview.action === 'forget-missing'
                  ? t('I understand this forgets only the stale desktop record and does not delete files or the Git branch.')
                  : recoveryPreview.action === 'stop-tracking'
                    ? t('I understand DSH Desktop will stop managing this checkout without deleting or modifying its directory, files, Git metadata, or branch.')
                  : recoveryPreview.action === 'restore-moved'
                    ? t('I understand this moves the checkout directory while preserving its branch, commit, and checkout files.')
                    : t('I understand this cancels the interrupted cleanup and does not modify checkout files.')}
              </span>
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={handoffPreview !== undefined}
        onClose={closeHandoffPreview}
        title={handoffPreview?.preflight.direction === 'worktree-to-local'
          ? t('Send changes to local checkout')
          : t('Import local changes')}
        closeLabel={t('Close handoff preview')}
        description={t('Review the exact combined source tree before staging it in the destination checkout.')}
        footer={(
          <div style={styles.formActions}>
            <Button variant="outline" disabled={transferring} onClick={closeHandoffPreview}>
              {handoffPreview?.preflight.canTransfer === false ? t('Close') : t('Cancel')}
            </Button>
            {handoffPreview?.preflight.canTransfer === true && (
              <Button
                variant="primary"
                icon={<IconDownloadOutline16 />}
                disabled={!handoffAcknowledged || transferring}
                onClick={() => void confirmHandoff()}
              >
                {t('Stage in destination')}
              </Button>
            )}
          </div>
        )}
      >
        {handoffPreview !== undefined && (
          <div style={styles.handoffScroll}>
            <div style={styles.handoffPath}>
              <span style={styles.label}>{t('Source remains unchanged')}</span>
              <span style={styles.metadata}>{handoffPreview.preflight.source.path}</span>
            </div>
            <div style={styles.handoffPath}>
              <span style={styles.label}>{t('Destination receives staged changes')}</span>
              <span style={styles.metadata}>{handoffPreview.preflight.destination.path}</span>
            </div>
            <div style={styles.worktreeConfirmDetails}>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>{t('Base commit')}</span>
                <span style={styles.metadata}>{handoffPreview.preflight.baseCommit}</span>
              </div>
              {handoffPreview.preflight.sourceTree !== undefined && (
                <div style={styles.worktreeDetail}>
                  <span style={styles.label}>{t('Reviewed source tree')}</span>
                  <span style={styles.metadata}>{handoffPreview.preflight.sourceTree}</span>
                </div>
              )}
            </div>
            {handoffPreview.preflight.blockers.length > 0 && (
              <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-warning-secondary, #fff6df)', marginBottom: 0 }}>
                {handoffPreview.preflight.blockers.map(blocker => (
                  <div key={blocker}>{handoffBlockerLabel(blocker, t)}</div>
                ))}
              </div>
            )}
            <div style={styles.field}>
              <span style={styles.label}>{t('Files ({count})', {
                count: String(handoffPreview.preflight.files.length),
              })}</span>
              <div style={styles.handoffFiles}>
                {handoffPreview.preflight.files.map(file => (
                  <div key={file.path} style={styles.handoffFile}>
                    <span style={styles.label}>{handoffFileStatus(file.status, t)}</span>
                    <span style={styles.metadata}>
                      {file.originalPath === undefined ? file.path : `${file.originalPath} -> ${file.path}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {handoffPreview.preflight.patch !== '' && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{t('Review patch')}</summary>
                <pre style={styles.handoffPatch}>{handoffPreview.preflight.patch}</pre>
              </details>
            )}
            {handoffPreview.preflight.canTransfer && (
              <label style={styles.worktreeAcknowledge}>
                <input
                  type="checkbox"
                  checked={handoffAcknowledged}
                  disabled={transferring}
                  onChange={event => setHandoffAcknowledged(event.currentTarget.checked)}
                  style={{ flex: '0 0 auto', height: 16, margin: '2px 0 0', width: 16 }}
                />
                <span>
                  {t('I understand the reviewed source tree will be staged in the destination. The source is unchanged, and nothing is committed or pushed.')}
                </span>
              </label>
            )}
          </div>
        )}
      </Modal>
    </section>
  )
}

function AutomationsSection({ t }: { t: DesktopTranslate }): React.JSX.Element {
  const desktop = window.dshDesktop
  return (
    <AutomationTaskCenter
      bridge={desktop?.automations}
      pickProjectDirectory={() => desktop?.pickProjectDirectory() ?? Promise.resolve(null)}
      listConnections={desktop?.connections.list}
      t={t}
    />
  )
}

export const inject = [
  'connection',
  'locale',
  'slots',
  'sessions',
  'workspaces',
  'layout',
  'remote',
  'remote.pluginInventory',
]

export function apply(ctx: ClientContext): void {
  const bridge = window.dshDesktop
  const browserPanel = new BrowserPanelController()
  const setBrowserPanelOpen = (open: boolean): void => {
    browserPanel.setOpen(open)
    if (open) ctx.layout.openDetails()
    else ctx.layout.closeDetails()
  }
  ctx.effect(() => ctx.locale.register(DESKTOP_LOCALE_NAMESPACE, {
    zh: desktopZh,
    en: desktopEn,
  }), 'dsh-desktop: locale dictionaries')
  const desktopT = ctx.locale.bind(DESKTOP_LOCALE_NAMESPACE)
  const listPlugins = async (): Promise<PluginInventorySnapshot> => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`Could not load plugins: ${result.error.message}`)
    }
    return result.value
  }
  if (bridge !== undefined) {
    ctx.effect(() => bridge.onCommand(command => {
      void runDesktopCommand({
        ctx,
        pickProjectDirectory: () => bridge.pickProjectDirectory(),
        openSettings: openOfficialSettings,
      }, command).catch(error => {
        console.warn('Desktop command failed:', error instanceof Error ? error.message : String(error))
      })
    }), 'dsh-desktop: native command bridge')
    installAppSnapshotIntegration(ctx, bridge.appSnapshots)
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'desktop-titlebar',
    order: -100,
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, props => <DesktopTitlebar {...props} layout={ctx.layout} />))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'snapshots',
    order: 11,
    label: () => desktopT('App Snapshots'),
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, ({ t }) => <AppSnapshotsSection bridge={bridge?.appSnapshots} sessions={ctx.sessions.list} t={t} />))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'automations',
    order: 30,
    label: () => desktopT('Tasks'),
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, AutomationsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'browser',
    order: 12,
    label: () => desktopT('Browser'),
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, ({ t }) => <BrowserSettingsSection bridge={bridge?.browser} t={t} />))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => desktopT('Plugins'),
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, ({ t }) => (
    <PluginsSettingsSection
      bridge={bridge?.connections}
      listPlugins={listPlugins}
      pluginPolicyBridge={bridge?.plugins}
      t={t}
    />
  )))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'computer',
    order: 13,
    label: () => desktopT('Computer Control'),
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, ({ t }) => (
    <ComputerControlSection
      bridge={bridge?.computer}
      browser={bridge?.browser}
      openBrowserSettings={() => openOfficialSettings('browser')}
      t={t}
    />
  )))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'worktrees',
    order: 32,
    label: () => desktopT('Worktrees'),
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, WorktreesSection))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'desktop-browser',
    order: 20,
    locale: DESKTOP_LOCALE_NAMESPACE,
  }, (props: BrowserPanelToggleSlotProps) => (
    <BrowserPanelToggle
      {...props}
      controller={browserPanel}
      onOpenChange={setBrowserPanelOpen}
    />
  )))
  ctx.slots.inject('details', () => {
    let disposePanel: (() => void) | undefined
    const reconcile = (): void => {
      if (browserPanel.getSnapshot()) {
        disposePanel ??= ctx.slots.register({
          name: 'details',
          priority: -10,
          locale: DESKTOP_LOCALE_NAMESPACE,
        }, (props: BrowserPanelDetailsSlotProps) => (
          <BrowserPanel
            {...props}
            bridge={bridge?.browser}
            onClose={() => { setBrowserPanelOpen(false) }}
          />
        ))
        return
      }
      disposePanel?.()
      disposePanel = undefined
    }
    const unsubscribe = browserPanel.subscribe(reconcile)
    reconcile()
    return () => {
      unsubscribe()
      disposePanel?.()
    }
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'review',
    order: 20,
    label: () => desktopT('Review'),
  }, (props: ConvViewProps) => <GitReviewView {...props} bridge={bridge?.git} />))
}
