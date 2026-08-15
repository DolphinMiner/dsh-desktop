import type { CSSProperties, FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button,
  IconCloseOutline16,
  IconLinkOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
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
  DisconnectConnectionInput,
  DesktopRendererCommand,
} from '@dolphinminer/dsh-desktop-protocol'

import { canReconnect, connectionStateDot, connectionStatusLabel } from './view-model.js'

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

declare global {
  interface Window {
    dshDesktop?: {
      onCommand(listener: (command: DesktopRendererCommand) => void): () => void
      pickProjectDirectory(): Promise<string | null>
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
}

interface PendingOAuth {
  requestId: string
  flowId: string
  expiresAt: string
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The connection operation failed.'
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

const settingsListeners = new Set<(sectionId?: string) => void>()

function openDesktopSettings(sectionId?: string): void {
  for (const listener of settingsListeners) listener(sectionId)
}

function DesktopSettingsLauncher({ wide }: SidebarFooterActionOwnerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const listener = (sectionId?: string): void => {
      if (sectionId === undefined || sectionId === 'connections') setOpen(true)
    }
    settingsListeners.add(listener)
    return () => { settingsListeners.delete(listener) }
  }, [])

  return (
    <>
      <button
        type="button"
        style={styles.footerButton}
        aria-label="Connections"
        title="Connections"
        onClick={() => setOpen(true)}
      >
        <IconLinkOutline16 size={wide ? 14 : 18} />
        {wide && <span>Connections</span>}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Desktop settings"
        closeLabel="Close desktop settings"
      >
        <ConnectionsSection />
      </Modal>
    </>
  )
}

interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

function waitForSnapshot<T>(
  source: SnapshotSource<T>,
  ready: (snapshot: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const current = source.getSnapshot()
  if (ready(current)) return Promise.resolve(current)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let unsubscribe = (): void => undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      unsubscribe()
      result()
    }
    const removeSubscription = source.subscribe(() => {
      const snapshot = source.getSnapshot()
      if (ready(snapshot)) finish(() => resolve(snapshot))
    })
    unsubscribe = removeSubscription
    if (settled) {
      removeSubscription()
      return
    }
    timeout = setTimeout(() => {
      finish(() => reject(new Error('Harness state did not become ready in time.')))
    }, timeoutMs)
  })
}

async function runDesktopCommand(ctx: ClientContext, command: DesktopRendererCommand): Promise<void> {
  if (command.type === 'project.open') {
    const path = await window.dshDesktop?.pickProjectDirectory()
    if (path === undefined) throw new Error('The desktop directory picker is unavailable.')
    if (path === null) return
    const workspace = await ctx.workspaces.create({ path })
    ctx.workspaces.startSession(workspace.workspaceId)
    return
  }
  if (command.type === 'session.new') {
    ctx.workspaces.startSession()
    return
  }
  if (command.type === 'session.open') {
    const sessions = await waitForSnapshot(ctx.sessions.list, snapshot => snapshot.phase === 'ready')
    const sessionId = command.sessionId as SessionId
    if (sessions.byId[sessionId] === undefined) throw new Error('The requested session no longer exists.')
    ctx.sessions.open(sessionId)
    return
  }
  if (command.type === 'workspace.open') {
    const workspaces = await waitForSnapshot(ctx.workspaces.list, snapshot => snapshot.phase === 'ready')
    const workspace = workspaces.items.find(item => item.workspaceId === command.workspaceId)
    if (workspace === undefined) throw new Error('The requested workspace no longer exists.')
    ctx.workspaces.startSession(workspace.workspaceId)
    return
  }
  if (command.type === 'session.stop') {
    const sessionId = command.sessionId as SessionId | undefined ?? ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return
    const result = await ctx.sessions.binding(sessionId)?.session.cancel()
    if (result !== undefined && !result.ok) throw new Error(result.error.message)
    return
  }
  if (command.type === 'settings.open') {
    openDesktopSettings(command.sectionId)
    return
  }
  ctx.layout.toggleSidebar()
}

export const inject = ['slots', 'sessions', 'workspaces', 'layout']

export function apply(ctx: ClientContext): void {
  const bridge = window.dshDesktop
  if (bridge !== undefined) {
    ctx.effect(() => bridge.onCommand(command => {
      void runDesktopCommand(ctx, command).catch(error => {
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
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'desktop-connections',
    order: 10,
  }, DesktopSettingsLauncher))
}
