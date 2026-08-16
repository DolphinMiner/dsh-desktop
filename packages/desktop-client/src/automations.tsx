import type { CSSProperties, FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  Button,
  IconCheckOutline16,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconStopFill16,
  IconTrashOutline16,
  Input,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AutomationChangedNotice,
  AutomationDefinition,
  AutomationRunPhase,
  AutomationRunSummary,
  AutomationRunPage,
  AutomationTaskCenterSnapshot,
  AutomationState,
  ConnectionSnapshot,
  DesktopCancelAutomationRunInput,
  DesktopCreateAutomationInput,
  DesktopDeleteAutomationInput,
  DesktopListAutomationRunsInput,
  DesktopOpenAutomationSessionInput,
  DesktopQueueAutomationRunInput,
  DesktopSetAutomationStateInput,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  automationRunStateDot,
  automationStateDot,
} from './view-model.js'
import type { DesktopTranslate } from './locales.js'

export interface DesktopAutomationsBridge {
  list(): Promise<AutomationTaskCenterSnapshot>
  listRuns(input: DesktopListAutomationRunsInput): Promise<AutomationRunPage>
  create(input: DesktopCreateAutomationInput): Promise<AutomationTaskCenterSnapshot>
  setState(input: DesktopSetAutomationStateInput): Promise<AutomationTaskCenterSnapshot>
  delete(input: DesktopDeleteAutomationInput): Promise<AutomationTaskCenterSnapshot>
  queueRun(input: DesktopQueueAutomationRunInput): Promise<AutomationTaskCenterSnapshot>
  cancelRun(input: DesktopCancelAutomationRunInput): Promise<AutomationTaskCenterSnapshot>
  openSession(input: DesktopOpenAutomationSessionInput): Promise<void>
  onChanged(listener: (notice: AutomationChangedNotice) => void): () => void
}

interface AutomationTaskCenterProps {
  bridge?: DesktopAutomationsBridge
  pickProjectDirectory(): Promise<string | null>
  listConnections?(): Promise<ConnectionSnapshot>
  t: DesktopTranslate
}

const styles: Record<string, CSSProperties> = {
  root: {
    boxSizing: 'border-box',
    color: 'var(--dsw-alias-label-primary, #17191c)',
    letterSpacing: 0,
    margin: '0 auto',
    maxHeight: 'calc(100vh - 180px)',
    maxWidth: 760,
    overflowY: 'auto',
    padding: '8px 4px 40px',
    width: '100%',
  },
  header: {
    alignItems: 'flex-start',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  headingGroup: { display: 'grid', gap: 3 },
  heading: { fontSize: 20, fontWeight: 650, lineHeight: '28px', margin: 0 },
  meta: {
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 12,
    lineHeight: '18px',
    overflowWrap: 'anywhere',
  },
  toolbar: { alignItems: 'center', display: 'flex', gap: 8 },
  form: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 6,
    display: 'grid',
    gap: 14,
    marginBottom: 24,
    padding: 16,
  },
  formHeader: { alignItems: 'center', display: 'flex', justifyContent: 'space-between' },
  formTitle: { fontSize: 15, fontWeight: 650, lineHeight: '22px', margin: 0 },
  field: { display: 'grid', gap: 6, minWidth: 0 },
  fieldRow: {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  },
  label: { color: 'var(--dsw-alias-label-secondary, #5f6268)', fontSize: 12, fontWeight: 600 },
  textarea: {
    background: 'var(--dsw-alias-bg-layer-0, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    boxSizing: 'border-box',
    color: 'inherit',
    font: 'inherit',
    minHeight: 96,
    padding: '9px 10px',
    resize: 'vertical',
    width: '100%',
  },
  select: {
    appearance: 'auto',
    background: 'var(--dsw-alias-bg-layer-0, #fff)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    boxSizing: 'border-box',
    color: 'inherit',
    font: 'inherit',
    minHeight: 36,
    padding: '6px 10px',
    width: '100%',
  },
  projectRow: { alignItems: 'center', display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr) auto' },
  checkbox: { alignItems: 'flex-start', display: 'flex', fontSize: 13, gap: 8, lineHeight: '20px' },
  connectionList: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  warning: {
    background: 'var(--dsw-alias-state-warning-secondary, #fff6df)',
    borderRadius: 4,
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 12,
    lineHeight: '18px',
    padding: '10px 12px',
  },
  error: {
    background: 'var(--dsw-alias-state-error-secondary, #fef0ef)',
    borderRadius: 4,
    color: 'var(--dsw-alias-label-error, #b42318)',
    fontSize: 12,
    lineHeight: '18px',
    marginBottom: 16,
    overflowWrap: 'anywhere',
    padding: '10px 12px',
  },
  actions: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8 },
  section: { display: 'grid', gap: 10, marginTop: 24 },
  sectionHeader: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 14, fontWeight: 650, lineHeight: '20px', margin: 0 },
  item: {
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 6,
    display: 'grid',
    gap: 11,
    minWidth: 0,
    padding: 14,
  },
  itemTop: { alignItems: 'flex-start', display: 'flex', gap: 12, justifyContent: 'space-between' },
  identity: { display: 'grid', gap: 3, minWidth: 0 },
  title: { fontSize: 14, fontWeight: 650, lineHeight: '20px', overflowWrap: 'anywhere' },
  status: { alignItems: 'center', display: 'flex', flexShrink: 0, fontSize: 12, gap: 7 },
  facts: {
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  },
  fact: { display: 'grid', gap: 2, minWidth: 0 },
  factLabel: { color: 'var(--dsw-alias-label-tertiary, #85888d)', fontSize: 11, lineHeight: '16px' },
  factValue: { fontSize: 12, lineHeight: '18px', overflowWrap: 'anywhere' },
  itemBottom: { alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' },
  details: { borderTop: '1px solid var(--dsw-alias-border-l2, #deded9)', paddingTop: 8 },
  summary: { cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  eventList: { display: 'grid', gap: 6, marginTop: 10 },
  event: {
    alignItems: 'start',
    display: 'grid',
    fontSize: 11,
    gap: 8,
    gridTemplateColumns: '112px minmax(0, 1fr)',
    lineHeight: '17px',
  },
  empty: { color: 'var(--dsw-alias-label-secondary, #5f6268)', fontSize: 13, padding: '18px 2px' },
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const marker = 'Error invoking remote method'
  const index = error.message.indexOf(marker)
  return index < 0 ? error.message : error.message.slice(error.message.indexOf(':', index) + 1).trim()
}

function automationStateText(state: AutomationState, t: DesktopTranslate): string {
  if (state === 'enabled') return t('Scheduled')
  if (state === 'paused') return t('Paused')
  return t('Completed')
}

function automationRunPhaseText(phase: AutomationRunPhase, t: DesktopTranslate): string {
  if (phase === 'queued') return t('Queued')
  if (phase === 'dispatching') return t('Preparing workspace')
  if (phase === 'running') return t('Running')
  if (phase === 'succeeded') return t('Finished')
  if (phase === 'failed') return t('Failed')
  if (phase === 'cancelled') return t('Cancelled')
  if (phase === 'interrupted') return t('Interrupted')
  return t('Outcome uncertain')
}

function defaultOnceValue(): string {
  const date = new Date(Date.now() + 60 * 60 * 1_000)
  date.setSeconds(0, 0)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function scheduleLabel(definition: AutomationDefinition): string {
  if (definition.trigger.kind === 'once') return new Date(definition.trigger.at).toLocaleString()
  return `${definition.trigger.expression} (${definition.trigger.timeZone})`
}

function runWorkspace(run: AutomationRunSummary): string | undefined {
  const dispatch = [...run.events].reverse().find(event => event.type === 'dispatch')
  return dispatch?.type === 'dispatch' ? dispatch.workspacePath : undefined
}

function runDetail(run: AutomationRunSummary): string | undefined {
  const terminal = [...run.events].reverse().find(event => event.type === 'terminal')
  return terminal?.type === 'terminal' ? terminal.detail : undefined
}

function canOpenRun(run: AutomationRunSummary): boolean {
  return run.events.some(event => event.type === 'running')
}

function isActiveRun(run: AutomationRunSummary): boolean {
  return run.phase === 'queued' || run.phase === 'dispatching' || run.phase === 'running'
}

export function AutomationTaskCenter({
  bridge,
  pickProjectDirectory,
  listConnections,
  t,
}: AutomationTaskCenterProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AutomationTaskCenterSnapshot>()
  const revision = useRef(-1)
  const [olderRuns, setOlderRuns] = useState<AutomationRunSummary[]>([])
  const [nextBeforeRunId, setNextBeforeRunId] = useState<string>()
  const [connections, setConnections] = useState<ConnectionSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [showForm, setShowForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [triggerKind, setTriggerKind] = useState<'once' | 'cron'>('once')
  const [onceAt, setOnceAt] = useState(defaultOnceValue)
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [timeZone, setTimeZone] = useState(localTimeZone)
  const [executionMode, setExecutionMode] = useState<'worktree' | 'local'>('worktree')
  const [baseRef, setBaseRef] = useState('refs/heads/main')
  const [localAcknowledged, setLocalAcknowledged] = useState(false)
  const [concurrencyPolicy, setConcurrencyPolicy] = useState<'skip' | 'queue-one'>('skip')
  const [connectionIds, setConnectionIds] = useState<string[]>([])

  const definitions = useMemo(() => [...(snapshot?.automations ?? [])].sort((left, right) => {
    const order = { enabled: 0, paused: 1, completed: 2 }
    return order[left.state] - order[right.state] || left.name.localeCompare(right.name)
  }), [snapshot])
  const definitionIds = useMemo(() => new Set(definitions.map(item => item.id)), [definitions])
  const latestRun = useMemo(() => new Map(definitions.map(definition => [
    definition.id,
    snapshot?.recentRuns.find(run => run.automationId === definition.id),
  ])), [definitions, snapshot])
  const availableConnections = connections?.connections.filter(item => item.status === 'connected') ?? []
  const runs = [...(snapshot?.recentRuns ?? []), ...olderRuns]

  const applySnapshot = (next: AutomationTaskCenterSnapshot): void => {
    if (next.revision < revision.current) return
    revision.current = next.revision
    setSnapshot(next)
    setOlderRuns([])
    setNextBeforeRunId(next.totalRunCount > next.recentRuns.length
      ? next.recentRuns.at(-1)?.id
      : undefined)
  }

  const refresh = async (): Promise<void> => {
    if (bridge === undefined) {
      setError(t('The desktop automation bridge is unavailable.'))
      setLoading(false)
      return
    }
    try {
      applySnapshot(await bridge.list())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    if (listConnections !== undefined) {
      void listConnections().then(setConnections).catch(() => undefined)
    }
    if (bridge === undefined) return
    return bridge.onChanged(() => {
      void refresh()
    })
  }, [bridge, listConnections, t])

  const runMutation = async (
    key: string,
    operation: () => Promise<AutomationTaskCenterSnapshot>,
  ): Promise<boolean> => {
    setBusy(key)
    setError(undefined)
    try {
      applySnapshot(await operation())
      return true
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
      void refresh()
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const resetForm = (): void => {
    setShowForm(false)
    setName('')
    setPrompt('')
    setProjectPath('')
    setTriggerKind('once')
    setOnceAt(defaultOnceValue())
    setCron('0 9 * * 1-5')
    setTimeZone(localTimeZone())
    setExecutionMode('worktree')
    setBaseRef('refs/heads/main')
    setLocalAcknowledged(false)
    setConcurrencyPolicy('skip')
    setConnectionIds([])
  }

  const chooseProject = async (): Promise<void> => {
    const selected = await pickProjectDirectory()
    if (selected !== null) setProjectPath(selected)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (bridge === undefined) return
    const date = triggerKind === 'once' ? new Date(onceAt) : undefined
    if (triggerKind === 'once' && (date === undefined || Number.isNaN(date.getTime()))) {
      setError(t('Choose a valid run time.'))
      return
    }
    if (executionMode === 'local' && !localAcknowledged) {
      setError(t('Confirm local checkout execution before creating this automation.'))
      return
    }
    const created = await runMutation('create', async () => bridge.create({
      operationId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      name: name.trim(),
      prompt: prompt.trim(),
      projectPath,
      trigger: triggerKind === 'once'
        ? { kind: 'once', at: date!.toISOString() }
        : { kind: 'cron', expression: cron.trim(), timeZone: timeZone.trim() },
      execution: executionMode === 'local'
        ? { mode: 'local', localCheckoutAcknowledged: true }
        : { mode: 'worktree', baseRef: baseRef.trim() },
      concurrencyPolicy,
      skillIds: [],
      connectionIds,
    }))
    if (created) resetForm()
  }

  const setState = (definition: AutomationDefinition, state: 'enabled' | 'paused'): void => {
    if (bridge === undefined) return
    void runMutation(`state:${definition.id}`, () => bridge.setState({
      operationId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      automationId: definition.id,
      expectedRevision: definition.revision,
      state,
    }))
  }

  const deleteDefinition = (definition: AutomationDefinition): void => {
    if (bridge === undefined) return
    void runMutation(`delete:${definition.id}`, () => bridge.delete({
      operationId: crypto.randomUUID(),
      automationId: definition.id,
      expectedRevision: definition.revision,
    })).then(deleted => {
      if (deleted) setConfirmDelete(undefined)
    })
  }

  const queueRun = (automationId: string, retryOfRunId?: string): void => {
    if (bridge === undefined) return
    void runMutation(`run:${automationId}`, () => bridge.queueRun({
      operationId: crypto.randomUUID(),
      automationId,
      ...(retryOfRunId === undefined ? {} : { retryOfRunId }),
    }))
  }

  const cancelRun = (run: AutomationRunSummary): void => {
    if (bridge === undefined) return
    void runMutation(`cancel:${run.id}`, () => bridge.cancelRun({
      operationId: crypto.randomUUID(),
      runId: run.id,
    }))
  }

  const openRun = async (run: AutomationRunSummary): Promise<void> => {
    if (bridge === undefined) return
    setError(undefined)
    try {
      await bridge.openSession({ sessionId: run.payload.sessionId })
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
    }
  }

  const loadOlderRuns = async (): Promise<void> => {
    if (bridge === undefined || snapshot === undefined || nextBeforeRunId === undefined) return
    setBusy('runs:older')
    setError(undefined)
    try {
      const page = await bridge.listRuns({
        expectedRevision: snapshot.revision,
        beforeRunId: nextBeforeRunId,
        limit: 100,
      })
      if (page.revision !== snapshot.revision || page.totalRunCount !== snapshot.totalRunCount) {
        throw new Error(t('Automation history changed. Refresh Task Center and try again.'))
      }
      setOlderRuns(current => [...current, ...page.runs])
      setNextBeforeRunId(page.nextBeforeRunId)
    } catch (cause) {
      setError(errorMessage(cause, t('The desktop operation failed.')))
      void refresh()
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section style={styles.root} aria-label={t('Task Center')}>
      <div style={styles.header}>
        <div style={styles.headingGroup}>
          <h2 style={styles.heading}>{t('Task Center')}</h2>
          <span style={styles.meta}>{t('Runs while DSH Desktop is open')}</span>
        </div>
        <div style={styles.toolbar}>
          <Button
            size="sm"
            variant="toolbar"
            icon={<IconRefreshOutline16 />}
            aria-label={t('Refresh automations')}
            title={t('Refresh automations')}
            disabled={loading || busy !== undefined}
            onClick={() => void refresh()}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlusOutline16 />}
            onClick={() => setShowForm(value => !value)}
          >
            {t('New automation')}
          </Button>
        </div>
      </div>

      {error !== undefined && <div role="alert" style={styles.error}>{error}</div>}

      {showForm && (
        <form style={styles.form} onSubmit={event => void submit(event)}>
          <div style={styles.formHeader}>
            <h3 style={styles.formTitle}>{t('New automation')}</h3>
            <Button
              type="button"
              size="sm"
              variant="toolbar"
              icon={<IconCloseOutline16 />}
              aria-label={t('Close')}
              title={t('Close')}
              onClick={resetForm}
            />
          </div>
          <label style={styles.field}>
            <span style={styles.label}>{t('Name')}</span>
            <Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>{t('Prompt')}</span>
            <textarea
              required
              maxLength={100_000}
              style={styles.textarea}
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
            />
          </label>
          <div style={styles.field}>
            <span style={styles.label}>{t('Project')}</span>
            <div style={styles.projectRow}>
              <Input required readOnly value={projectPath} placeholder={t('Choose a Git project')} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                icon={<IconFolderOpenOutline16 />}
                onClick={() => void chooseProject()}
              >
                {t('Choose')}
              </Button>
            </div>
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.field}>
              <span style={styles.label}>{t('Schedule')}</span>
              <select style={styles.select} value={triggerKind} onChange={event => setTriggerKind(event.target.value as 'once' | 'cron')}>
                <option value="once">{t('Once')}</option>
                <option value="cron">{t('Recurring')}</option>
              </select>
            </label>
            {triggerKind === 'once' ? (
              <label style={styles.field}>
                <span style={styles.label}>{t('Run at')}</span>
                <Input required type="datetime-local" value={onceAt} onChange={event => setOnceAt(event.target.value)} />
              </label>
            ) : (
              <label style={styles.field}>
                <span style={styles.label}>{t('Time zone')}</span>
                <Input required value={timeZone} onChange={event => setTimeZone(event.target.value)} />
              </label>
            )}
          </div>
          {triggerKind === 'cron' && (
            <label style={styles.field}>
              <span style={styles.label}>{t('Cron')}</span>
              <Input required value={cron} onChange={event => setCron(event.target.value)} />
            </label>
          )}
          <div style={styles.fieldRow}>
            <label style={styles.field}>
              <span style={styles.label}>{t('Workspace')}</span>
              <select
                style={styles.select}
                value={executionMode}
                onChange={event => {
                  setExecutionMode(event.target.value as 'worktree' | 'local')
                  setLocalAcknowledged(false)
                }}
              >
                <option value="worktree">{t('Isolated worktree')}</option>
                <option value="local">{t('Local checkout')}</option>
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('Overlap')}</span>
              <select
                style={styles.select}
                value={concurrencyPolicy}
                onChange={event => setConcurrencyPolicy(event.target.value as 'skip' | 'queue-one')}
              >
                <option value="skip">{t('Skip while active')}</option>
                <option value="queue-one">{t('Queue one run')}</option>
              </select>
            </label>
          </div>
          {executionMode === 'worktree' ? (
            <label style={styles.field}>
              <span style={styles.label}>{t('Base ref')}</span>
              <Input required value={baseRef} onChange={event => setBaseRef(event.target.value)} />
            </label>
          ) : (
            <div style={styles.warning}>
              <label style={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={localAcknowledged}
                  onChange={event => setLocalAcknowledged(event.target.checked)}
                />
                <span>{t('I understand this automation can modify my current checkout.')}</span>
              </label>
            </div>
          )}
          {availableConnections.length > 0 && (
            <div style={styles.field}>
              <span style={styles.label}>{t('Connections')}</span>
              <div style={styles.connectionList}>
                {availableConnections.map(connection => (
                  <label key={connection.id} style={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={connectionIds.includes(connection.id)}
                      onChange={event => setConnectionIds(current => event.target.checked
                        ? [...current, connection.id]
                        : current.filter(id => id !== connection.id))}
                    />
                    <span>{connection.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div style={styles.actions}>
            <Button type="submit" variant="primary" disabled={busy !== undefined}>{t('Create')}</Button>
            <Button type="button" variant="ghost" onClick={resetForm}>{t('Cancel')}</Button>
          </div>
        </form>
      )}

      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={styles.sectionTitle}>{t('Automations')}</h3>
          <span style={styles.meta}>{definitions.length}</span>
        </div>
        {!loading && definitions.length === 0 && <div style={styles.empty}>{t('No automations')}</div>}
        {definitions.map(definition => {
          const latest = latestRun.get(definition.id)
          const operationBusy = busy?.endsWith(definition.id) === true
          return (
            <article key={definition.id} style={styles.item}>
              <div style={styles.itemTop}>
                <div style={styles.identity}>
                  <span style={styles.title}>{definition.name}</span>
                  <span style={styles.meta}>{definition.projectPath}</span>
                </div>
                <span style={styles.status}>
                  <StateDot state={automationStateDot(definition.state)} />
                  {automationStateText(definition.state, t)}
                </span>
              </div>
              <div style={styles.facts}>
                <span style={styles.fact}>
                  <span style={styles.factLabel}>{t('Schedule')}</span>
                  <span style={styles.factValue}>{scheduleLabel(definition)}</span>
                </span>
                <span style={styles.fact}>
                  <span style={styles.factLabel}>{t('Next run')}</span>
                  <span style={styles.factValue}>{definition.nextTriggerAt === undefined
                    ? t('None')
                    : new Date(definition.nextTriggerAt).toLocaleString()}</span>
                </span>
                <span style={styles.fact}>
                  <span style={styles.factLabel}>{t('Workspace')}</span>
                  <span style={styles.factValue}>{definition.execution.mode === 'worktree'
                    ? t('Worktree from {ref}', { ref: definition.execution.baseRef })
                    : t('Local checkout')}</span>
                </span>
                <span style={styles.fact}>
                  <span style={styles.factLabel}>{t('Latest run')}</span>
                  <span style={styles.factValue}>{latest === undefined
                    ? t('No recent run')
                    : automationRunPhaseText(latest.phase, t)}</span>
                </span>
              </div>
              <div style={styles.itemBottom}>
                <div style={styles.actions}>
                  {definition.state === 'enabled' && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconPauseOutline16 />}
                      disabled={operationBusy}
                      onClick={() => setState(definition, 'paused')}
                    >
                      {t('Pause')}
                    </Button>
                  )}
                  {definition.state === 'paused' && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconPlayOutline16 />}
                      disabled={operationBusy}
                      onClick={() => setState(definition, 'enabled')}
                    >
                      {t('Resume')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconPlayOutline16 />}
                    disabled={operationBusy}
                    onClick={() => queueRun(definition.id)}
                  >
                    {t('Run now')}
                  </Button>
                </div>
                {confirmDelete === definition.id ? (
                  <div style={styles.actions}>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(undefined)}>{t('Cancel')}</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconTrashOutline16 />}
                      disabled={operationBusy}
                      onClick={() => deleteDefinition(definition)}
                    >
                      {t('Delete')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="toolbar"
                    icon={<IconTrashOutline16 />}
                    aria-label={t('Delete {name}', { name: definition.name })}
                    title={t('Delete {name}', { name: definition.name })}
                    onClick={() => setConfirmDelete(definition.id)}
                  />
                )}
              </div>
            </article>
          )
        })}
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={styles.sectionTitle}>{t('Recent runs')}</h3>
          <span style={styles.meta}>{snapshot?.totalRunCount ?? 0}</span>
        </div>
        {!loading && runs.length === 0 && <div style={styles.empty}>{t('No runs')}</div>}
        {runs.map(run => {
          const workspace = runWorkspace(run)
          const detail = runDetail(run)
          const active = isActiveRun(run)
          const canRetry = !active && definitionIds.has(run.automationId) &&
            run.phase !== 'succeeded' && run.phase !== 'cancelled'
          return (
            <article key={run.id} style={styles.item}>
              <div style={styles.itemTop}>
                <div style={styles.identity}>
                  <span style={styles.title}>{run.payload.definitionName}</span>
                  <span style={styles.meta}>{new Date(run.updatedAt).toLocaleString()}</span>
                </div>
                <span style={styles.status}>
                  <StateDot state={automationRunStateDot(run.phase)} />
                  {run.cancellationRequested && active ? t('Stopping') : automationRunPhaseText(run.phase, t)}
                </span>
              </div>
              <div style={styles.facts}>
                <span style={styles.fact}>
                  <span style={styles.factLabel}>{t('Started by')}</span>
                  <span style={styles.factValue}>{run.payload.invocation.kind === 'manual' ? t('Manual') : t('Schedule')}</span>
                </span>
                <span style={styles.fact}>
                  <span style={styles.factLabel}>{t('Workspace')}</span>
                  <span style={styles.factValue}>{workspace ?? t('Not prepared')}</span>
                </span>
                {detail !== undefined && (
                  <span style={styles.fact}>
                    <span style={styles.factLabel}>{t('Result')}</span>
                    <span style={styles.factValue}>{detail}</span>
                  </span>
                )}
              </div>
              <div style={styles.itemBottom}>
                <div style={styles.actions}>
                  {canOpenRun(run) && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRightUpOutline16 />}
                      onClick={() => void openRun(run)}
                    >
                      {t('Open session')}
                    </Button>
                  )}
                  {active && !run.cancellationRequested && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconStopFill16 />}
                      disabled={busy === `cancel:${run.id}`}
                      onClick={() => cancelRun(run)}
                    >
                      {t('Cancel')}
                    </Button>
                  )}
                  {canRetry && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconRefreshOutline16 />}
                      disabled={busy === `run:${run.automationId}`}
                      onClick={() => queueRun(run.automationId, run.id)}
                    >
                      {t('Retry')}
                    </Button>
                  )}
                </div>
              </div>
              <details style={styles.details}>
                <summary style={styles.summary}>{t('Run log')}</summary>
                <div style={styles.eventList}>
                  {run.events.map(event => (
                    <div key={event.operationId} style={styles.event}>
                      <span style={styles.meta}>{new Date(event.at).toLocaleTimeString()}</span>
                      <span>{event.type === 'terminal' ? event.outcome : event.type}</span>
                    </div>
                  ))}
                </div>
              </details>
            </article>
          )
        })}
        {nextBeforeRunId !== undefined && (
          <div style={styles.actions}>
            <Button
              size="sm"
              variant="outline"
              icon={<IconRefreshOutline16 />}
              disabled={busy !== undefined}
              onClick={() => void loadOlderRuns()}
            >
              {t('Load older')}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
