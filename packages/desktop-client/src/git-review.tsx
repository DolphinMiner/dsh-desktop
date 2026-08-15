import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'

import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button,
  IconRefreshOutline16,
  Input,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DesktopGitReviewInput,
  GitReviewFile,
  GitReviewScope,
  GitReviewSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'

import {
  parseGitReviewPatch,
  type ReviewDiffLine,
  type ReviewPatchFile,
} from './git-review-model.js'

export interface DesktopGitBridge {
  review(input: DesktopGitReviewInput): Promise<GitReviewSnapshot>
}

interface GitReviewViewProps extends ConvViewProps {
  bridge?: DesktopGitBridge
}

type ReviewScopeKind = GitReviewScope['kind']

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    height: '100%',
    minHeight: 0,
  },
  toolbar: {
    alignItems: 'center',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    minHeight: 52,
    padding: '8px 16px',
  },
  scopeSelect: {
    appearance: 'auto',
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    border: '1px solid var(--dsw-alias-border-l2, #deded9)',
    borderRadius: 4,
    color: 'inherit',
    font: 'inherit',
    height: 34,
    padding: '0 9px',
  },
  refInput: { maxWidth: 240, minWidth: 140 },
  repository: {
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 12,
    marginLeft: 'auto',
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  content: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)',
    minHeight: 0,
  },
  files: {
    borderRight: '1px solid var(--dsw-alias-border-l2, #deded9)',
    minHeight: 0,
    overflow: 'auto',
    padding: '8px 0',
  },
  fileButton: {
    alignItems: 'center',
    background: 'transparent',
    border: 0,
    color: 'inherit',
    cursor: 'pointer',
    display: 'grid',
    font: 'inherit',
    gap: 8,
    gridTemplateColumns: '24px minmax(0, 1fr)',
    minHeight: 36,
    padding: '6px 12px',
    textAlign: 'left',
    width: '100%',
  },
  fileStatus: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
  filePath: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  patch: { minHeight: 0, overflow: 'auto' },
  patchHeader: {
    alignItems: 'center',
    background: 'var(--dsw-alias-bg-base, #fff)',
    borderBottom: '1px solid var(--dsw-alias-border-l2, #deded9)',
    display: 'flex',
    gap: 8,
    minHeight: 42,
    padding: '0 14px',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  patchPath: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hunkHeader: {
    background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)',
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    lineHeight: '28px',
    padding: '0 12px',
  },
  diffLine: {
    display: 'grid',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    gridTemplateColumns: '48px 48px 18px minmax(max-content, 1fr)',
    lineHeight: '20px',
    minHeight: 20,
  },
  lineNumber: {
    borderRight: '1px solid var(--dsw-alias-border-l2, #deded9)',
    color: 'var(--dsw-alias-label-tertiary, #8a8d91)',
    padding: '0 7px',
    textAlign: 'right',
    userSelect: 'none',
  },
  marker: { textAlign: 'center', userSelect: 'none' },
  lineText: { paddingRight: 16, tabSize: 4, whiteSpace: 'pre' },
  state: {
    color: 'var(--dsw-alias-label-secondary, #5f6268)',
    fontSize: 13,
    lineHeight: '20px',
    padding: 24,
  },
}

const statusLabels: Record<GitReviewFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  unmerged: 'U',
  untracked: '?',
}

function lineStyle(line: ReviewDiffLine): CSSProperties {
  if (line.kind === 'addition') return { background: 'var(--dsw-alias-state-success-secondary, #ecf8ef)' }
  if (line.kind === 'deletion') return { background: 'var(--dsw-alias-state-error-secondary, #fef0ef)' }
  return {}
}

function lineMarker(line: ReviewDiffLine): string {
  if (line.kind === 'addition') return '+'
  if (line.kind === 'deletion') return '-'
  return line.kind === 'metadata' ? '\\' : ' '
}

function reviewErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return 'Git review failed.'
  const marker = 'Error invoking remote method'
  const markerIndex = cause.message.indexOf(marker)
  if (markerIndex < 0) return cause.message
  const separatorIndex = cause.message.indexOf(':', markerIndex)
  return separatorIndex < 0 ? 'Git review failed.' : cause.message.slice(separatorIndex + 1).trim()
}

function scopeFrom(kind: ReviewScopeKind, commitRef: string, baseRef: string): GitReviewScope | undefined {
  if (kind === 'unstaged' || kind === 'staged') return { kind }
  const ref = (kind === 'commit' ? commitRef : baseRef).trim()
  if (ref === '') return undefined
  return kind === 'commit' ? { kind, ref } : { kind, baseRef: ref }
}

export function GitReviewView({ bridge, sessionId, useSessions }: GitReviewViewProps): React.JSX.Element {
  const workspaceRoot = useSessions(state => state.byId[sessionId]?.cwd)
  const [scopeKind, setScopeKind] = useState<ReviewScopeKind>('unstaged')
  const [commitRef, setCommitRef] = useState('HEAD')
  const [baseRef, setBaseRef] = useState('main')
  const [requestedScope, setRequestedScope] = useState<GitReviewScope>({ kind: 'unstaged' })
  const [snapshot, setSnapshot] = useState<GitReviewSnapshot>()
  const [selectedPath, setSelectedPath] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    if (bridge === undefined || workspaceRoot === undefined) {
      setLoading(false)
      setError(bridge === undefined
        ? 'The desktop Git bridge is unavailable.'
        : 'This session has no workspace.')
      return () => { current = false }
    }
    setLoading(true)
    setError(undefined)
    void bridge.review({ sessionId, workspaceRoot, scope: requestedScope }).then(next => {
      if (!current) return
      setSnapshot(next)
      setSelectedPath(previous => next.files.some(file => file.path === previous)
        ? previous
        : next.files[0]?.path)
    }).catch(cause => {
      if (!current) return
      setError(reviewErrorMessage(cause))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [bridge, requestedScope, sessionId, workspaceRoot])

  const parsed = useMemo(() => {
    if (snapshot === undefined) return { files: [] as ReviewPatchFile[] }
    try {
      return { files: parseGitReviewPatch(snapshot.patch) }
    } catch (cause) {
      return {
        files: [] as ReviewPatchFile[],
        error: cause instanceof Error ? cause.message : 'Invalid Git patch.',
      }
    }
  }, [snapshot])
  const selected = snapshot?.files.find(file => file.path === selectedPath)
  const selectedPatch = parsed.files.find(file => file.path === selectedPath)

  const requestReview = (): void => {
    const scope = scopeFrom(scopeKind, commitRef, baseRef)
    if (scope === undefined) {
      setError('Enter a Git ref for this review scope.')
      return
    }
    setRequestedScope({ ...scope })
  }

  return (
    <section style={styles.root} aria-label="Git review">
      <div style={styles.toolbar}>
        <select
          style={styles.scopeSelect}
          aria-label="Review scope"
          value={scopeKind}
          onChange={event => setScopeKind(event.currentTarget.value as ReviewScopeKind)}
        >
          <option value="unstaged">Unstaged</option>
          <option value="staged">Staged</option>
          <option value="commit">Commit</option>
          <option value="branch">Branch</option>
        </select>
        {scopeKind === 'commit' && (
          <Input
            aria-label="Commit ref"
            style={styles.refInput}
            value={commitRef}
            maxLength={1024}
            spellCheck={false}
            onChange={event => setCommitRef(event.currentTarget.value)}
          />
        )}
        {scopeKind === 'branch' && (
          <Input
            aria-label="Base ref"
            style={styles.refInput}
            value={baseRef}
            maxLength={1024}
            spellCheck={false}
            onChange={event => setBaseRef(event.currentTarget.value)}
          />
        )}
        <Button
          size="sm"
          variant="toolbar"
          icon={<IconRefreshOutline16 />}
          disabled={loading}
          onClick={requestReview}
        >
          Refresh
        </Button>
        <span style={styles.repository} title={snapshot?.repository.root ?? workspaceRoot}>
          {snapshot?.repository.root ?? workspaceRoot}
        </span>
      </div>

      {error !== undefined && <div role="alert" style={styles.state}>{error}</div>}
      {error === undefined && loading && <div style={styles.state}>Loading changes...</div>}
      {error === undefined && !loading && snapshot?.files.length === 0 && (
        <div style={styles.state}>No changes in this scope.</div>
      )}
      {error === undefined && !loading && snapshot !== undefined && snapshot.files.length > 0 && (
        <div style={styles.content}>
          <nav style={styles.files} aria-label="Changed files">
            {snapshot.files.map(file => (
              <button
                key={file.path}
                type="button"
                style={{
                  ...styles.fileButton,
                  ...(file.path === selectedPath
                    ? { background: 'var(--dsw-alias-bg-layer-1, #f7f7f5)' }
                    : {}),
                }}
                title={file.path}
                aria-current={file.path === selectedPath ? 'true' : undefined}
                onClick={() => setSelectedPath(file.path)}
              >
                <span style={styles.fileStatus}>{statusLabels[file.status]}</span>
                <span style={styles.filePath}>{file.path}</span>
              </button>
            ))}
          </nav>
          <div style={styles.patch}>
            {selected !== undefined && (
              <div style={styles.patchHeader}>
                <span style={styles.patchPath}>{selected.path}</span>
                <Pill>{selected.status}</Pill>
              </div>
            )}
            {parsed.error !== undefined && <div role="alert" style={styles.state}>{parsed.error}</div>}
            {parsed.error === undefined && selected?.patchAvailable === false && (
              <div style={styles.state}>Untracked file content is not included in this review.</div>
            )}
            {parsed.error === undefined && selected?.patchAvailable !== false && selectedPatch?.binary === true && (
              <div style={styles.state}>Binary change</div>
            )}
            {parsed.error === undefined && selected?.patchAvailable !== false &&
              selectedPatch !== undefined && !selectedPatch.binary && selectedPatch.hunks.length === 0 && (
              <div style={styles.state}>No textual changes.</div>
            )}
            {parsed.error === undefined && selectedPatch?.hunks.map((hunk, hunkIndex) => (
              <div key={`${hunk.header}:${String(hunkIndex)}`}>
                <div style={styles.hunkHeader}>{hunk.header}</div>
                {hunk.lines.map((line, lineIndex) => (
                  <div
                    key={`${String(line.oldLine ?? '')}:${String(line.newLine ?? '')}:${String(lineIndex)}`}
                    style={{ ...styles.diffLine, ...lineStyle(line) }}
                  >
                    <span style={styles.lineNumber}>{line.oldLine ?? ''}</span>
                    <span style={styles.lineNumber}>{line.newLine ?? ''}</span>
                    <span style={styles.marker}>{lineMarker(line)}</span>
                    <span style={styles.lineText}>{line.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
