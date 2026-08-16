import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'

import {
  IconChevronLeftOutline14,
  IconCloseOutline16,
  IconCodeOutline16,
  IconFolderClose16,
  IconFolderOpenOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DesktopFileListing,
  DesktopFilesListInput,
  DesktopTerminalStartInput,
  DesktopTerminalState,
  DesktopTerminalWriteInput,
} from '@dolphinminer/dsh-desktop-protocol'

import type { DesktopTranslate } from './locales.js'

export interface DesktopFilesBridge {
  list(input: DesktopFilesListInput): Promise<DesktopFileListing>
  open(input: { workspaceRoot: string; path: string }): Promise<{ opened: true }>
}

export interface DesktopTerminalBridge {
  getState(): Promise<DesktopTerminalState>
  start(input: DesktopTerminalStartInput): Promise<DesktopTerminalState>
  write(input: DesktopTerminalWriteInput): Promise<DesktopTerminalState>
  stop(): Promise<DesktopTerminalState>
  onData(listener: (data: string) => void): () => void
  onChanged(listener: (state: DesktopTerminalState) => void): () => void
}

function basename(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path
}

function AccessoryHeader({
  onBack,
  onClose,
  t,
  title,
}: {
  onBack(): void
  onClose(): void
  t: DesktopTranslate
  title: string
}): React.JSX.Element {
  return (
    <header className="dsh-desktop-accessory-header">
      <button
        type="button"
        className="dsh-desktop-accessory-header-button"
        aria-label={t('Back to tools')}
        onClick={onBack}
      >
        <IconChevronLeftOutline14 />
      </button>
      <span>{title}</span>
      <button
        type="button"
        className="dsh-desktop-accessory-header-button"
        aria-label={t('Close right sidebar')}
        onClick={onClose}
      >
        <IconCloseOutline16 />
      </button>
    </header>
  )
}

export function FilesAccessoryView({
  bridge,
  onBack,
  onClose,
  t,
  workspaceRoot,
}: {
  bridge?: DesktopFilesBridge
  onBack(): void
  onClose(): void
  t: DesktopTranslate
  workspaceRoot?: string
}): React.JSX.Element {
  const [path, setPath] = useState(workspaceRoot)
  const [listing, setListing] = useState<DesktopFileListing>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [refreshRevision, setRefreshRevision] = useState(0)

  useEffect(() => {
    setPath(workspaceRoot)
  }, [workspaceRoot])

  useEffect(() => {
    if (bridge === undefined || workspaceRoot === undefined || path === undefined) {
      setListing(undefined)
      return
    }
    let active = true
    setLoading(true)
    setError(undefined)
    void bridge.list({ workspaceRoot, path }).then(next => {
      if (active) setListing(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : t('Workspace files are unavailable.'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [bridge, path, refreshRevision, t, workspaceRoot])

  const openFile = (target: string): void => {
    if (bridge === undefined || workspaceRoot === undefined) return
    setError(undefined)
    void bridge.open({ workspaceRoot, path: target }).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('The file could not be opened.'))
    })
  }

  return (
    <section className="dsh-desktop-accessory-view" aria-label={t('Files')}>
      <AccessoryHeader onBack={onBack} onClose={onClose} t={t} title={t('Files')} />
      {workspaceRoot === undefined ? (
        <div className="dsh-desktop-accessory-empty">
          <IconFolderOpenOutline16 />
          <span>{t('Open a workspace to browse files.')}</span>
        </div>
      ) : (
        <div className="dsh-desktop-files">
          <div className="dsh-desktop-files-location">
            <button
              type="button"
              className="dsh-desktop-files-up"
              disabled={listing?.parent === undefined || loading}
              aria-label={t('Parent folder')}
              onClick={() => { if (listing?.parent !== undefined) setPath(listing.parent) }}
            >
              <IconChevronLeftOutline14 />
            </button>
            <span title={listing?.path ?? workspaceRoot}>{basename(listing?.path ?? workspaceRoot)}</span>
            <button
              type="button"
              className="dsh-desktop-files-up"
              disabled={loading}
              aria-label={t('Refresh files')}
              onClick={() => setRefreshRevision(revision => revision + 1)}
            >
              <IconRefreshOutline16 />
            </button>
          </div>
          <div className="dsh-desktop-files-list" aria-busy={loading}>
            {!loading && listing?.entries.length === 0 && (
              <div className="dsh-desktop-accessory-empty">{t('This folder is empty.')}</div>
            )}
            {listing?.entries.map(entry => (
              <button
                type="button"
                className="dsh-desktop-files-row"
                key={entry.path}
                title={entry.path}
                onClick={() => entry.kind === 'directory' ? setPath(entry.path) : openFile(entry.path)}
              >
                {entry.kind === 'directory' ? <IconFolderClose16 /> : <IconCodeOutline16 />}
                <span>{entry.name}</span>
              </button>
            ))}
          </div>
          {error !== undefined && <div className="dsh-desktop-accessory-error" role="alert">{error}</div>}
        </div>
      )}
    </section>
  )
}

export function TerminalAccessoryView({
  bridge,
  onBack,
  onClose,
  t,
  workspaceRoot,
}: {
  bridge?: DesktopTerminalBridge
  onBack(): void
  onClose(): void
  t: DesktopTranslate
  workspaceRoot?: string
}): React.JSX.Element {
  const [state, setState] = useState<DesktopTerminalState>({ running: false })
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string>()
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (bridge === undefined || workspaceRoot === undefined) return
    let active = true
    const append = (data: string): void => {
      if (!active) return
      setOutput(current => `${current}${data}`.slice(-200_000))
    }
    const offData = bridge.onData(append)
    const offChanged = bridge.onChanged(next => { if (active) setState(next) })
    setError(undefined)
    void bridge.start({ workspaceRoot }).then(next => {
      if (active) setState(next)
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : t('Workspace terminal is unavailable.'))
    })
    return () => {
      active = false
      offData()
      offChanged()
      void bridge.stop()
    }
  }, [bridge, t, workspaceRoot])

  useEffect(() => {
    const element = outputRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [output])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (bridge === undefined || !state.running || command.trim() === '') return
    const input = `${command}\n`
    setOutput(current => `${current}$ ${command}\n`.slice(-200_000))
    setCommand('')
    setError(undefined)
    void bridge.write({ data: input }).then(setState).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('The command could not be sent.'))
    })
  }

  const restart = (): void => {
    if (bridge === undefined || workspaceRoot === undefined) return
    setError(undefined)
    void bridge.start({ workspaceRoot }).then(setState).catch(cause => {
      setError(cause instanceof Error ? cause.message : t('Workspace terminal is unavailable.'))
    })
  }

  return (
    <section className="dsh-desktop-accessory-view" aria-label={t('Terminal')}>
      <AccessoryHeader onBack={onBack} onClose={onClose} t={t} title={t('Terminal')} />
      {workspaceRoot === undefined ? (
        <div className="dsh-desktop-accessory-empty">
          <IconCodeOutline16 />
          <span>{t('Open a workspace to start a terminal.')}</span>
        </div>
      ) : (
        <div className="dsh-desktop-terminal">
          <pre ref={outputRef} className="dsh-desktop-terminal-output" aria-live="polite">{output}</pre>
          {error !== undefined && <div className="dsh-desktop-accessory-error" role="alert">{error}</div>}
          <form className="dsh-desktop-terminal-input" onSubmit={submit}>
            <span aria-hidden="true">$</span>
            <input
              value={command}
              aria-label={t('Terminal command')}
              placeholder={state.running ? t('Run a command') : t('Terminal stopped')}
              disabled={!state.running}
              autoFocus
              onChange={event => setCommand(event.currentTarget.value)}
            />
            {!state.running && (
              <button type="button" onClick={restart}>{t('Restart')}</button>
            )}
          </form>
        </div>
      )}
    </section>
  )
}
