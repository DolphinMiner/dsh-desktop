import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_ERROR_MESSAGE_LENGTH = 2_000

export type GitServiceErrorCode =
  | 'BAD_OUTPUT'
  | 'CANCELLED'
  | 'GIT_FAILED'
  | 'INVALID_INPUT'
  | 'NOT_REPOSITORY'
  | 'OUTPUT_LIMIT'
  | 'TIMEOUT'
  | 'UNAVAILABLE'

export class GitServiceError extends Error {
  constructor(readonly code: GitServiceErrorCode, message: string) {
    super(message)
    this.name = 'GitServiceError'
  }
}

export interface GitRepositoryIdentity {
  root: string
  gitDir: string
  commonDir: string
}

export type GitStatusEntryKind =
  | 'ordinary'
  | 'renamed'
  | 'unmerged'
  | 'untracked'
  | 'ignored'

export interface GitStatusEntry {
  kind: GitStatusEntryKind
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
}

export interface GitStatusSnapshot {
  repository: GitRepositoryIdentity
  head?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  clean: boolean
  entries: GitStatusEntry[]
}

export interface GitServiceOptions {
  executable?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

interface GitCommandResult {
  stdout: Buffer
  stderr: Buffer
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
  return {
    ...environment,
    GCM_INTERACTIVE: 'Never',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PAGER: 'cat',
  }
}

function boundedInput(value: string, label: string): string {
  if (value.length === 0 || value.length > 4_096 || value.includes('\0')) {
    throw new GitServiceError('INVALID_INPUT', `${label} is invalid.`)
  }
  return value
}

function redactError(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|key|password)=)[^&\s]+/gi, '$1[redacted]')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

function parseCommandValue(result: GitCommandResult, label: string): string {
  const output = result.stdout.toString('utf8')
  if (!output.endsWith('\n')) {
    throw new GitServiceError('BAD_OUTPUT', `Git returned invalid ${label}.`)
  }
  const value = output.slice(0, -1)
  if (value.length === 0 || value.includes('\0')) {
    throw new GitServiceError('BAD_OUTPUT', `Git returned invalid ${label}.`)
  }
  return value
}

function splitFixed(value: string, count: number): string[] | undefined {
  const fields: string[] = []
  let remaining = value
  for (let index = 1; index < count; index += 1) {
    const separator = remaining.indexOf(' ')
    if (separator < 0) return undefined
    fields.push(remaining.slice(0, separator))
    remaining = remaining.slice(separator + 1)
  }
  fields.push(remaining)
  return fields
}

function statusPair(value: string): Pick<GitStatusEntry, 'indexStatus' | 'worktreeStatus'> | undefined {
  if (!/^[.MTADRCU]{2}$/.test(value)) return undefined
  return { indexStatus: value[0]!, worktreeStatus: value[1]! }
}

export function parseGitStatus(
  repository: GitRepositoryIdentity,
  output: Buffer,
): GitStatusSnapshot {
  const records = output.toString('utf8').split('\0')
  if (records.at(-1) === '') records.pop()
  let head: string | undefined
  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let sawHead = false
  let sawOid = false
  let sawUpstream = false
  let sawDivergence = false
  const entries: GitStatusEntry[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      if (sawOid || (value !== '(initial)' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid branch identity data.')
      }
      sawOid = true
      if (value !== '(initial)') head = value
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      if (sawHead || value.length === 0) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid branch head data.')
      }
      sawHead = true
      if (value !== '(detached)') branch = value
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      if (sawUpstream || record.length === '# branch.upstream '.length) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid upstream data.')
      }
      sawUpstream = true
      upstream = record.slice('# branch.upstream '.length)
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (sawDivergence || match === null) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid branch divergence data.')
      }
      ahead = Number(match[1])
      behind = Number(match[2])
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid branch divergence data.')
      }
      sawDivergence = true
      continue
    }
    if (record.startsWith('1 ')) {
      const fields = splitFixed(record.slice(2), 8)
      const pair = fields === undefined ? undefined : statusPair(fields[0]!)
      if (fields === undefined || pair === undefined || fields[7]!.length === 0) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid ordinary status entry.')
      }
      entries.push({ kind: 'ordinary', path: fields[7]!, ...pair })
      continue
    }
    if (record.startsWith('2 ')) {
      const fields = splitFixed(record.slice(2), 9)
      const pair = fields === undefined ? undefined : statusPair(fields[0]!)
      const originalPath = records[index + 1]
      if (fields === undefined || pair === undefined || fields[8]!.length === 0 ||
        originalPath === undefined || originalPath.length === 0) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid renamed status entry.')
      }
      entries.push({
        kind: 'renamed',
        path: fields[8]!,
        originalPath,
        ...pair,
      })
      index += 1
      continue
    }
    if (record.startsWith('u ')) {
      const fields = splitFixed(record.slice(2), 10)
      const pair = fields === undefined ? undefined : statusPair(fields[0]!)
      if (fields === undefined || pair === undefined || fields[9]!.length === 0) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid unmerged status entry.')
      }
      entries.push({ kind: 'unmerged', path: fields[9]!, ...pair })
      continue
    }
    if (record.startsWith('? ') || record.startsWith('! ')) {
      const path = record.slice(2)
      if (path.length === 0) throw new GitServiceError('BAD_OUTPUT', 'Git returned an empty status path.')
      entries.push({
        kind: record[0] === '?' ? 'untracked' : 'ignored',
        path,
        indexStatus: record[0]!,
        worktreeStatus: record[0]!,
      })
      continue
    }
    throw new GitServiceError('BAD_OUTPUT', 'Git returned an unknown porcelain status record.')
  }

  if (!sawOid || !sawHead || (sawDivergence && !sawUpstream)) {
    throw new GitServiceError('BAD_OUTPUT', 'Git returned incomplete branch status data.')
  }

  return {
    repository: { ...repository },
    ...(head === undefined ? {} : { head }),
    ...(branch === undefined ? {} : { branch }),
    ...(upstream === undefined ? {} : { upstream }),
    ahead,
    behind,
    clean: entries.length === 0,
    entries,
  }
}

export class GitService {
  private readonly executable: string
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number

  constructor(options: GitServiceOptions = {}) {
    this.executable = options.executable ?? 'git'
    this.timeoutMs = Math.max(10, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.maxOutputBytes = Math.max(64, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  }

  async discoverRepository(path: string, signal?: AbortSignal): Promise<GitRepositoryIdentity> {
    return this.discoverRepositoryBefore(path, signal, Date.now() + this.timeoutMs)
  }

  private async discoverRepositoryBefore(
    path: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<GitRepositoryIdentity> {
    const candidate = await this.canonicalDirectory(boundedInput(path, 'Repository path'))
    let rootValue: string
    let gitDirValue: string
    let commonDirValue: string
    try {
      const bare = parseCommandValue(await this.run([
        '-C', candidate,
        'rev-parse',
        '--is-bare-repository',
      ], signal, deadline), 'bare-repository state')
      if (bare !== 'false') {
        throw new GitServiceError('NOT_REPOSITORY', 'The selected directory is not a non-bare Git worktree.')
      }
      rootValue = parseCommandValue(await this.run([
        '-C', candidate,
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
      ], signal, deadline), 'repository root')
      gitDirValue = parseCommandValue(await this.run([
        '-C', candidate,
        'rev-parse',
        '--absolute-git-dir',
      ], signal, deadline), 'Git directory')
      commonDirValue = parseCommandValue(await this.run([
        '-C', candidate,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ], signal, deadline), 'Git common directory')
    } catch (error) {
      if (error instanceof GitServiceError && error.code === 'GIT_FAILED') {
        throw new GitServiceError('NOT_REPOSITORY', 'The selected directory is not a supported Git worktree.')
      }
      throw error
    }
    const [root, gitDir, commonDir] = await Promise.all([rootValue, gitDirValue, commonDirValue].map(async value =>
      this.canonicalPath(value!),
    ))
    return { root: root!, gitDir: gitDir!, commonDir: commonDir! }
  }

  async status(repositoryRoot: string, signal?: AbortSignal): Promise<GitStatusSnapshot> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const result = await this.run([
      '--no-optional-locks',
      '-C', repository.root,
      '-c', 'color.ui=false',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z',
    ], signal, deadline)
    return parseGitStatus(repository, result.stdout)
  }

  private async canonicalDirectory(path: string): Promise<string> {
    const canonical = await this.canonicalPath(path)
    const info = await stat(canonical).catch(() => undefined)
    if (info?.isDirectory() !== true) {
      throw new GitServiceError('INVALID_INPUT', 'The repository path is not an existing directory.')
    }
    return canonical
  }

  private async canonicalPath(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      throw new GitServiceError('INVALID_INPUT', 'Git returned a path that cannot be resolved safely.')
    }
  }

  private run(
    args: readonly string[],
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<GitCommandResult> {
    if (signal?.aborted === true) {
      return Promise.reject(new GitServiceError('CANCELLED', 'The Git operation was cancelled.'))
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return Promise.reject(new GitServiceError('TIMEOUT', 'The Git operation timed out.'))
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>
      try {
        child = spawn(this.executable, [...args], {
          detached: process.platform !== 'win32',
          env: gitEnvironment(),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch {
        reject(new GitServiceError('UNAVAILABLE', 'Git could not be started.'))
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let terminalError: GitServiceError | undefined
      let killTimer: NodeJS.Timeout | undefined
      let closed = false

      const kill = (force = false): void => {
        if (closed || child.pid === undefined) return
        const signalName = force ? 'SIGKILL' : 'SIGTERM'
        try {
          if (process.platform === 'win32') child.kill(signalName)
          else process.kill(-child.pid, signalName)
        } catch {
          child.kill(signalName)
        }
      }
      const fail = (error: GitServiceError): void => {
        if (terminalError !== undefined) return
        terminalError = error
        kill()
        killTimer = setTimeout(() => kill(true), 1_000)
        killTimer.unref()
      }
      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length
        if (outputBytes > this.maxOutputBytes) {
          fail(new GitServiceError('OUTPUT_LIMIT', 'Git returned more output than this operation allows.'))
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))

      const timeout = setTimeout(() => {
        fail(new GitServiceError('TIMEOUT', 'The Git operation timed out.'))
      }, remainingMs)
      timeout.unref()
      const abort = (): void => fail(new GitServiceError('CANCELLED', 'The Git operation was cancelled.'))
      signal?.addEventListener('abort', abort, { once: true })

      child.once('error', () => {
        fail(new GitServiceError('UNAVAILABLE', 'Git could not be started.'))
      })
      child.once('close', code => {
        closed = true
        clearTimeout(timeout)
        if (killTimer !== undefined) clearTimeout(killTimer)
        signal?.removeEventListener('abort', abort)
        if (terminalError !== undefined) {
          reject(terminalError)
          return
        }
        const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
        if (code !== 0) {
          const detail = redactError(result.stderr.toString('utf8'))
          reject(new GitServiceError(
            'GIT_FAILED',
            detail.length === 0 ? 'Git could not complete the operation.' : `Git failed: ${detail}`,
          ))
          return
        }
        resolve(result)
      })
    })
  }
}
