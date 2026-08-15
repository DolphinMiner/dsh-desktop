import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, posix, win32 } from 'node:path'
import type { Readable } from 'node:stream'

import type {
  GitCommitResult,
  GitIndexMutationKind,
  GitPushResult,
  GitPushState,
  GitRepositoryIdentity,
  GitReviewFile,
  GitReviewScope,
  GitReviewSnapshot,
  GitStatusEntry,
  GitStatusSnapshot,
  WorktreeCleanupInspection,
  WorktreeHandoffDirection,
  WorktreeHandoffPreflight,
} from '@dolphinminer/dsh-desktop-protocol'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_ERROR_MESSAGE_LENGTH = 2_000
const MAX_MUTATION_PATHS = 256
const MAX_MUTATION_PATH_LENGTH = 4_096
const MAX_MUTATION_TOTAL_PATH_LENGTH = 65_536
const MAX_COMMIT_MESSAGE_LENGTH = 8_192
const MAX_GIT_REF_LENGTH = 1_024
const MAX_REMOTE_NAME_LENGTH = 256
const MAX_REMOTE_URL_LENGTH = 4_096

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

export interface GitServiceOptions {
  executable?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface GitCreateWorktreeInput {
  repositoryRoot: string
  worktreePath: string
  branch: string
  commit: string
  lockReason: string
}

export interface GitRemoveWorktreeInput {
  repositoryRoot: string
  worktreePath: string
  head: string
  branch: string
  lockReason: string
}

export type GitInspectWorktreeInput = Omit<GitRemoveWorktreeInput, 'head'>

export interface GitInspectWorktreeHandoffInput extends GitInspectWorktreeInput {
  baseCommit: string
  direction: WorktreeHandoffDirection
}

export type GitWorktreeHandoffInspection = Omit<WorktreeHandoffPreflight, 'worktree'>

interface InspectedManagedWorktree {
  repository: GitRepositoryIdentity
  target: string
  targetRepository: GitRepositoryIdentity
  entry: GitWorktreeEntry
  lockReason: string
}

interface InspectedWorktreeRemoval {
  repository: GitRepositoryIdentity
  target: string
  lockReason: string
  inspection: WorktreeCleanupInspection
}

export interface GitWorktreeEntry {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  pruneReason?: string
}

export type GitCommitExecutionResult = Omit<GitCommitResult, 'operationId'>
export type GitPushExecutionResult = Omit<GitPushResult, 'operationId'>

interface GitCommandResult {
  stdout: Buffer
  stderr: Buffer
}

function isRecordWithCode(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
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

function boundedCommitMessage(value: string): string {
  if (value.length > MAX_COMMIT_MESSAGE_LENGTH || value.trim().length === 0 || value.includes('\0')) {
    throw new GitServiceError('INVALID_INPUT', 'The Git commit message is invalid.')
  }
  return value
}

function boundedObjectId(value: string | undefined, label: string): string | undefined {
  if (value !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new GitServiceError('INVALID_INPUT', `${label} is invalid.`)
  }
  return value
}

function boundedRemoteName(value: string): string {
  if (value.length === 0 || value.length > MAX_REMOTE_NAME_LENGTH ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new GitServiceError('INVALID_INPUT', 'The Git remote name is invalid.')
  }
  return value
}

function boundedHeadRef(value: string, label: string): string {
  if (value.length === 0 || value.length > MAX_GIT_REF_LENGTH || !value.startsWith('refs/heads/') ||
    value.includes('\0') || /[\r\n]/.test(value)) {
    throw new GitServiceError('INVALID_INPUT', `${label} is invalid.`)
  }
  return value
}

function boundedTrackingRef(value: string): string {
  if (value.length === 0 || value.length > MAX_GIT_REF_LENGTH || !value.startsWith('refs/remotes/') ||
    value.includes('\0') || /[\r\n]/.test(value)) {
    throw new GitServiceError('INVALID_INPUT', 'The Git upstream tracking ref is invalid.')
  }
  return value
}

function sanitizeRemoteUrl(value: string): string {
  if (value.length === 0 || value.length > MAX_REMOTE_URL_LENGTH || value.includes('\0') || /[\r\n]/.test(value) ||
    value.startsWith('ext::')) {
    throw new GitServiceError('INVALID_INPUT', 'The Git push URL is not supported.')
  }
  if (isAbsolute(value)) return normalize(value)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new GitServiceError('INVALID_INPUT', 'The Git push URL is invalid.')
    }
    if (!['file:', 'git:', 'http:', 'https:', 'ssh:'].includes(parsed.protocol) ||
      (parsed.protocol !== 'file:' && parsed.hostname.length === 0)) {
      throw new GitServiceError('INVALID_INPUT', 'The Git push URL scheme is not supported.')
    }
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  }
  const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):([^\r\n]+)$/.exec(value)
  if (scp !== null && !scp[2]!.startsWith('-')) return `${scp[1]}:${scp[2]}`
  throw new GitServiceError('INVALID_INPUT', 'The Git push URL is not supported.')
}

function remoteUrlFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function samePushState(left: GitPushState, right: GitPushState): boolean {
  return left.remote === right.remote && left.remoteUrl === right.remoteUrl &&
    left.remoteUrlFingerprint === right.remoteUrlFingerprint && left.localBranch === right.localBranch &&
    left.localRef === right.localRef && left.remoteRef === right.remoteRef &&
    left.trackingRef === right.trackingRef && left.head === right.head &&
    left.upstreamHead === right.upstreamHead && left.ahead === right.ahead && left.behind === right.behind
}

function boundedMutationPaths(paths: readonly string[]): string[] {
  if (paths.length < 1 || paths.length > MAX_MUTATION_PATHS || new Set(paths).size !== paths.length) {
    throw new GitServiceError('INVALID_INPUT', 'The Git mutation path list is invalid.')
  }
  let totalLength = 0
  for (const path of paths) {
    totalLength += path.length
    if (path.length < 1 || path.length > MAX_MUTATION_PATH_LENGTH || path.includes('\0') ||
      path === '.' || posix.isAbsolute(path) || win32.isAbsolute(path) || posix.normalize(path) !== path ||
      path.split('/').includes('..')) {
      throw new GitServiceError('INVALID_INPUT', 'A Git mutation path is invalid.')
    }
  }
  if (totalLength > MAX_MUTATION_TOTAL_PATH_LENGTH) {
    throw new GitServiceError('INVALID_INPUT', 'The Git mutation path list is too large.')
  }
  return [...paths]
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

export function parseGitWorktreeList(output: Buffer): GitWorktreeEntry[] {
  const encoded = output.toString('utf8')
  if (!encoded.endsWith('\0')) {
    throw new GitServiceError('BAD_OUTPUT', 'Git returned an unterminated worktree list.')
  }
  const fields = encoded.split('\0')
  fields.pop()
  const groups: string[][] = []
  let group: string[] = []
  for (const field of fields) {
    if (field !== '') {
      group.push(field)
      continue
    }
    if (group.length === 0) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an empty worktree record.')
    }
    groups.push(group)
    group = []
  }
  if (group.length !== 0 || groups.length === 0) {
    throw new GitServiceError('BAD_OUTPUT', 'Git returned an incomplete worktree list.')
  }

  const entries = groups.map(record => {
    const values = new Map<string, string | true>()
    for (const field of record) {
      const separator = field.indexOf(' ')
      const key = separator < 0 ? field : field.slice(0, separator)
      const value = separator < 0 ? true : field.slice(separator + 1)
      if (!['worktree', 'HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable'].includes(key) ||
        values.has(key) || value === '') {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid worktree attribute.')
      }
      values.set(key, value)
    }
    const path = values.get('worktree')
    const head = values.get('HEAD')
    const branch = values.get('branch')
    const detached = values.get('detached') === true
    const bare = values.get('bare') === true
    const locked = values.has('locked')
    const lockReason = values.get('locked')
    const prunable = values.has('prunable')
    const pruneReason = values.get('prunable')
    if (typeof path !== 'string' || path.length > 4_096 || !isAbsolute(path) || normalize(path) !== path ||
      (head !== undefined && (typeof head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))) ||
      (branch !== undefined && (typeof branch !== 'string' || branch.length > 1_024 ||
        !branch.startsWith('refs/heads/') || /[\r\n]/.test(branch))) ||
      (typeof lockReason === 'string' && lockReason.length > 256) ||
      (typeof pruneReason === 'string' && pruneReason.length > MAX_ERROR_MESSAGE_LENGTH)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid worktree identity data.')
    }
    if (bare) {
      if (head !== undefined || branch !== undefined || detached) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid bare worktree data.')
      }
    } else if (typeof head !== 'string' || (typeof branch === 'string') === detached) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned incomplete worktree checkout data.')
    }
    return {
      path,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
      detached,
      bare,
      locked,
      ...(typeof lockReason === 'string' ? { lockReason } : {}),
      prunable,
      ...(typeof pruneReason === 'string' ? { pruneReason } : {}),
    }
  })
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) {
    throw new GitServiceError('BAD_OUTPUT', 'Git returned duplicate worktree paths.')
  }
  return entries
}

export function parseGitNameStatus(output: Buffer): GitReviewFile[] {
  if (output.length === 0) return []
  const encoded = output.toString('utf8')
  if (!encoded.endsWith('\0')) {
    throw new GitServiceError('BAD_OUTPUT', 'Git returned an unterminated changed-file list.')
  }
  const fields = encoded.split('\0')
  fields.pop()
  const files: GitReviewFile[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]!
    const kind = code[0]
    const status = kind === 'A'
      ? 'added'
      : kind === 'M'
        ? 'modified'
        : kind === 'D'
          ? 'deleted'
          : kind === 'T'
            ? 'type-changed'
            : kind === 'U'
              ? 'unmerged'
              : kind === 'R'
                ? 'renamed'
                : kind === 'C'
                  ? 'copied'
                  : undefined
    const scored = kind === 'R' || kind === 'C'
    if (status === undefined || (scored ? !/^[RC](?:100|[1-9]?\d)$/.test(code) : code !== kind)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid changed-file status.')
    }
    const firstPath = fields[index++]
    const secondPath = scored ? fields[index++] : undefined
    if (firstPath === undefined || firstPath.length === 0 || firstPath.length > 4_096 ||
      (scored && (secondPath === undefined || secondPath.length === 0 || secondPath.length > 4_096))) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid changed-file path.')
    }
    files.push(scored ? {
      status,
      path: secondPath!,
      originalPath: firstPath,
      patchAvailable: true,
    } : {
      status,
      path: firstPath,
      patchAvailable: true,
    })
  }
  if (new Set(files.map(file => file.path)).size !== files.length) {
    throw new GitServiceError('BAD_OUTPUT', 'Git returned duplicate changed-file paths.')
  }
  return files
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
    return this.statusBefore(repository, signal, deadline)
  }

  async mutateIndex(
    repositoryRoot: string,
    kind: GitIndexMutationKind,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitStatusSnapshot> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    if (kind !== 'stage' && kind !== 'unstage') {
      throw new GitServiceError('INVALID_INPUT', 'The Git index mutation kind is invalid.')
    }
    const safePaths = boundedMutationPaths(paths)
    let command: string[]
    if (kind === 'stage') {
      command = ['add', '--all', '--', ...safePaths]
    } else {
      const before = await this.statusBefore(repository, signal, deadline)
      command = before.head === undefined
        ? ['rm', '--cached', '--force', '--ignore-unmatch', '-r', '--', ...safePaths]
        : ['restore', '--staged', '--', ...safePaths]
    }
    await this.run([
      '--no-optional-locks',
      '--literal-pathspecs',
      '-C', repository.root,
      '-c', 'core.fsmonitor=false',
      ...command,
    ], signal, deadline)
    return this.statusBefore(repository, signal, deadline)
  }

  async revertWorktree(
    repositoryRoot: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<GitStatusSnapshot> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const [safePath] = boundedMutationPaths([path])
    await this.run([
      '--no-optional-locks',
      '--literal-pathspecs',
      '-C', repository.root,
      '-c', 'core.fsmonitor=false',
      'restore',
      '--worktree',
      '--',
      safePath!,
    ], signal, deadline)
    return this.statusBefore(repository, signal, deadline)
  }

  async indexTree(repositoryRoot: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    return this.indexTreeBefore(repository.root, signal, deadline)
  }

  async commit(
    repositoryRoot: string,
    message: string,
    expectedHead: string | undefined,
    expectedTree: string,
    signal?: AbortSignal,
  ): Promise<GitCommitExecutionResult> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const safeMessage = boundedCommitMessage(message)
    const safeHead = boundedObjectId(expectedHead, 'Expected Git HEAD')
    const safeTree = boundedObjectId(expectedTree, 'Expected Git index tree')!
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const before = await this.statusBefore(repository, signal, deadline)
    if (before.head !== safeHead) {
      throw new GitServiceError('GIT_FAILED', 'Git HEAD changed after the commit preview.')
    }
    if (await this.indexTreeBefore(repository.root, signal, deadline) !== safeTree) {
      throw new GitServiceError('GIT_FAILED', 'The Git index changed after the commit preview.')
    }
    await this.run([
      '--no-optional-locks',
      '-C', repository.root,
      '-c', 'color.ui=false',
      '-c', 'core.quotepath=false',
      '-c', 'core.fsmonitor=false',
      'commit',
      '--cleanup=verbatim',
      '--message', safeMessage,
    ], signal, deadline)
    const status = await this.statusBefore(repository, signal, deadline)
    const commit = status.head
    if (commit === undefined || commit === safeHead) {
      throw new GitServiceError('BAD_OUTPUT', 'Git reported success without creating a new commit.')
    }
    const parents = await this.commitParentsBefore(repository.root, commit, signal, deadline)
    if ((safeHead === undefined && parents.length !== 0) ||
      (safeHead !== undefined && parents[0] !== safeHead)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git created a commit from an unexpected parent.')
    }
    const committedTree = await this.resolveTreeBefore(repository.root, commit, signal, deadline)
    if (committedTree !== safeTree) {
      throw new GitServiceError('BAD_OUTPUT', 'Git committed content that differs from the reviewed index.')
    }
    const committedMessage = await this.commitMessageBefore(repository.root, commit, signal, deadline)
    const expectedMessage = safeMessage.endsWith('\n') ? safeMessage : `${safeMessage}\n`
    if (committedMessage !== expectedMessage) {
      throw new GitServiceError('BAD_OUTPUT', 'A Git hook changed the reviewed commit message.')
    }
    return { commit, status }
  }

  async pushTarget(repositoryRoot: string, signal?: AbortSignal): Promise<GitPushState> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    return this.pushStateBefore(repository, signal, deadline)
  }

  async push(
    repositoryRoot: string,
    expected: GitPushState,
    signal?: AbortSignal,
  ): Promise<GitPushExecutionResult> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const current = await this.pushStateBefore(repository, signal, deadline)
    if (!samePushState(current, expected)) {
      throw new GitServiceError('GIT_FAILED', 'The Git push target changed after approval.')
    }
    if (current.ahead < 1 || current.behind !== 0) {
      throw new GitServiceError('GIT_FAILED', 'The current branch is not safe to push without force.')
    }
    const rawUrl = await this.pushUrlBefore(repository.root, current.remote, signal, deadline)
    if (remoteUrlFingerprint(rawUrl) !== current.remoteUrlFingerprint || sanitizeRemoteUrl(rawUrl) !== current.remoteUrl) {
      throw new GitServiceError('GIT_FAILED', 'The Git push URL changed after approval.')
    }
    await this.runRemote([
      '--no-optional-locks',
      '-C', repository.root,
      '-c', 'color.ui=false',
      '-c', 'core.fsmonitor=false',
      'push',
      '--porcelain',
      '--no-force',
      rawUrl,
      `${current.head}:${current.remoteRef}`,
    ], rawUrl, current.remoteUrl, signal, deadline)
    const remoteHead = await this.remoteHeadBefore(
      repository.root,
      rawUrl,
      current.remoteUrl,
      current.remoteRef,
      signal,
      deadline,
    )
    if (remoteHead !== current.head) {
      throw new GitServiceError('BAD_OUTPUT', 'Git reported success but the remote ref has an unexpected commit.')
    }
    return { remote: current.remote, remoteRef: current.remoteRef, head: current.head }
  }

  private async pushStateBefore(
    repository: GitRepositoryIdentity,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<GitPushState> {
    const status = await this.statusBefore(repository, signal, deadline)
    if (status.branch === undefined || status.head === undefined) {
      throw new GitServiceError('GIT_FAILED', 'Push requires a checked-out branch with at least one commit.')
    }
    const localBranch = boundedInput(status.branch, 'Git branch')
    const localRef = boundedHeadRef(`refs/heads/${localBranch}`, 'The local Git branch ref')
    const refResult = await this.run([
      '-C', repository.root,
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
      localRef,
    ], signal, deadline)
    const encodedRef = refResult.stdout.toString('utf8')
    if (!encodedRef.endsWith('\n') || encodedRef.slice(0, -1).includes('\n')) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid upstream configuration.')
    }
    const fields = encodedRef.slice(0, -1).split('\0')
    if (fields.length !== 5 || fields.some(field => field.length === 0)) {
      throw new GitServiceError('GIT_FAILED', 'The current branch does not have a supported upstream.')
    }
    const [reportedLocalRef, reportedHead, remoteValue, remoteRefValue, trackingRefValue] = fields as [
      string, string, string, string, string,
    ]
    const remote = boundedRemoteName(remoteValue)
    const remoteRef = boundedHeadRef(remoteRefValue, 'The remote Git branch ref')
    const trackingRef = boundedTrackingRef(trackingRefValue)
    if (reportedLocalRef !== localRef || reportedHead !== status.head ||
      trackingRef !== `refs/remotes/${remote}/${remoteRef.slice('refs/heads/'.length)}`) {
      throw new GitServiceError('GIT_FAILED', 'The current branch has a non-standard upstream configuration.')
    }
    const rawUrl = await this.pushUrlBefore(repository.root, remote, signal, deadline)
    const remoteUrl = sanitizeRemoteUrl(rawUrl)
    const upstreamHead = await this.remoteHeadBefore(
      repository.root,
      rawUrl,
      remoteUrl,
      remoteRef,
      signal,
      deadline,
    )
    const divergence = await this.run([
      '-C', repository.root,
      'rev-list',
      '--left-right',
      '--count',
      `${upstreamHead}...${status.head}`,
    ], signal, deadline).catch(error => {
      if (error instanceof GitServiceError && error.code === 'GIT_FAILED') {
        throw new GitServiceError(
          'GIT_FAILED',
          'The live upstream commit is not available locally. Fetch the branch before pushing.',
        )
      }
      throw error
    })
    const match = /^(\d+)\s+(\d+)\n$/.exec(divergence.stdout.toString('utf8'))
    if (match === null) throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid branch divergence data.')
    const behind = Number(match[1])
    const ahead = Number(match[2])
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid branch divergence data.')
    }
    return {
      remote,
      remoteUrl,
      remoteUrlFingerprint: remoteUrlFingerprint(rawUrl),
      localBranch,
      localRef,
      remoteRef,
      trackingRef,
      head: status.head,
      upstreamHead,
      ahead,
      behind,
    }
  }

  private async pushUrlBefore(
    repositoryRoot: string,
    remote: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const safeRemote = boundedRemoteName(remote)
    const rawUrl = parseCommandValue(await this.run([
      '-C', repositoryRoot,
      'remote',
      'get-url',
      '--push',
      safeRemote,
    ], signal, deadline), 'push URL')
    sanitizeRemoteUrl(rawUrl)
    return rawUrl
  }

  private async remoteHeadBefore(
    repositoryRoot: string,
    rawUrl: string,
    displayUrl: string,
    remoteRef: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const safeRef = boundedHeadRef(remoteRef, 'The remote Git branch ref')
    const result = await this.runRemote([
      '-C', repositoryRoot,
      'ls-remote',
      '--refs',
      rawUrl,
      safeRef,
    ], rawUrl, displayUrl, signal, deadline)
    const output = result.stdout.toString('utf8')
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t([^\r\n]+)\n$/.exec(output)
    if (match === null || match[2] !== safeRef) {
      throw new GitServiceError('GIT_FAILED', 'The configured upstream branch does not exist on the push remote.')
    }
    return match[1]!
  }

  private async statusBefore(
    repository: GitRepositoryIdentity,
    signal: AbortSignal | undefined,
    deadline: number,
    includeIgnored = false,
  ): Promise<GitStatusSnapshot> {
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
      ...(includeIgnored ? ['--ignored=matching'] : []),
      '-z',
    ], signal, deadline)
    return parseGitStatus(repository, result.stdout)
  }

  private async indexTreeBefore(
    repositoryRoot: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const tree = parseCommandValue(await this.run([
      '--no-optional-locks',
      '-C', repositoryRoot,
      'write-tree',
    ], signal, deadline), 'index tree identity')
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid index tree identity.')
    }
    return tree
  }

  private async resolveTreeBefore(
    repositoryRoot: string,
    commit: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const tree = parseCommandValue(await this.run([
      '-C', repositoryRoot,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${commit}^{tree}`,
    ], signal, deadline), 'commit tree identity')
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid commit tree identity.')
    }
    return tree
  }

  private async commitParentsBefore(
    repositoryRoot: string,
    commit: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string[]> {
    const value = parseCommandValue(await this.run([
      '-C', repositoryRoot,
      'rev-list',
      '--parents',
      '--max-count=1',
      commit,
    ], signal, deadline), 'commit parent data')
    const identities = value.split(' ')
    if (identities[0] !== commit || identities.some(identity =>
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity))) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid commit parent data.')
    }
    return identities.slice(1)
  }

  private async commitMessageBefore(
    repositoryRoot: string,
    commit: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const result = await this.run([
      '-C', repositoryRoot,
      'cat-file',
      'commit',
      commit,
    ], signal, deadline)
    const value = result.stdout.toString('utf8')
    const separator = value.indexOf('\n\n')
    if (separator < 0) throw new GitServiceError('BAD_OUTPUT', 'Git returned invalid commit object data.')
    return value.slice(separator + 2)
  }

  async resolveCommit(repositoryRoot: string, ref: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const boundedRef = boundedInput(ref, 'Git base ref')
    if (boundedRef.length > 1_024 || /[\r\n]/.test(boundedRef)) {
      throw new GitServiceError('INVALID_INPUT', 'Git base ref is invalid.')
    }
    const commit = parseCommandValue(await this.run([
      '-C', repository.root,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${boundedRef}^{commit}`,
    ], signal, deadline), 'commit identity')
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid commit identity.')
    }
    return commit
  }

  async listWorktrees(repositoryRoot: string, signal?: AbortSignal): Promise<GitWorktreeEntry[]> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    return this.listWorktreesBefore(repository.root, signal, deadline)
  }

  private async listWorktreesBefore(
    repositoryRoot: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<GitWorktreeEntry[]> {
    const result = await this.run([
      '--no-optional-locks',
      '-C', repositoryRoot,
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ], signal, deadline)
    return parseGitWorktreeList(result.stdout)
  }

  async review(
    repositoryRoot: string,
    scope: GitReviewScope,
    signal?: AbortSignal,
  ): Promise<GitReviewSnapshot> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const statusResult = await this.run([
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
    const status = parseGitStatus(repository, statusResult.stdout)
    const diffOptions = [
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--find-copies',
      '--full-index',
      '--submodule=short',
    ]
    let nameArgs: string[]
    let patchArgs: string[]
    let selectedCommit: string | undefined
    let baseCommit: string | undefined
    let mergeBase: string | undefined

    if (scope.kind === 'unstaged') {
      nameArgs = ['diff', ...diffOptions, '--name-status', '-z', '--']
      patchArgs = ['diff', ...diffOptions, '--patch', '--']
    } else if (scope.kind === 'staged') {
      nameArgs = ['diff', '--cached', ...diffOptions, '--name-status', '-z', '--']
      patchArgs = ['diff', '--cached', ...diffOptions, '--patch', '--']
    } else if (scope.kind === 'commit') {
      selectedCommit = await this.resolveCommitBefore(repository.root, scope.ref, signal, deadline)
      nameArgs = [
        'diff-tree', '--root', '--no-commit-id', '-r', '--find-renames', '--find-copies',
        '--name-status', '-z', selectedCommit, '--',
      ]
      patchArgs = ['show', '--format=', ...diffOptions, '--patch', selectedCommit, '--']
    } else {
      if (status.head === undefined) {
        throw new GitServiceError('GIT_FAILED', 'A branch review requires a committed HEAD.')
      }
      baseCommit = await this.resolveCommitBefore(repository.root, scope.baseRef, signal, deadline)
      mergeBase = parseCommandValue(await this.run([
        '-C', repository.root,
        'merge-base',
        status.head,
        baseCommit,
      ], signal, deadline), 'merge-base identity')
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeBase)) {
        throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid merge-base identity.')
      }
      nameArgs = ['diff', ...diffOptions, '--name-status', '-z', mergeBase, status.head, '--']
      patchArgs = ['diff', ...diffOptions, '--patch', mergeBase, status.head, '--']
    }
    const [names, patchResult] = await Promise.all([
      this.run(['--no-optional-locks', '-C', repository.root, '-c', 'color.ui=false', ...nameArgs], signal, deadline),
      this.run(['--no-optional-locks', '-C', repository.root, '-c', 'color.ui=false', ...patchArgs], signal, deadline),
    ])
    const files = parseGitNameStatus(names.stdout)
    if (scope.kind === 'unstaged') {
      for (const entry of status.entries) {
        if (entry.kind !== 'untracked' || files.some(file => file.path === entry.path)) continue
        files.push({ status: 'untracked', path: entry.path, patchAvailable: false })
      }
    }
    const patch = patchResult.stdout.toString('utf8')
    if (patch.includes('\0')) throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid patch payload.')
    return {
      repository,
      scope,
      ...(status.head === undefined ? {} : { head: status.head }),
      ...(selectedCommit === undefined ? {} : { selectedCommit }),
      ...(baseCommit === undefined ? {} : { baseCommit }),
      ...(mergeBase === undefined ? {} : { mergeBase }),
      files,
      patch,
    }
  }

  async createWorktree(
    input: GitCreateWorktreeInput,
    signal?: AbortSignal,
  ): Promise<GitRepositoryIdentity> {
    const deadline = Date.now() + this.timeoutMs
    const requestedRoot = await this.canonicalDirectory(boundedInput(input.repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const target = boundedInput(input.worktreePath, 'Worktree path')
    if (!isAbsolute(target) || normalize(target) !== target) {
      throw new GitServiceError('INVALID_INPUT', 'The worktree path must be normalized and absolute.')
    }
    const parent = await this.canonicalDirectory(dirname(target))
    if (join(parent, basename(target)) !== target) {
      throw new GitServiceError('INVALID_INPUT', 'The worktree path parent changed during validation.')
    }
    try {
      await lstat(target)
      throw new GitServiceError('INVALID_INPUT', 'The worktree path already exists.')
    } catch (error) {
      if (error instanceof GitServiceError) throw error
      if (!isRecordWithCode(error) || error.code !== 'ENOENT') {
        throw new GitServiceError('INVALID_INPUT', 'The worktree path could not be inspected safely.')
      }
    }
    const branch = boundedInput(input.branch, 'Worktree branch')
    const lockReason = boundedInput(input.lockReason, 'Worktree lock reason')
    if (branch.length > 1_024 || /[\r\n]/.test(branch) || lockReason.length > 256 || /[\r\n]/.test(lockReason) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)) {
      throw new GitServiceError('INVALID_INPUT', 'The worktree creation request is invalid.')
    }
    await this.run([
      '-C', repository.root,
      'check-ref-format',
      '--branch',
      branch,
    ], signal, deadline)
    await this.run([
      '-C', repository.root,
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--no-track',
      '--lock',
      '--reason', lockReason,
      '-b', branch,
      target,
      input.commit,
    ], signal, deadline)
    const created = await this.discoverRepositoryBefore(target, signal, deadline)
    if (created.root !== target || created.commonDir !== repository.commonDir) {
      throw new GitServiceError('GIT_FAILED', 'Git created a worktree with an unexpected repository identity.')
    }
    const createdHead = await this.resolveCommitBefore(created.root, 'HEAD', signal, deadline)
    if (createdHead !== input.commit) {
      throw new GitServiceError('GIT_FAILED', 'Git created a worktree at an unexpected commit.')
    }
    return created
  }

  async inspectWorktreeForRemoval(
    input: GitInspectWorktreeInput,
    signal?: AbortSignal,
  ): Promise<WorktreeCleanupInspection> {
    const deadline = Date.now() + this.timeoutMs
    return (await this.inspectWorktreeForRemovalBefore(input, signal, deadline)).inspection
  }

  async inspectWorktreeHandoff(
    input: GitInspectWorktreeHandoffInput,
    signal?: AbortSignal,
  ): Promise<GitWorktreeHandoffInspection> {
    const deadline = Date.now() + this.timeoutMs
    if (input.direction !== 'local-to-worktree' && input.direction !== 'worktree-to-local') {
      throw new GitServiceError('INVALID_INPUT', 'The worktree handoff direction is invalid.')
    }
    const baseCommit = boundedObjectId(input.baseCommit, 'Worktree base commit')!
    const managed = await this.inspectManagedWorktreeBefore(input, signal, deadline)
    if (await this.resolveCommitBefore(managed.repository.root, baseCommit, signal, deadline) !== baseCommit) {
      throw new GitServiceError('GIT_FAILED', 'The managed worktree base commit changed.')
    }
    const [localStatus, worktreeStatus] = await Promise.all([
      this.statusBefore(managed.repository, signal, deadline),
      this.statusBefore(managed.targetRepository, signal, deadline),
    ])
    if (worktreeStatus.head !== managed.entry.head) {
      throw new GitServiceError('GIT_FAILED', 'The managed worktree changed during handoff preflight.')
    }
    const sourceStatus = input.direction === 'local-to-worktree' ? localStatus : worktreeStatus
    const destinationStatus = input.direction === 'local-to-worktree' ? worktreeStatus : localStatus
    const sourceRepository = input.direction === 'local-to-worktree'
      ? managed.repository
      : managed.targetRepository
    const destinationRepository = input.direction === 'local-to-worktree'
      ? managed.targetRepository
      : managed.repository
    const sourceKind = input.direction === 'local-to-worktree' ? 'local' as const : 'worktree' as const
    const destinationKind = input.direction === 'local-to-worktree' ? 'worktree' as const : 'local' as const
    const diffOptions = [
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--find-copies',
      '--full-index',
      '--submodule=short',
    ]
    const [names, patchResult] = await Promise.all([
      this.run([
        '--no-optional-locks', '-C', sourceRepository.root, '-c', 'color.ui=false',
        'diff', ...diffOptions, '--name-status', '-z', baseCommit, '--',
      ], signal, deadline),
      this.run([
        '--no-optional-locks', '-C', sourceRepository.root, '-c', 'color.ui=false',
        'diff', ...diffOptions, '--patch', baseCommit, '--',
      ], signal, deadline),
    ])
    const files = parseGitNameStatus(names.stdout)
    for (const entry of sourceStatus.entries) {
      if (entry.kind !== 'untracked' || files.some(file => file.path === entry.path)) continue
      files.push({ status: 'untracked', path: entry.path, patchAvailable: false })
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const patch = patchResult.stdout.toString('utf8')
    if (patch.includes('\0')) throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid handoff patch.')

    const blockers: GitWorktreeHandoffInspection['blockers'] = []
    const block = (reason: GitWorktreeHandoffInspection['blockers'][number]): void => {
      if (!blockers.includes(reason)) blockers.push(reason)
    }
    if (sourceStatus.branch === undefined) block('source-detached')
    if (sourceStatus.entries.some(entry => entry.kind === 'unmerged')) block('source-conflicts')
    if (sourceStatus.head === undefined) {
      block('source-diverged')
    } else if (sourceStatus.head !== baseCommit) {
      try {
        await this.run([
          '-C', sourceRepository.root,
          'merge-base',
          '--is-ancestor',
          baseCommit,
          sourceStatus.head,
        ], signal, deadline)
      } catch (error) {
        if (error instanceof GitServiceError && error.code === 'GIT_FAILED') block('source-diverged')
        else throw error
      }
    }
    if (destinationStatus.branch === undefined) block('destination-detached')
    if (destinationStatus.head !== baseCommit) block('destination-head-changed')
    if (!destinationStatus.clean) block('destination-dirty')
    if (files.length === 0) block('no-changes')

    if (files.length > 0) {
      const destinationWithIgnored = await this.statusBefore(destinationRepository, signal, deadline, true)
      const transferPaths = files.flatMap(file => [file.path, ...(file.originalPath === undefined ? [] : [file.originalPath])])
      const collides = destinationWithIgnored.entries.some(entry => {
        if (entry.kind !== 'ignored' && entry.kind !== 'untracked') return false
        const entryPath = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
        return transferPaths.some(path => path === entryPath || path.startsWith(`${entryPath}/`))
      })
      if (collides) block('destination-collision')
    }

    return {
      direction: input.direction,
      baseCommit,
      source: {
        kind: sourceKind,
        path: sourceRepository.root,
        ...(sourceStatus.branch === undefined ? {} : { branch: sourceStatus.branch }),
        head: sourceStatus.head ?? baseCommit,
        clean: sourceStatus.clean,
      },
      destination: {
        kind: destinationKind,
        path: destinationRepository.root,
        ...(destinationStatus.branch === undefined ? {} : { branch: destinationStatus.branch }),
        head: destinationStatus.head ?? baseCommit,
        clean: destinationStatus.clean,
      },
      files,
      patch,
      blockers,
      canTransfer: blockers.length === 0,
    }
  }

  async removeWorktree(input: GitRemoveWorktreeInput, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.timeoutMs
    const expectedHead = boundedObjectId(input.head, 'Expected worktree HEAD')!
    const inspected = await this.inspectWorktreeForRemovalBefore(input, signal, deadline)
    if (inspected.inspection.head !== expectedHead) {
      throw new GitServiceError('GIT_FAILED', 'The managed worktree HEAD changed before cleanup.')
    }
    const { repository, target, lockReason } = inspected
    await this.run([
      '--no-optional-locks',
      '-C', repository.root,
      'worktree',
      'unlock',
      target,
    ], signal, deadline)
    try {
      await this.run([
        '--no-optional-locks',
        '-C', repository.root,
        '-c', 'core.fsmonitor=false',
        'worktree',
        'remove',
        '--',
        target,
      ], signal, deadline)
    } catch (error) {
      try {
        const current = (await this.listWorktreesBefore(repository.root, signal, deadline))
          .find(candidate => candidate.path === target)
        if (current !== undefined && !current.locked) {
          await this.run([
            '--no-optional-locks',
            '-C', repository.root,
            'worktree',
            'lock',
            '--reason', lockReason,
            target,
          ], signal, deadline)
        }
      } catch {
        // The caller treats any failure after unlock as ambiguous and requires recovery.
      }
      throw error
    }
    if ((await this.listWorktreesBefore(repository.root, signal, deadline)).some(candidate => candidate.path === target)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git reported cleanup success but the worktree is still registered.')
    }
    try {
      await lstat(target)
      throw new GitServiceError('BAD_OUTPUT', 'Git reported cleanup success but the worktree path still exists.')
    } catch (error) {
      if (error instanceof GitServiceError) throw error
      if (!isRecordWithCode(error) || error.code !== 'ENOENT') {
        throw new GitServiceError('BAD_OUTPUT', 'The cleaned worktree path could not be verified safely.')
      }
    }
  }

  private async inspectWorktreeForRemovalBefore(
    input: GitInspectWorktreeInput,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<InspectedWorktreeRemoval> {
    const managed = await this.inspectManagedWorktreeBefore(input, signal, deadline)
    const status = await this.statusBefore(managed.targetRepository, signal, deadline, true)
    if (!status.clean || status.head !== managed.entry.head ||
      status.branch !== managed.entry.branch!.slice('refs/heads/'.length) || status.entries.length !== 0) {
      throw new GitServiceError(
        'GIT_FAILED',
        'The managed worktree contains modified, untracked, ignored, or conflicting files.',
      )
    }
    return {
      repository: managed.repository,
      target: managed.target,
      lockReason: managed.lockReason,
      inspection: {
        worktreePath: managed.target,
        head: managed.entry.head!,
        branch: managed.entry.branch!,
        clean: true,
        locked: true,
      },
    }
  }

  private async inspectManagedWorktreeBefore(
    input: GitInspectWorktreeInput,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<InspectedManagedWorktree> {
    const requestedRoot = await this.canonicalDirectory(boundedInput(input.repositoryRoot, 'Repository root'))
    const repository = await this.discoverRepositoryBefore(requestedRoot, signal, deadline)
    if (repository.root !== requestedRoot) {
      throw new GitServiceError(
        'INVALID_INPUT',
        'Git operations require the exact repository root returned by repository discovery.',
      )
    }
    const targetValue = boundedInput(input.worktreePath, 'Worktree path')
    if (!isAbsolute(targetValue) || normalize(targetValue) !== targetValue || targetValue === repository.root) {
      throw new GitServiceError('INVALID_INPUT', 'The worktree removal path is invalid.')
    }
    const target = await this.canonicalDirectory(targetValue)
    if (target !== targetValue) {
      throw new GitServiceError('INVALID_INPUT', 'The worktree path changed during validation.')
    }
    const branch = boundedHeadRef(input.branch, 'Expected worktree branch')
    const lockReason = boundedInput(input.lockReason, 'Expected worktree lock')
    if (lockReason.length > 256 || /[\r\n]/.test(lockReason)) {
      throw new GitServiceError('INVALID_INPUT', 'The worktree lock reason is invalid.')
    }
    const targetRepository = await this.discoverRepositoryBefore(target, signal, deadline)
    if (targetRepository.root !== target || targetRepository.commonDir !== repository.commonDir) {
      throw new GitServiceError('GIT_FAILED', 'The managed worktree repository identity changed.')
    }
    const entries = await this.listWorktreesBefore(repository.root, signal, deadline)
    const entry = entries.find(candidate => candidate.path === target)
    if (entry === undefined || entry.bare || entry.detached || entry.head === undefined || entry.branch !== branch ||
      !entry.locked || entry.lockReason !== lockReason || entry.prunable) {
      throw new GitServiceError('GIT_FAILED', 'The managed worktree identity changed before cleanup.')
    }
    return {
      repository,
      target,
      lockReason,
      targetRepository,
      entry,
    }
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

  private async resolveCommitBefore(
    repositoryRoot: string,
    ref: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const commit = parseCommandValue(await this.run([
      '-C', repositoryRoot,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ], signal, deadline), 'commit identity')
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
      throw new GitServiceError('BAD_OUTPUT', 'Git returned an invalid commit identity.')
    }
    return commit
  }

  private async runRemote(
    args: readonly string[],
    rawUrl: string,
    displayUrl: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<GitCommandResult> {
    try {
      return await this.run(args, signal, deadline)
    } catch (error) {
      if (!(error instanceof GitServiceError)) throw error
      const message = redactError(error.message.split(rawUrl).join(displayUrl))
      throw new GitServiceError(error.code, message.length === 0 ? 'Git could not reach the push remote.' : message)
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
