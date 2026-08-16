import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  DesktopFileListing,
  DesktopFilesListInput,
  DesktopTerminalStartInput,
  DesktopTerminalState,
  DesktopTerminalWriteInput,
} from '@dolphinminer/dsh-desktop-protocol'

import { resolveWorkspaceTarget, WorkspacePathError } from './workspace-path'

const MAX_FILE_ROWS = 1_000
const MAX_TERMINAL_EVENT_CHARS = 64 * 1024

async function workspaceDirectory(workspaceRoot: string, inputPath?: string): Promise<{
  root: string
  target: string
}> {
  let root: string
  let target: string
  try {
    root = await realpath(workspaceRoot)
    target = await realpath(inputPath === undefined
      ? root
      : isAbsolute(inputPath) ? inputPath : resolve(root, inputPath))
  } catch {
    throw new WorkspacePathError('NOT_FOUND', 'The requested workspace directory does not exist.')
  }
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new WorkspacePathError('BAD_MESSAGE', 'The requested directory is outside the active workspace.')
  }
  if (!(await stat(root)).isDirectory() || !(await stat(target)).isDirectory()) {
    throw new WorkspacePathError('BAD_MESSAGE', 'The requested workspace path is not a directory.')
  }
  return { root, target }
}

export class DesktopFilesController {
  constructor(private readonly openPath: (path: string) => Promise<void>) {}

  async list(input: DesktopFilesListInput): Promise<DesktopFileListing> {
    const { root, target } = await workspaceDirectory(input.workspaceRoot, input.path)
    const rows = await readdir(target, { withFileTypes: true })
    const visible = rows.filter(row => !row.name.startsWith('.') && (row.isDirectory() || row.isFile()))
    const entries = visible
      .slice(0, MAX_FILE_ROWS)
      .map(row => ({
        name: row.name,
        path: resolve(target, row.name),
        kind: row.isDirectory() ? 'directory' as const : 'file' as const,
      }))
      .sort((left, right) => left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === 'directory' ? -1 : 1)
    return {
      workspaceRoot: root,
      path: target,
      ...(target === root ? {} : { parent: dirname(target) }),
      entries,
      truncated: visible.length > MAX_FILE_ROWS,
    }
  }

  async open(workspaceRoot: string, path: string): Promise<void> {
    const target = await resolveWorkspaceTarget(workspaceRoot, path, { operation: 'open' })
    await this.openPath(target)
  }
}

interface DesktopTerminalControllerOptions {
  onData?: (data: string) => void
  onState?: (state: DesktopTerminalState) => void
  shellPath?: string
  shellArgs?: string[]
}

export class DesktopTerminalController {
  private child?: ChildProcessWithoutNullStreams
  private current: DesktopTerminalState = { running: false }

  constructor(private readonly options: DesktopTerminalControllerOptions = {}) {}

  snapshot(): DesktopTerminalState {
    return { ...this.current }
  }

  async start(input: DesktopTerminalStartInput): Promise<DesktopTerminalState> {
    const { root } = await workspaceDirectory(input.workspaceRoot)
    if (this.child !== undefined && this.current.running && this.current.cwd === root) return this.snapshot()
    await this.stop()

    const shellPath = this.options.shellPath ?? process.env.SHELL ?? '/bin/zsh'
    const child = spawn(shellPath, this.options.shellArgs ?? ['-l'], {
      cwd: root,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.publish({ running: true, cwd: root })
    const forward = (data: Buffer): void => {
      const text = data.toString('utf8')
      for (let offset = 0; offset < text.length; offset += MAX_TERMINAL_EVENT_CHARS) {
        this.options.onData?.(text.slice(offset, offset + MAX_TERMINAL_EVENT_CHARS))
      }
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.once('error', error => {
      if (this.child !== child) return
      this.child = undefined
      this.options.onData?.(`${error.message}\n`)
      this.publish({ running: false, cwd: root })
    })
    child.once('exit', code => {
      if (this.child !== child) return
      this.child = undefined
      this.publish({ running: false, cwd: root, ...(code === null ? {} : { exitCode: code }) })
    })
    return this.snapshot()
  }

  write(input: DesktopTerminalWriteInput): DesktopTerminalState {
    const child = this.child
    if (child === undefined || !this.current.running || child.stdin.destroyed) {
      throw new WorkspacePathError('CONFLICT', 'The workspace terminal is not running.')
    }
    child.stdin.write(input.data)
    return this.snapshot()
  }

  async stop(): Promise<DesktopTerminalState> {
    const child = this.child
    if (child === undefined) return this.snapshot()
    this.child = undefined
    child.kill('SIGTERM')
    await new Promise<void>(resolveStop => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveStop()
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolveStop()
      }, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveStop()
      })
    })
    if (this.child === undefined) {
      this.publish({ running: false, ...(this.current.cwd === undefined ? {} : { cwd: this.current.cwd }) })
    }
    return this.snapshot()
  }

  dispose(): Promise<DesktopTerminalState> {
    return this.stop()
  }

  private publish(state: DesktopTerminalState): void {
    this.current = state
    this.options.onState?.(this.snapshot())
  }
}
