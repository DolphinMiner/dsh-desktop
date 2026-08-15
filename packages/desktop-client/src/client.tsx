import type { CSSProperties, FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconBranchOutline16,
  IconCheckOutline16,
  IconCloseOutline16,
  IconDownloadOutline16,
  IconLinkOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconSettingsOutline16,
  IconStopFill16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  BeginOAuthInput,
  BeginOAuthResult,
  CancelOAuthInput,
  ConnectApiKeyInput,
  ConnectionAccess,
  ConnectionSnapshot,
  ConnectionSummary,
  ComputerControlSnapshot,
  ComputerPermissionStatus,
  ComputerTargetKind,
  DisconnectConnectionInput,
  DesktopRendererCommand,
  DesktopWorktreeCleanupConfirmInput,
  DesktopWorktreeCleanupPreviewInput,
  DesktopWorktreeHandoffConfirmInput,
  DesktopWorktreeHandoffPreflightInput,
  SelectComputerTargetInput,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
  WorktreeHandoffBlocker,
  WorktreeHandoffDirection,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
  WorktreeSnapshot,
  WorktreeSummary,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  canReconnect,
  computerActionStateDot,
  computerActionStatusLabel,
  computerPermissionLabel,
  computerTargetGroupLabel,
  connectionStateDot,
  connectionStatusLabel,
} from './view-model.js'
import { runDesktopCommand } from './desktop-command.js'
import { GitReviewView, type DesktopGitBridge } from './git-review.js'

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

interface DesktopComputerBridge {
  getState(): Promise<ComputerControlSnapshot>
  refresh(): Promise<ComputerControlSnapshot>
  selectTarget(input: SelectComputerTargetInput): Promise<ComputerControlSnapshot>
  grantPendingActions(): Promise<ComputerControlSnapshot>
  pauseActions(): Promise<ComputerControlSnapshot>
  resumeActions(): Promise<ComputerControlSnapshot>
  revokeActions(): Promise<ComputerControlSnapshot>
  stop(): Promise<ComputerControlSnapshot>
  openPermissionSettings(kind: 'screen-recording' | 'accessibility'): Promise<void>
  onChanged(listener: (snapshot: ComputerControlSnapshot) => void): () => void
}

interface DesktopWorktreesBridge {
  list(): Promise<WorktreeSnapshot>
  reconcile(): Promise<WorktreeSnapshot>
  previewCleanup(input: DesktopWorktreeCleanupPreviewInput): Promise<WorktreeCleanupPreview>
  confirmCleanup(input: DesktopWorktreeCleanupConfirmInput): Promise<WorktreeCleanupResult>
  previewHandoff(input: DesktopWorktreeHandoffPreflightInput): Promise<WorktreeHandoffPreview>
  confirmHandoff(input: DesktopWorktreeHandoffConfirmInput): Promise<WorktreeHandoffResult>
  onChanged(listener: (snapshot: WorktreeSnapshot) => void): () => void
}

declare global {
  interface Window {
    dshDesktop?: {
      onCommand(listener: (command: DesktopRendererCommand) => void): () => void
      pickProjectDirectory(): Promise<string | null>
      git: DesktopGitBridge
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
  footerButton: {
    alignItems: 'center',
    background: 'transparent',
    border: 0,
    borderRadius: 4,
    color: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    font: 'inherit',
    gap: 8,
    minHeight: 32,
    padding: '6px 8px',
  },
  tabs: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    gap: 4,
    marginBottom: 20,
    paddingBottom: 10,
  },
  permissionList: { borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)', marginBottom: 22 },
  permissionRow: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'minmax(0, 1fr) auto 32px',
    minHeight: 52,
  },
  permissionName: { fontSize: 13, fontWeight: 600 },
  select: {
    appearance: 'auto',
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    boxSizing: 'border-box',
    color: 'inherit',
    font: 'inherit',
    minHeight: 36,
    padding: '6px 10px',
    width: '100%',
  },
  computerStatus: {
    alignItems: 'center',
    borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 20,
    paddingTop: 16,
  },
  computerSection: {
    borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'grid',
    gap: 12,
    marginTop: 20,
    paddingTop: 16,
  },
  computerSectionHeader: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  computerSectionTitle: { fontSize: 13, fontWeight: 650, lineHeight: '20px', margin: 0 },
  computerActions: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 },
  grantNotice: {
    alignItems: 'center',
    background: 'var(--dsw-alias-state-warning-secondary, #fff6df)',
    borderRadius: 4,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    padding: '12px 14px',
  },
  computerRecordList: { borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)' },
  computerRecord: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    minHeight: 48,
    padding: '6px 0',
  },
  computerRecordIdentity: { display: 'grid', gap: 1, minWidth: 0 },
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
    gridTemplateColumns: '72px minmax(0, 1fr)',
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

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The desktop operation failed.'
  const marker = 'Error invoking remote method'
  const index = error.message.indexOf(marker)
  return index < 0 ? error.message : error.message.slice(error.message.indexOf(':', index) + 1).trim()
}

function connectionMeta(connection: ConnectionSummary): string {
  return [connection.workspace, connection.account].filter(Boolean).join(' / ') || 'Linear'
}

function ConnectionsSection(): React.JSX.Element {
  const bridge = window.dshDesktop?.connections
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
      setError('The desktop connection bridge is unavailable.')
      setLoading(false)
      return
    }
    try {
      setSnapshot(await bridge.list())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
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
  }, [bridge])

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
      setError(errorMessage(cause))
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
        access: target?.access ?? access,
        ...(target?.label === undefined && label.trim().length === 0
          ? {}
          : { label: target?.label ?? label.trim() }),
        ...(target === undefined ? {} : { connectionId: target.id }),
      })
      setPendingOAuth({ requestId, flowId: result.flowId, expiresAt: result.expiresAt })
      setNotice({ ok: true, message: 'Waiting for Linear authorization.' })
    } catch (cause) {
      setError(errorMessage(cause))
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
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const reconnect = (connection: ConnectionSummary): void => {
    if (connection.authKind === 'oauth' && oauthAvailable) {
      void beginOAuth(connection)
      return
    }
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
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const sorted = useMemo(() => [...connections].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  ), [connections])

  return (
    <section style={styles.root} aria-labelledby="desktop-connections-heading">
      <header style={styles.header}>
        <h2 id="desktop-connections-heading" style={styles.heading}>Connections</h2>
        <div style={styles.toolbar}>
          <Button
            size="sm"
            variant="toolbar"
            icon={<IconRefreshOutline16 />}
            aria-label="Refresh connections"
            title="Refresh connections"
            disabled={loading}
            onClick={() => void refresh()}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlusOutline16 />}
            disabled={!vaultAvailable}
            onClick={() => {
              if (showForm) resetForm()
              else setShowForm(true)
            }}
          >
            Add Linear
          </Button>
        </div>
      </header>

      {showForm && (
        <form style={styles.form} onSubmit={event => void submitApiKey(event)}>
          <div style={styles.formHeader}>
            <h3 style={styles.formTitle}>{connectionId === undefined ? 'Connect Linear' : 'Reconnect Linear'}</h3>
            <Button
              type="button"
              size="sm"
              variant="toolbar"
              icon={<IconCloseOutline16 />}
              aria-label="Close connection form"
              title="Close"
              onClick={resetForm}
            />
          </div>
          <label style={styles.field}>
            <span style={styles.label}>Connection name</span>
            <Input
              value={label}
              maxLength={160}
              placeholder="Linear workspace"
              onChange={event => setLabel(event.currentTarget.value)}
            />
          </label>
          <div style={styles.field}>
            <span style={styles.label}>Access</span>
            <div style={styles.access} role="group" aria-label="Linear access mode">
              <Pill type="button" active={access === 'read-only'} onClick={() => setAccess('read-only')}>
                Read only
              </Pill>
              <Pill type="button" active={access === 'read-write'} onClick={() => setAccess('read-write')}>
                Read and write
              </Pill>
            </div>
          </div>
          <label style={styles.field}>
            <span style={styles.label}>Linear API key</span>
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
              Connect with API key
            </Button>
            {oauthAvailable && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== undefined}
                onClick={() => void beginOAuth()}
              >
                Continue with OAuth
              </Button>
            )}
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
              Cancel
            </Button>
          )}
        </div>
      )}

      {error !== undefined && (
        <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-error-secondary, #fef0ef)' }}>
          {error}
        </div>
      )}

      {loading && <div style={styles.empty}>Loading connections...</div>}
      {!loading && sorted.length === 0 && <div style={styles.empty}>No connections</div>}
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
                {connectionStatusLabel(connection.status)}
              </span>
            </div>
            <div style={styles.pills}>
              <Pill>{connection.access === 'read-only' ? 'Read only' : 'Read and write'}</Pill>
              <Pill>{connection.authKind === 'oauth' ? 'OAuth' : 'API key'}</Pill>
              {connection.scopes.map(scope => <Pill key={scope}>{scope}</Pill>)}
              {connection.enabledTools.length > 0 && <Pill>{connection.enabledTools.length} tools</Pill>}
            </div>
            {connection.statusMessage !== undefined && (
              <p style={styles.statusMessage}>{connection.statusMessage}</p>
            )}
            <div style={styles.itemBottom}>
              <span style={styles.metadata}>
                {connection.lastConnectedAt === undefined
                  ? 'Not connected yet'
                  : `Last connected ${new Date(connection.lastConnectedAt).toLocaleString()}`}
              </span>
              {confirmDisconnect === connection.id ? (
                <div style={styles.confirm}>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(undefined)}>Cancel</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === connection.id}
                    onClick={() => void disconnect(connection.id)}
                  >
                    Disconnect
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
                      onClick={() => reconnect(connection)}
                    >
                      Reconnect
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
                      Disconnect
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

function worktreeBranch(worktree: WorktreeSummary): string {
  const branch = worktree.branch ?? worktree.baseRef
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

function worktreeStatus(worktree: WorktreeSummary): {
  state: 'done' | 'warning' | 'ongoing' | 'error'
  label: string
} {
  if (worktree.lifecycle === 'provisioning') return { state: 'ongoing', label: 'Creating' }
  if (worktree.lifecycle === 'removing') return { state: 'ongoing', label: 'Cleaning up' }
  if (worktree.lifecycle === 'recovery-required') return { state: 'error', label: 'Needs attention' }
  if (worktree.lifecycle === 'orphaned') return { state: 'warning', label: 'Orphaned' }
  if (worktree.lifecycle === 'removed') return { state: 'done', label: 'Removed' }
  return { state: 'done', label: 'Ready' }
}

function worktreeRecoveryLabel(reason: WorktreeSummary['recoveryReason']): string | undefined {
  if (reason === undefined) return undefined
  const labels: Record<NonNullable<WorktreeSummary['recoveryReason']>, string> = {
    'create-ambiguous': 'Creation result is ambiguous',
    'interrupted-create': 'Creation was interrupted',
    'interrupted-remove': 'Cleanup was interrupted',
    'inspection-failed': 'Git inspection failed',
    'external-change': 'Checkout identity changed',
    locked: 'Managed lock changed',
    missing: 'Checkout is missing',
    moved: 'Branch moved to another checkout',
  }
  return labels[reason]
}

function handoffBlockerLabel(blocker: WorktreeHandoffBlocker): string {
  const labels: Record<WorktreeHandoffBlocker, string> = {
    'source-detached': 'The source checkout is detached.',
    'source-conflicts': 'Resolve source merge conflicts first.',
    'source-diverged': 'The source no longer descends from the managed base commit.',
    'destination-detached': 'The destination checkout is detached.',
    'destination-head-changed': 'The destination HEAD is no longer the managed base commit.',
    'destination-dirty': 'The destination contains changes. Preserve or remove them first.',
    'destination-collision': 'An ignored or untracked destination path collides with this transfer.',
    'no-changes': 'The source has no changes relative to the managed base commit.',
  }
  return labels[blocker]
}

function handoffFileStatus(status: WorktreeHandoffPreview['preflight']['files'][number]['status']): string {
  const labels = {
    added: 'Added',
    modified: 'Modified',
    deleted: 'Deleted',
    renamed: 'Renamed',
    copied: 'Copied',
    'type-changed': 'Type changed',
    unmerged: 'Conflict',
    untracked: 'Untracked',
  }
  return labels[status]
}

function WorktreesSection(): React.JSX.Element {
  const bridge = window.dshDesktop?.worktrees
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [cleanupPreviewingId, setCleanupPreviewingId] = useState<string>()
  const [cleanupPreview, setCleanupPreview] = useState<WorktreeCleanupPreview>()
  const [cleanupAcknowledged, setCleanupAcknowledged] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [handoffPreviewingKey, setHandoffPreviewingKey] = useState<string>()
  const [handoffPreview, setHandoffPreview] = useState<WorktreeHandoffPreview>()
  const [handoffAcknowledged, setHandoffAcknowledged] = useState(false)
  const [transferring, setTransferring] = useState(false)

  const applySnapshot = (next: WorktreeSnapshot): void => {
    setSnapshot(current => current === undefined || next.revision >= current.revision ? next : current)
  }

  const refresh = async (): Promise<void> => {
    if (bridge === undefined) {
      setError('The desktop worktree bridge is unavailable.')
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      applySnapshot(await bridge.reconcile())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (bridge === undefined) {
      setError('The desktop worktree bridge is unavailable.')
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
      if (active) setError(errorMessage(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])

  const inspectCleanup = async (worktreeId: string): Promise<void> => {
    if (bridge === undefined) return
    setCleanupPreviewingId(worktreeId)
    setError(undefined)
    setNotice(undefined)
    try {
      setCleanupPreview(await bridge.previewCleanup({ worktreeId }))
      setCleanupAcknowledged(false)
    } catch (cause) {
      setError(errorMessage(cause))
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
    if (bridge === undefined || cleanupPreview === undefined || !cleanupAcknowledged) return
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
      setError(errorMessage(cause))
    } finally {
      setCleaning(false)
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
      setError(errorMessage(cause))
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
        ? 'Local changes were staged in the managed worktree. The local checkout is unchanged.'
        : 'Worktree changes were staged in the local checkout. The managed worktree is unchanged.')
      applySnapshot(await bridge.list())
    } catch (cause) {
      setHandoffPreview(undefined)
      setHandoffAcknowledged(false)
      setError(errorMessage(cause))
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
        <h2 id="desktop-worktrees-heading" style={styles.heading}>Worktrees</h2>
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRefreshOutline16 />}
          aria-label="Recheck worktrees"
          title="Recheck worktrees"
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

      {!loading && worktrees.length === 0 && <div style={styles.empty}>No managed worktrees.</div>}
      <div style={styles.list}>
        {worktrees.map(worktree => {
          const status = worktreeStatus(worktree)
          const recovery = worktreeRecoveryLabel(worktree.recoveryReason)
          const cleanupAvailable = worktree.executionMode === 'worktree' &&
            (worktree.lifecycle === 'ready' || worktree.lifecycle === 'orphaned')
          const handoffAvailable = cleanupAvailable
          const operationsBusy = cleanupPreviewingId !== undefined || handoffPreviewingKey !== undefined ||
            cleaning || transferring
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
                <span style={styles.metadata}>Repository: {worktree.repositoryRoot}</span>
                <span style={styles.metadata}>
                  Base: {worktree.baseRef} at {worktree.baseCommit.slice(0, 12)}
                </span>
                {worktree.sessionId !== undefined && (
                  <span style={styles.metadata}>Session: {worktree.sessionId}</span>
                )}
                {recovery !== undefined && <p style={styles.statusMessage}>{recovery}</p>}
              </div>
              <div style={styles.itemBottom}>
                <span style={styles.metadata}>
                  {worktree.sessionState === 'bound' ? 'Session bound' : 'Awaiting session'}
                </span>
                <div style={styles.worktreeActions}>
                  {handoffAvailable && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconDownloadOutline16 />}
                      disabled={operationsBusy}
                      onClick={() => void inspectHandoff(worktree.id, 'local-to-worktree')}
                    >
                      Import local
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
                      Send to local
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
                      Clean up
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
        title="Clean up worktree"
        closeLabel="Close cleanup preview"
        description="The clean checkout directory will be removed. Its Git branch will be kept."
        footer={(
          <div style={styles.formActions}>
            <Button variant="outline" disabled={cleaning} onClick={closeCleanupPreview}>Cancel</Button>
            <Button
              variant="primary"
              icon={<IconTrashOutline16 />}
              disabled={!cleanupAcknowledged || cleaning}
              onClick={() => void confirmCleanup()}
            >
              Clean up
            </Button>
          </div>
        )}
      >
        {cleanupPreview !== undefined && (
          <div style={styles.worktreeConfirmBody}>
            <div style={styles.worktreeConfirmDetails}>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>Branch</span>
                <span style={styles.metadata}>{worktreeBranch(cleanupPreview.worktree)}</span>
              </div>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>Checkout</span>
                <span style={styles.metadata}>{cleanupPreview.inspection.worktreePath}</span>
              </div>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>Commit</span>
                <span style={styles.metadata}>{cleanupPreview.inspection.head}</span>
              </div>
            </div>
            <label style={styles.worktreeAcknowledge}>
              <input
                type="checkbox"
                checked={cleanupAcknowledged}
                disabled={cleaning}
                onChange={event => setCleanupAcknowledged(event.currentTarget.checked)}
                style={{ flex: '0 0 auto', height: 16, margin: '2px 0 0', width: 16 }}
              />
              <span>I understand this removes the checkout directory and keeps the branch.</span>
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={handoffPreview !== undefined}
        onClose={closeHandoffPreview}
        title={handoffPreview?.preflight.direction === 'worktree-to-local'
          ? 'Send changes to local checkout'
          : 'Import local changes'}
        closeLabel="Close handoff preview"
        description="Review the exact combined source tree before staging it in the destination checkout."
        footer={(
          <div style={styles.formActions}>
            <Button variant="outline" disabled={transferring} onClick={closeHandoffPreview}>
              {handoffPreview?.preflight.canTransfer === false ? 'Close' : 'Cancel'}
            </Button>
            {handoffPreview?.preflight.canTransfer === true && (
              <Button
                variant="primary"
                icon={<IconDownloadOutline16 />}
                disabled={!handoffAcknowledged || transferring}
                onClick={() => void confirmHandoff()}
              >
                Stage in destination
              </Button>
            )}
          </div>
        )}
      >
        {handoffPreview !== undefined && (
          <div style={styles.handoffScroll}>
            <div style={styles.handoffPath}>
              <span style={styles.label}>Source remains unchanged</span>
              <span style={styles.metadata}>{handoffPreview.preflight.source.path}</span>
            </div>
            <div style={styles.handoffPath}>
              <span style={styles.label}>Destination receives staged changes</span>
              <span style={styles.metadata}>{handoffPreview.preflight.destination.path}</span>
            </div>
            <div style={styles.worktreeConfirmDetails}>
              <div style={styles.worktreeDetail}>
                <span style={styles.label}>Base commit</span>
                <span style={styles.metadata}>{handoffPreview.preflight.baseCommit}</span>
              </div>
              {handoffPreview.preflight.sourceTree !== undefined && (
                <div style={styles.worktreeDetail}>
                  <span style={styles.label}>Reviewed source tree</span>
                  <span style={styles.metadata}>{handoffPreview.preflight.sourceTree}</span>
                </div>
              )}
            </div>
            {handoffPreview.preflight.blockers.length > 0 && (
              <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-warning-secondary, #fff6df)', marginBottom: 0 }}>
                {handoffPreview.preflight.blockers.map(blocker => (
                  <div key={blocker}>{handoffBlockerLabel(blocker)}</div>
                ))}
              </div>
            )}
            <div style={styles.field}>
              <span style={styles.label}>Files ({handoffPreview.preflight.files.length})</span>
              <div style={styles.handoffFiles}>
                {handoffPreview.preflight.files.map(file => (
                  <div key={file.path} style={styles.handoffFile}>
                    <span style={styles.label}>{handoffFileStatus(file.status)}</span>
                    <span style={styles.metadata}>
                      {file.originalPath === undefined ? file.path : `${file.originalPath} -> ${file.path}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {handoffPreview.preflight.patch !== '' && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Review patch</summary>
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
                  I understand the reviewed source tree will be staged in the destination. The source is unchanged,
                  and nothing is committed or pushed.
                </span>
              </label>
            )}
          </div>
        )}
      </Modal>
    </section>
  )
}

function PermissionRow({
  label,
  status,
  kind,
  bridge,
}: {
  label: string
  status: ComputerPermissionStatus
  kind: 'screen-recording' | 'accessibility'
  bridge: DesktopComputerBridge
}): React.JSX.Element {
  return (
    <div style={styles.permissionRow}>
      <span style={styles.permissionName}>{label}</span>
      <span style={styles.status}>
        <StateDot state={status === 'granted' ? 'done' : status === 'unavailable' ? 'warning' : 'error'} />
        {computerPermissionLabel(status)}
      </span>
      {status !== 'granted' && status !== 'unavailable' ? (
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRightUpOutline16 />}
          aria-label={`Open ${label} settings`}
          title={`Open ${label} settings`}
          onClick={() => void bridge.openPermissionSettings(kind)}
        />
      ) : <span />}
    </div>
  )
}

function ComputerSection(): React.JSX.Element {
  const bridge = window.dshDesktop?.computer
  const [snapshot, setSnapshot] = useState<ComputerControlSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = async (): Promise<void> => {
    if (bridge === undefined) {
      setError('The desktop computer bridge is unavailable.')
      setLoading(false)
      return
    }
    try {
      setSnapshot(await bridge.refresh())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    if (bridge === undefined) return
    return bridge.onChanged(next => {
      setSnapshot(next)
      setLoading(false)
    })
  }, [bridge])

  const selectTarget = async (targetId: string): Promise<void> => {
    if (bridge === undefined || targetId.length === 0) return
    setLoading(true)
    try {
      setSnapshot(await bridge.selectTarget({ targetId }))
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (bridge === undefined) return
    setLoading(true)
    try {
      setSnapshot(await bridge.stop())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const runActionControl = async (
    operation: 'grant' | 'pause' | 'resume' | 'revoke',
  ): Promise<void> => {
    if (bridge === undefined) return
    setLoading(true)
    try {
      const next = operation === 'grant'
        ? await bridge.grantPendingActions()
        : operation === 'pause'
          ? await bridge.pauseActions()
          : operation === 'resume'
            ? await bridge.resumeActions()
            : await bridge.revokeActions()
      setSnapshot(next)
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const groups: ComputerTargetKind[] = ['application', 'window', 'display']
  const permissions = snapshot?.permissions
  const grants = snapshot?.actionGrants ?? []
  const pendingGrant = snapshot?.pendingActionGrant
  const selectedForActions = snapshot?.selectedTarget !== undefined &&
    snapshot.selectedTarget.kind !== 'display'
  const actionState = snapshot?.acting === true
    ? { dot: 'ongoing' as const, label: 'Acting' }
    : snapshot?.auditAvailable === false
      ? { dot: 'error' as const, label: 'Audit unavailable' }
      : permissions?.canAct !== true
        ? { dot: 'error' as const, label: 'Permission required' }
        : !selectedForActions
          ? { dot: 'warning' as const, label: 'Observation only' }
          : snapshot?.actionsPaused !== false
            ? { dot: 'warning' as const, label: 'Paused' }
            : { dot: 'done' as const, label: 'Enabled' }
  return (
    <section style={styles.root} aria-labelledby="desktop-computer-heading">
      <header style={styles.header}>
        <h2 id="desktop-computer-heading" style={styles.heading}>Computer</h2>
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRefreshOutline16 />}
          aria-label="Refresh computer targets"
          title="Refresh computer targets"
          disabled={loading}
          onClick={() => void refresh()}
        />
      </header>

      {permissions !== undefined && bridge !== undefined && (
        <div style={styles.permissionList}>
          <PermissionRow
            label="Screen Recording"
            status={permissions.screenRecording}
            kind="screen-recording"
            bridge={bridge}
          />
          <PermissionRow
            label="Accessibility"
            status={permissions.accessibility}
            kind="accessibility"
            bridge={bridge}
          />
        </div>
      )}

      <label style={styles.field}>
        <span style={styles.label}>Observation target</span>
        <select
          style={styles.select}
          value={snapshot?.selectedTarget?.id ?? ''}
          disabled={loading || snapshot?.permissions.supported === false}
          onChange={event => void selectTarget(event.currentTarget.value)}
        >
          <option value="" disabled>Select an application, window, or display</option>
          {groups.map(kind => {
            const targets = snapshot?.targets.filter(target => target.kind === kind) ?? []
            return targets.length === 0 ? null : (
              <optgroup key={kind} label={computerTargetGroupLabel(kind)}>
                {targets.map(target => (
                  <option key={target.id} value={target.id}>
                    {target.applicationName === undefined ? target.name : `${target.applicationName} - ${target.name}`}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
      </label>

      {error !== undefined && (
        <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-error-secondary, #fef0ef)' }}>
          {error}
        </div>
      )}
      {snapshot?.statusMessage !== undefined && error === undefined && (
        <div role="status" style={styles.notice}>{snapshot.statusMessage}</div>
      )}

      <div style={styles.computerStatus}>
        <span style={styles.metadata}>
          {snapshot?.observing === true
            ? 'Observing'
            : snapshot?.acting === true
              ? 'Performing approved action'
            : snapshot?.lastObservation === undefined
              ? snapshot?.enabled === true ? 'Ready' : 'Stopped'
              : `Last observed ${new Date(snapshot.lastObservation.observedAt).toLocaleString()} / ` +
                `${snapshot.lastObservation.elementCount} elements`}
        </span>
        {snapshot?.enabled === true && (
          <Button
            size="sm"
            variant="outline"
            icon={<IconStopFill16 />}
            disabled={loading}
            onClick={() => void stop()}
          >
            Stop
          </Button>
        )}
      </div>

      <div style={styles.computerSection}>
        <div style={styles.computerSectionHeader}>
          <h3 style={styles.computerSectionTitle}>Computer actions</h3>
          <span style={styles.status}>
            <StateDot state={actionState.dot} />
            {actionState.label}
          </span>
        </div>

        <div style={styles.computerActions}>
          {grants.length > 0 && snapshot?.actionsPaused === false ? (
            <Button
              size="sm"
              variant="outline"
              icon={<IconPauseOutline16 />}
              disabled={loading}
              onClick={() => void runActionControl('pause')}
            >
              Pause
            </Button>
          ) : grants.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              icon={<IconPlayOutline16 />}
              disabled={loading || permissions?.canAct !== true || snapshot?.auditAvailable !== true}
              onClick={() => void runActionControl('resume')}
            >
              Resume
            </Button>
          ) : null}
          {(grants.length > 0 || pendingGrant !== undefined) && (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconTrashOutline16 />}
              disabled={loading}
              onClick={() => void runActionControl('revoke')}
            >
              Revoke
            </Button>
          )}
        </div>

        {snapshot?.auditAvailable === false && (
          <div role="alert" style={{ ...styles.notice, background: 'var(--dsw-alias-state-error-secondary, #fef0ef)', marginBottom: 0 }}>
            Action audit is unavailable. Computer actions are blocked.
          </div>
        )}

        {pendingGrant !== undefined && (
          <div style={styles.grantNotice}>
            <div style={styles.computerRecordIdentity}>
              <span style={styles.itemTitle}>{pendingGrant.application.name}</span>
              <span style={styles.metadata}>Session {pendingGrant.sessionId}</span>
            </div>
            <Button
              size="sm"
              variant="primary"
              icon={<IconCheckOutline16 />}
              disabled={loading || permissions?.canAct !== true || snapshot?.auditAvailable !== true}
              onClick={() => void runActionControl('grant')}
            >
              Allow for this session
            </Button>
          </div>
        )}

        {grants.length === 0 && pendingGrant === undefined && (
          <span style={styles.metadata}>No session grants</span>
        )}
        {grants.length > 0 && (
          <div style={styles.computerRecordList}>
            {grants.map(grant => (
              <div key={`${grant.sessionId}:${grant.application.id}`} style={styles.computerRecord}>
                <div style={styles.computerRecordIdentity}>
                  <span style={styles.permissionName}>{grant.application.name}</span>
                  <span style={styles.metadata}>Session {grant.sessionId}</span>
                </div>
                <span style={styles.metadata}>{new Date(grant.grantedAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={styles.computerSection}>
        <div style={styles.computerSectionHeader}>
          <h3 style={styles.computerSectionTitle}>Recent actions</h3>
          <span style={styles.metadata}>{snapshot?.recentActions.length ?? 0}</span>
        </div>
        {snapshot?.recentActions.length === 0 && <span style={styles.metadata}>No actions recorded</span>}
        {snapshot !== undefined && snapshot.recentActions.length > 0 && (
          <div style={styles.computerRecordList}>
            {snapshot.recentActions.map(action => (
              <div key={action.actionId} style={styles.computerRecord}>
                <div style={styles.computerRecordIdentity}>
                  <span style={styles.permissionName}>{action.kind} / {action.targetName}</span>
                  <span style={styles.metadata}>{new Date(action.updatedAt).toLocaleString()}</span>
                </div>
                <span style={styles.status}>
                  <StateDot state={computerActionStateDot(action.status)} />
                  {computerActionStatusLabel(action.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

const settingsListeners = new Set<(sectionId?: string) => void>()

function openDesktopSettings(sectionId?: string): void {
  for (const listener of settingsListeners) listener(sectionId)
}

function DesktopSettingsLauncher({ wide }: SidebarFooterActionOwnerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<'connections' | 'computer' | 'worktrees'>('connections')

  useEffect(() => {
    const listener = (sectionId?: string): void => {
      if (sectionId === 'computer') setSection('computer')
      else if (sectionId === 'worktrees') setSection('worktrees')
      else if (sectionId === undefined || sectionId === 'connections') setSection('connections')
      if (sectionId === undefined || sectionId === 'connections' || sectionId === 'computer' ||
        sectionId === 'worktrees') setOpen(true)
    }
    settingsListeners.add(listener)
    return () => { settingsListeners.delete(listener) }
  }, [])

  return (
    <>
      <button
        type="button"
        style={styles.footerButton}
        aria-label="Desktop settings"
        title="Desktop settings"
        onClick={() => setOpen(true)}
      >
        <IconSettingsOutline16 size={wide ? 14 : 18} />
        {wide && <span>Desktop</span>}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Desktop settings"
        closeLabel="Close desktop settings"
      >
        <div style={styles.tabs} role="tablist" aria-label="Desktop settings sections">
          <Pill
            type="button"
            role="tab"
            aria-selected={section === 'connections'}
            active={section === 'connections'}
            onClick={() => setSection('connections')}
          >
            Connections
          </Pill>
          <Pill
            type="button"
            role="tab"
            aria-selected={section === 'computer'}
            active={section === 'computer'}
            onClick={() => setSection('computer')}
          >
            Computer
          </Pill>
          <Pill
            type="button"
            role="tab"
            aria-selected={section === 'worktrees'}
            active={section === 'worktrees'}
            onClick={() => setSection('worktrees')}
          >
            Worktrees
          </Pill>
        </div>
        {section === 'connections' && <ConnectionsSection />}
        {section === 'computer' && <ComputerSection />}
        {section === 'worktrees' && <WorktreesSection />}
      </Modal>
    </>
  )
}

export const inject = ['slots', 'sessions', 'workspaces', 'layout']

export function apply(ctx: ClientContext): void {
  const bridge = window.dshDesktop
  if (bridge !== undefined) {
    ctx.effect(() => bridge.onCommand(command => {
      void runDesktopCommand({
        ctx,
        pickProjectDirectory: () => bridge.pickProjectDirectory(),
        openSettings: openDesktopSettings,
      }, command).catch(error => {
        console.warn('Desktop command failed:', error instanceof Error ? error.message : String(error))
      })
    }), 'dsh-desktop: native command bridge')
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'connections',
    order: 12,
    label: 'Connections',
  }, ConnectionsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'computer',
    order: 13,
    label: 'Computer',
  }, ComputerSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'worktrees',
    order: 14,
    label: 'Worktrees',
  }, WorktreesSection))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'review',
    order: 20,
    label: 'Review',
  }, (props: ConvViewProps) => <GitReviewView {...props} bridge={bridge?.git} />))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'desktop-settings',
    order: 10,
  }, DesktopSettingsLauncher))
}
