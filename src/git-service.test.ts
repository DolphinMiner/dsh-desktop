import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  GitService,
  GitServiceError,
  parseGitNameStatus,
  parseGitStatus,
  parseGitWorktreeList,
} from './git-service'

const execFileAsync = promisify(execFile)

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
}

async function gitOutput(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  return result.stdout.toString().trim()
}

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-service-test-'))
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'DSH Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(root, 'README.md'), 'first\n')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-m', 'initial')
  return root
}

async function pushFixture(): Promise<{ root: string; remote: string }> {
  const root = await repositoryFixture()
  const remote = await mkdtemp(join(tmpdir(), 'dsh-git-push-remote-test-'))
  await git(remote, 'init', '--bare')
  await git(root, 'remote', 'add', 'origin', remote)
  await git(root, 'push', '--set-upstream', 'origin', 'main')
  await writeFile(join(root, 'README.md'), 'ready to push\n')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-m', 'push candidate')
  return { root, remote }
}

test('discovers a canonical repository and parses structured status', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'README.md'), 'changed\n')
  await writeFile(join(root, 'staged file.txt'), 'staged\n')
  await writeFile(join(root, 'untracked.txt'), 'untracked\n')
  await git(root, 'add', 'staged file.txt')

  const service = new GitService()
  const repository = await service.discoverRepository(join(root, 'nested'))
  assert.equal(repository.root, canonicalRoot)
  assert.equal(repository.gitDir, join(canonicalRoot, '.git'))
  assert.equal(repository.commonDir, join(canonicalRoot, '.git'))

  const status = await service.status(repository.root)
  assert.equal(status.branch, 'main')
  assert.match(status.head ?? '', /^[a-f0-9]{40,64}$/)
  assert.equal(status.clean, false)
  assert.deepEqual(status.entries.map(entry => ({
    kind: entry.kind,
    path: entry.path,
    index: entry.indexStatus,
    worktree: entry.worktreeStatus,
  })), [
    { kind: 'ordinary', path: 'README.md', index: '.', worktree: 'M' },
    { kind: 'ordinary', path: 'staged file.txt', index: 'A', worktree: '.' },
    { kind: 'untracked', path: 'untracked.txt', index: '?', worktree: '?' },
  ])
})

test('parses NUL-delimited rename records and preserves unusual path characters', () => {
  const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
  const output = Buffer.from([
    `# branch.oid ${'a'.repeat(40)}`,
    '# branch.head main',
    '2 R. N... 100644 100644 100644 abcdef abcdef R100 renamed file.txt',
    'old\nfile.txt',
    '? untracked\nfile.txt',
    '',
  ].join('\0'))

  const status = parseGitStatus(repository, output)
  assert.deepEqual(status.entries, [
    {
      kind: 'renamed',
      path: 'renamed file.txt',
      originalPath: 'old\nfile.txt',
      indexStatus: 'R',
      worktreeStatus: '.',
    },
    {
      kind: 'untracked',
      path: 'untracked\nfile.txt',
      indexStatus: '?',
      worktreeStatus: '?',
    },
  ])
})

test('rejects incomplete or malformed porcelain status', () => {
  const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
  assert.throws(
    () => parseGitStatus(repository, Buffer.alloc(0)),
    (error: GitServiceError) => error.code === 'BAD_OUTPUT',
  )
  assert.throws(
    () => parseGitStatus(repository, Buffer.from([
      `# branch.oid ${'a'.repeat(40)}`,
      '# branch.head main',
      '1 ZZ N... 100644 100644 100644 abcdef abcdef file.txt',
      '',
    ].join('\0'))),
    (error: GitServiceError) => error.code === 'BAD_OUTPUT',
  )
})

test('parses NUL-delimited review paths and rejects malformed status records', () => {
  assert.deepEqual(parseGitNameStatus(Buffer.from([
    'M',
    'line\nbreak.txt',
    'R100',
    'old name.ts',
    'new name.ts',
    '',
  ].join('\0'))), [{
    status: 'modified',
    path: 'line\nbreak.txt',
    patchAvailable: true,
  }, {
    status: 'renamed',
    path: 'new name.ts',
    originalPath: 'old name.ts',
    patchAvailable: true,
  }])
  assert.throws(
    () => parseGitNameStatus(Buffer.from('R101\0old.ts\0new.ts\0')),
    (error: GitServiceError) => error.code === 'BAD_OUTPUT',
  )
  assert.throws(
    () => parseGitNameStatus(Buffer.from('M\0unterminated.txt')),
    (error: GitServiceError) => error.code === 'BAD_OUTPUT',
  )
})

test('reads authoritative unstaged, staged, commit, and merge-base review scopes', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const initialCommit = await gitOutput(root, 'rev-parse', 'HEAD')

  await writeFile(join(root, 'committed.txt'), 'committed change\n')
  await git(root, 'add', 'committed.txt')
  await git(root, 'commit', '-m', 'add committed file')
  const selectedCommit = await gitOutput(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'staged.txt'), 'staged change\n')
  await git(root, 'add', 'staged.txt')
  await writeFile(join(root, 'README.md'), 'unstaged change\n')
  await writeFile(join(root, 'untracked.txt'), 'untracked change\n')

  const service = new GitService()
  const unstaged = await service.review(canonicalRoot, { kind: 'unstaged' })
  assert.deepEqual(unstaged.files, [{
    status: 'modified',
    path: 'README.md',
    patchAvailable: true,
  }, {
    status: 'untracked',
    path: 'untracked.txt',
    patchAvailable: false,
  }])
  assert.match(unstaged.patch, /diff --git a\/README\.md b\/README\.md/)
  assert.match(unstaged.patch, /^index [a-f0-9]{40}\.\.[a-f0-9]{40}(?:\s|$)/m)
  assert.doesNotMatch(unstaged.patch, /untracked\.txt/)

  const staged = await service.review(canonicalRoot, { kind: 'staged' })
  assert.deepEqual(staged.files, [{ status: 'added', path: 'staged.txt', patchAvailable: true }])
  assert.match(staged.patch, /diff --git a\/staged\.txt b\/staged\.txt/)

  const commit = await service.review(canonicalRoot, { kind: 'commit', ref: selectedCommit })
  assert.equal(commit.selectedCommit, selectedCommit)
  assert.deepEqual(commit.files, [{ status: 'added', path: 'committed.txt', patchAvailable: true }])
  assert.match(commit.patch, /diff --git a\/committed\.txt b\/committed\.txt/)

  const branch = await service.review(canonicalRoot, { kind: 'branch', baseRef: initialCommit })
  assert.equal(branch.head, selectedCommit)
  assert.equal(branch.baseCommit, initialCommit)
  assert.equal(branch.mergeBase, initialCommit)
  assert.deepEqual(branch.files, [{ status: 'added', path: 'committed.txt', patchAvailable: true }])
  assert.match(branch.patch, /diff --git a\/committed\.txt b\/committed\.txt/)
})

test('stages and unstages literal paths and returns authoritative status', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'README.md'), 'changed\n')
  await writeFile(join(root, ':(literal) file.txt'), 'literal path\n')

  const service = new GitService()
  const staged = await service.mutateIndex(canonicalRoot, 'stage', [
    'README.md',
    ':(literal) file.txt',
  ])
  assert.deepEqual(staged.entries.map(entry => [entry.path, entry.indexStatus, entry.worktreeStatus]), [
    [':(literal) file.txt', 'A', '.'],
    ['README.md', 'M', '.'],
  ])

  const unstaged = await service.mutateIndex(canonicalRoot, 'unstage', ['README.md'])
  assert.deepEqual(unstaged.entries.map(entry => [entry.path, entry.indexStatus, entry.worktreeStatus]), [
    [':(literal) file.txt', 'A', '.'],
    ['README.md', '.', 'M'],
  ])
})

test('unstages a changed initial commit candidate without deleting the working file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-unborn-test-'))
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await git(root, 'init', '-b', 'main')
  await writeFile(join(root, 'initial.txt'), 'first\n')
  const service = new GitService()
  await service.mutateIndex(canonicalRoot, 'stage', ['initial.txt'])
  await writeFile(join(root, 'initial.txt'), 'changed after stage\n')

  const status = await service.mutateIndex(canonicalRoot, 'unstage', ['initial.txt'])
  assert.equal(status.head, undefined)
  assert.deepEqual(status.entries, [{
    kind: 'untracked',
    path: 'initial.txt',
    indexStatus: '?',
    worktreeStatus: '?',
  }])
  assert.equal(await gitOutput(root, 'status', '--porcelain', '--', 'initial.txt'), '?? initial.txt')
})

test('rejects traversal and duplicate Git mutation paths before invocation', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new GitService()

  await assert.rejects(service.mutateIndex(canonicalRoot, 'stage', ['../outside']),
    (error: GitServiceError) => error.code === 'INVALID_INPUT')
  await assert.rejects(service.mutateIndex(canonicalRoot, 'stage', ['README.md', 'README.md']),
    (error: GitServiceError) => error.code === 'INVALID_INPUT')
})

test('reverts only the selected unstaged worktree change and preserves the index', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'README.md'), 'staged version\n')
  await git(root, 'add', 'README.md')
  await writeFile(join(root, 'README.md'), 'unstaged version\n')

  const status = await new GitService().revertWorktree(canonicalRoot, 'README.md')
  assert.deepEqual(status.entries, [{
    kind: 'ordinary',
    path: 'README.md',
    indexStatus: 'M',
    worktreeStatus: '.',
  }])
  assert.equal(await gitOutput(root, 'show', ':README.md'), 'staged version')
  assert.equal(await gitOutput(root, 'diff', '--', 'README.md'), '')
})

test('commits exactly the reviewed index tree and preserves unstaged work', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'README.md'), 'staged version\n')
  await git(root, 'add', 'README.md')
  await writeFile(join(root, 'README.md'), 'unstaged version\n')
  const service = new GitService()
  const before = await service.status(canonicalRoot)
  const expectedTree = await service.indexTree(canonicalRoot)

  const result = await service.commit(
    canonicalRoot,
    'feat: commit reviewed index\n\nKeep the working copy.',
    before.head,
    expectedTree,
  )
  assert.equal(result.status.head, result.commit)
  assert.equal(await gitOutput(root, 'show', `${result.commit}:README.md`), 'staged version')
  assert.equal(await gitOutput(root, 'log', '-1', '--format=%B'),
    'feat: commit reviewed index\n\nKeep the working copy.')
  assert.equal(await gitOutput(root, 'show', ':README.md'), 'staged version')
  const worktreeDiff = await gitOutput(root, 'diff', '--', 'README.md')
  assert.match(worktreeDiff, /-staged version/)
  assert.match(worktreeDiff, /\+unstaged version/)
})

test('runs commit hooks and leaves HEAD unchanged when a hook rejects', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'README.md'), 'staged version\n')
  await git(root, 'add', 'README.md')
  const hook = join(root, '.git', 'hooks', 'pre-commit')
  await writeFile(hook, '#!/bin/sh\necho "review hook rejected" >&2\nexit 1\n')
  await chmod(hook, 0o755)
  const service = new GitService()
  const before = await service.status(canonicalRoot)
  const expectedTree = await service.indexTree(canonicalRoot)

  await assert.rejects(service.commit(canonicalRoot, 'feat: rejected', before.head, expectedTree),
    (error: GitServiceError) => error.code === 'GIT_FAILED' && /review hook rejected/.test(error.message))
  assert.equal((await service.status(canonicalRoot)).head, before.head)
  assert.equal(await service.indexTree(canonicalRoot), expectedTree)
})

test('detects a commit-msg hook that changes the reviewed message', async t => {
  const root = await repositoryFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'README.md'), 'staged version\n')
  await git(root, 'add', 'README.md')
  const hook = join(root, '.git', 'hooks', 'commit-msg')
  await writeFile(hook, '#!/bin/sh\nprintf "hook changed message\\n" > "$1"\n')
  await chmod(hook, 0o755)
  const service = new GitService()
  const before = await service.status(canonicalRoot)
  const expectedTree = await service.indexTree(canonicalRoot)

  await assert.rejects(service.commit(canonicalRoot, 'feat: reviewed', before.head, expectedTree),
    (error: GitServiceError) => error.code === 'BAD_OUTPUT' && /changed the reviewed commit message/.test(error.message))
  assert.notEqual((await service.status(canonicalRoot)).head, before.head)
  assert.equal(await gitOutput(root, 'log', '-1', '--format=%B'), 'hook changed message')
})

test('creates an initial commit from a reviewed index tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-initial-commit-test-'))
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'DSH Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(root, 'README.md'), 'first\n')
  await git(root, 'add', 'README.md')
  const service = new GitService()
  const expectedTree = await service.indexTree(canonicalRoot)

  const result = await service.commit(canonicalRoot, 'feat: initial', undefined, expectedTree)
  assert.equal(result.status.head, result.commit)
  assert.equal((await gitOutput(root, 'rev-list', '--parents', '--max-count=1', result.commit)).split(' ').length, 1)
})

test('discovers the live upstream and pushes exactly the approved commit without force', async t => {
  const { root, remote } = await pushFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(remote, { recursive: true, force: true }))
  const service = new GitService()

  const target = await service.pushTarget(canonicalRoot)
  assert.equal(target.remote, 'origin')
  assert.equal(target.remoteUrl, remote)
  assert.match(target.remoteUrlFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(target.localRef, 'refs/heads/main')
  assert.equal(target.remoteRef, 'refs/heads/main')
  assert.equal(target.trackingRef, 'refs/remotes/origin/main')
  assert.equal(target.ahead, 1)
  assert.equal(target.behind, 0)

  const result = await service.push(canonicalRoot, target)
  assert.deepEqual(result, { remote: 'origin', remoteRef: 'refs/heads/main', head: target.head })
  assert.equal(await gitOutput(remote, 'rev-parse', 'refs/heads/main'), target.head)
  assert.equal((await service.pushTarget(canonicalRoot)).ahead, 0)
})

test('runs pre-push hooks and leaves the remote unchanged when a hook rejects', async t => {
  const { root, remote } = await pushFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(remote, { recursive: true, force: true }))
  const service = new GitService()
  const target = await service.pushTarget(canonicalRoot)
  const hook = join(root, '.git', 'hooks', 'pre-push')
  await writeFile(hook, '#!/bin/sh\necho "push hook rejected" >&2\nexit 1\n')
  await chmod(hook, 0o755)

  await assert.rejects(service.push(canonicalRoot, target),
    (error: GitServiceError) => error.code === 'GIT_FAILED' && /push hook rejected/.test(error.message))
  assert.equal(await gitOutput(remote, 'rev-parse', 'refs/heads/main'), target.upstreamHead)
})

test('refuses a push when the approved local or remote state has changed', async t => {
  const { root, remote } = await pushFixture()
  const canonicalRoot = await realpath(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(remote, { recursive: true, force: true }))
  const service = new GitService()
  const target = await service.pushTarget(canonicalRoot)
  await writeFile(join(root, 'later.txt'), 'not reviewed\n')
  await git(root, 'add', 'later.txt')
  await git(root, 'commit', '-m', 'later local commit')

  await assert.rejects(service.push(canonicalRoot, target),
    (error: GitServiceError) => error.code === 'GIT_FAILED' && /changed after approval/.test(error.message))
  assert.equal(await gitOutput(remote, 'rev-parse', 'refs/heads/main'), target.upstreamHead)
})

test('parses NUL-delimited worktree identity, lock, and prune attributes', () => {
  const entries = parseGitWorktreeList(Buffer.from([
    'worktree /repo',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/main',
    '',
    'worktree /worktrees/line\nbreak',
    `HEAD ${'b'.repeat(40)}`,
    'detached',
    'locked DSH Desktop session one',
    'prunable gitdir file points to non-existent location',
    '',
    '',
  ].join('\0')))

  assert.deepEqual(entries, [{
    path: '/repo',
    head: 'a'.repeat(40),
    branch: 'refs/heads/main',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  }, {
    path: '/worktrees/line\nbreak',
    head: 'b'.repeat(40),
    detached: true,
    bare: false,
    locked: true,
    lockReason: 'DSH Desktop session one',
    prunable: true,
    pruneReason: 'gitdir file points to non-existent location',
  }])
  assert.throws(() => parseGitWorktreeList(Buffer.from([
    'worktree /repo',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/main',
    'detached',
    '',
    '',
  ].join('\0'))), (error: GitServiceError) => error.code === 'BAD_OUTPUT')
})

test('lists real locked worktrees without resolving a missing checkout path', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-worktree-list-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH test lock', '-b', 'topic', target, 'HEAD')

  const entries = await new GitService().listWorktrees(await realpath(root))
  const canonicalTarget = await realpath(target)
  const linked = entries.find(entry => entry.path === canonicalTarget)
  assert.equal(linked?.branch, 'refs/heads/topic')
  assert.equal(linked?.locked, true)
  assert.equal(linked?.lockReason, 'DSH test lock')
})

test('removes only an exact clean locked worktree and preserves its branch', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-worktree-remove-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH cleanup test', '-b', 'cleanup-topic', target, 'HEAD')
  const head = await gitOutput(target, 'rev-parse', 'HEAD')
  const service = new GitService()

  await service.removeWorktree({
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    head,
    branch: 'refs/heads/cleanup-topic',
    lockReason: 'DSH cleanup test',
  })
  await assert.rejects(access(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  assert.equal(await gitOutput(root, 'rev-parse', 'refs/heads/cleanup-topic'), head)
  assert.equal((await service.listWorktrees(await realpath(root))).some(entry => entry.path === target), false)
})

test('refuses cleanup when ignored content would otherwise be discarded', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-worktree-ignored-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '*.local\n')
  await git(root, 'add', '.gitignore')
  await git(root, 'commit', '-m', 'ignore local state')
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH cleanup test', '-b', 'dirty-topic', target, 'HEAD')
  await writeFile(join(target, 'private.local'), 'must survive\n')
  const head = await gitOutput(target, 'rev-parse', 'HEAD')
  const service = new GitService()
  const inspection = await service.inspectWorktreeForRemoval({
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    branch: 'refs/heads/dirty-topic',
    lockReason: 'DSH cleanup test',
  })
  assert.equal(inspection.clean, false)
  assert.deepEqual(inspection.changes, [{
    kind: 'ignored',
    path: 'private.local',
    indexStatus: '!',
    worktreeStatus: '!',
  }])

  await assert.rejects(service.removeWorktree({
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    head,
    branch: 'refs/heads/dirty-topic',
    lockReason: 'DSH cleanup test',
  }), (error: GitServiceError) => error.code === 'GIT_FAILED' && /ignored/.test(error.message))
  assert.equal(await readFile(join(target, 'private.local'), 'utf8'), 'must survive\n')
})

test('preflights local changes into an exact clean managed worktree', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-handoff-local-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const baseCommit = await gitOutput(root, 'rev-parse', 'HEAD')
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH handoff test', '-b', 'handoff-topic', target, baseCommit)
  await writeFile(join(root, 'README.md'), 'local change\n')
  await writeFile(join(root, 'notes.txt'), 'untracked\n')

  const preflight = await new GitService().inspectWorktreeHandoff({
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    branch: 'refs/heads/handoff-topic',
    lockReason: 'DSH handoff test',
    baseCommit,
    direction: 'local-to-worktree',
  })

  assert.equal(preflight.canTransfer, true)
  assert.deepEqual(preflight.blockers, [])
  assert.equal(preflight.source.kind, 'local')
  assert.equal(preflight.source.clean, false)
  assert.equal(preflight.destination.kind, 'worktree')
  assert.equal(preflight.destination.clean, true)
  assert.match(preflight.sourceTree ?? '', /^[a-f0-9]{40,64}$/)
  assert.deepEqual(preflight.files.map(file => [file.status, file.path]), [
    ['modified', 'README.md'],
    ['added', 'notes.txt'],
  ])
  assert.match(preflight.patch, /local change/)
  assert.match(preflight.patch, /untracked/)
})

test('transfers the exact combined local tree into a clean managed worktree without changing the source', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-handoff-transfer-local-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const baseCommit = await gitOutput(root, 'rev-parse', 'HEAD')
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH handoff test', '-b', 'handoff-topic', target, baseCommit)
  await writeFile(join(root, 'committed.txt'), 'committed source\n')
  await git(root, 'add', 'committed.txt')
  await git(root, 'commit', '-m', 'source commit')
  await writeFile(join(root, 'staged.txt'), 'staged version\n')
  await git(root, 'add', 'staged.txt')
  await writeFile(join(root, 'staged.txt'), 'final working version\n')
  await writeFile(join(root, 'README.md'), 'unstaged source\n')
  await writeFile(join(root, 'untracked.txt'), 'untracked source\n')
  const sourceHeadBefore = await gitOutput(root, 'rev-parse', 'HEAD')
  const sourceIndexBefore = await gitOutput(root, 'write-tree')
  const sourceStatusBefore = await gitOutput(root, 'status', '--porcelain=v2', '--untracked-files=all')
  const service = new GitService()
  const input = {
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    branch: 'refs/heads/handoff-topic',
    lockReason: 'DSH handoff test',
    baseCommit,
    direction: 'local-to-worktree' as const,
  }

  const preflight = await service.inspectWorktreeHandoff(input)
  assert.equal(preflight.canTransfer, true)
  assert.ok(preflight.sourceTree)
  assert.equal(await service.inspectWorktreeHandoffOutcome({
    ...input,
    expectedSourceTree: preflight.sourceTree,
    expectedSourceHead: preflight.source.head,
    expectedSourceBranch: preflight.source.branch!,
    expectedDestinationBranch: preflight.destination.branch!,
  }), 'not-applied')
  const result = await service.transferWorktreeHandoff({
    ...input,
    expectedSourceTree: preflight.sourceTree,
    expectedSourceHead: preflight.source.head,
    expectedSourceBranch: preflight.source.branch!,
    expectedDestinationBranch: preflight.destination.branch!,
  })

  assert.equal(result.sourceTree, preflight.sourceTree)
  assert.equal(await gitOutput(target, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal(await gitOutput(target, 'write-tree'), preflight.sourceTree)
  assert.equal(await gitOutput(target, 'diff', '--name-only'), '')
  assert.deepEqual(result.destination.entries.every(entry =>
    entry.indexStatus !== '.' && entry.worktreeStatus === '.'), true)
  assert.equal(await readFile(join(target, 'staged.txt'), 'utf8'), 'final working version\n')
  assert.equal(await readFile(join(target, 'untracked.txt'), 'utf8'), 'untracked source\n')
  assert.equal(await gitOutput(root, 'rev-parse', 'HEAD'), sourceHeadBefore)
  assert.equal(await gitOutput(root, 'write-tree'), sourceIndexBefore)
  assert.equal(await gitOutput(root, 'status', '--porcelain=v2', '--untracked-files=all'), sourceStatusBefore)
  assert.equal(await service.inspectWorktreeHandoffOutcome({
    ...input,
    expectedSourceTree: preflight.sourceTree,
    expectedSourceHead: preflight.source.head,
    expectedSourceBranch: preflight.source.branch!,
    expectedDestinationBranch: preflight.destination.branch!,
  }), 'completed')
  await writeFile(join(target, 'README.md'), 'drift after transfer\n')
  assert.equal(await service.inspectWorktreeHandoffOutcome({
    ...input,
    expectedSourceTree: preflight.sourceTree,
    expectedSourceHead: preflight.source.head,
    expectedSourceBranch: preflight.source.branch!,
    expectedDestinationBranch: preflight.destination.branch!,
  }), 'ambiguous')
})

test('transfers the exact managed worktree tree back to a clean local checkout without changing the source', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-handoff-transfer-worktree-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const baseCommit = await gitOutput(root, 'rev-parse', 'HEAD')
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH handoff test', '-b', 'handoff-topic', target, baseCommit)
  await writeFile(join(target, 'committed.txt'), 'worktree commit\n')
  await git(target, 'add', 'committed.txt')
  await git(target, 'commit', '-m', 'worktree source commit')
  await writeFile(join(target, 'README.md'), 'worktree final\n')
  await writeFile(join(target, 'new.txt'), 'worktree untracked\n')
  const sourceHeadBefore = await gitOutput(target, 'rev-parse', 'HEAD')
  const sourceIndexBefore = await gitOutput(target, 'write-tree')
  const sourceStatusBefore = await gitOutput(target, 'status', '--porcelain=v2', '--untracked-files=all')
  const service = new GitService()
  const input = {
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    branch: 'refs/heads/handoff-topic',
    lockReason: 'DSH handoff test',
    baseCommit,
    direction: 'worktree-to-local' as const,
  }

  const preflight = await service.inspectWorktreeHandoff(input)
  assert.equal(preflight.canTransfer, true)
  assert.ok(preflight.sourceTree)
  await service.transferWorktreeHandoff({
    ...input,
    expectedSourceTree: preflight.sourceTree,
    expectedSourceHead: preflight.source.head,
    expectedSourceBranch: preflight.source.branch!,
    expectedDestinationBranch: preflight.destination.branch!,
  })

  assert.equal(await gitOutput(root, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal(await gitOutput(root, 'write-tree'), preflight.sourceTree)
  assert.equal(await gitOutput(root, 'diff', '--name-only'), '')
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'worktree final\n')
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'worktree untracked\n')
  assert.equal(await gitOutput(target, 'rev-parse', 'HEAD'), sourceHeadBefore)
  assert.equal(await gitOutput(target, 'write-tree'), sourceIndexBefore)
  assert.equal(await gitOutput(target, 'status', '--porcelain=v2', '--untracked-files=all'), sourceStatusBefore)
})

test('rejects handoff source drift before the mutation dispatch boundary', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-handoff-drift-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const baseCommit = await gitOutput(root, 'rev-parse', 'HEAD')
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH handoff test', '-b', 'handoff-topic', target, baseCommit)
  await writeFile(join(root, 'README.md'), 'reviewed source\n')
  const service = new GitService()
  const input = {
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    branch: 'refs/heads/handoff-topic',
    lockReason: 'DSH handoff test',
    baseCommit,
    direction: 'local-to-worktree' as const,
  }
  const preflight = await service.inspectWorktreeHandoff(input)
  assert.ok(preflight.sourceTree)
  await writeFile(join(root, 'README.md'), 'changed after review\n')
  let dispatches = 0

  await assert.rejects(service.transferWorktreeHandoff({
    ...input,
    expectedSourceTree: preflight.sourceTree,
    expectedSourceHead: preflight.source.head,
    expectedSourceBranch: preflight.source.branch!,
    expectedDestinationBranch: preflight.destination.branch!,
  }, undefined, () => { dispatches += 1 }), (error: GitServiceError) =>
    error.code === 'GIT_FAILED' && /endpoints changed/.test(error.message))
  assert.equal(dispatches, 0)
  assert.equal(await gitOutput(target, 'status', '--porcelain=v2', '--untracked-files=all'), '')
  assert.equal(await gitOutput(target, 'rev-parse', 'HEAD'), baseCommit)
})

test('blocks a handoff that would overwrite an ignored destination path', async t => {
  const root = await repositoryFixture()
  const parent = await mkdtemp(join(tmpdir(), 'dsh-git-handoff-collision-test-'))
  const target = join(parent, 'managed worktree')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(parent, { recursive: true, force: true }))
  await writeFile(join(root, '.gitignore'), '*.local\n')
  await git(root, 'add', '.gitignore')
  await git(root, 'commit', '-m', 'ignore local artifacts')
  const baseCommit = await gitOutput(root, 'rev-parse', 'HEAD')
  await git(root, 'worktree', 'add', '--lock', '--reason', 'DSH handoff test', '-b', 'handoff-topic', target, baseCommit)
  await writeFile(join(target, 'artifact.local'), 'source content\n')
  await git(target, 'add', '--force', 'artifact.local')
  await writeFile(join(root, 'artifact.local'), 'destination content\n')

  const preflight = await new GitService().inspectWorktreeHandoff({
    repositoryRoot: await realpath(root),
    worktreePath: await realpath(target),
    branch: 'refs/heads/handoff-topic',
    lockReason: 'DSH handoff test',
    baseCommit,
    direction: 'worktree-to-local',
  })

  assert.equal(preflight.destination.clean, true)
  assert.deepEqual(preflight.files.map(file => [file.status, file.path]), [['added', 'artifact.local']])
  assert.deepEqual(preflight.blockers, ['destination-collision'])
  assert.equal(preflight.canTransfer, false)
  assert.equal(await readFile(join(root, 'artifact.local'), 'utf8'), 'destination content\n')
})

test('requires the exact discovered root and rejects non-repositories', async t => {
  const root = await repositoryFixture()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-git-outside-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(root, 'nested'))
  const service = new GitService()

  await assert.rejects(service.status(join(root, 'nested')), (error: GitServiceError) =>
    error.code === 'INVALID_INPUT')
  await assert.rejects(service.discoverRepository(outside), (error: GitServiceError) =>
    error.code === 'NOT_REPOSITORY')
})

test('bounds output and cooperatively cancels the whole Git process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-process-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const noisy = join(root, 'noisy-git.mjs')
  await writeFile(noisy, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(4096))\n')
  await chmod(noisy, 0o755)
  const bounded = new GitService({ executable: noisy, maxOutputBytes: 128 })
  await assert.rejects(bounded.discoverRepository(root), (error: GitServiceError) =>
    error.code === 'OUTPUT_LIMIT')

  const hanging = join(root, 'hanging-git.mjs')
  await writeFile(hanging, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  await chmod(hanging, 0o755)
  const cancellable = new GitService({ executable: hanging, timeoutMs: 5_000 })
  const controller = new AbortController()
  const startedAt = Date.now()
  const pending = cancellable.discoverRepository(root, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, (error: GitServiceError) => error.code === 'CANCELLED')
  assert.ok(Date.now() - startedAt < 1_000)
})

test('times out an unresponsive Git process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-timeout-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const hanging = join(root, 'hanging-git.mjs')
  await writeFile(hanging, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  await chmod(hanging, 0o755)

  const service = new GitService({ executable: hanging, timeoutMs: 20 })
  await assert.rejects(service.discoverRepository(root), (error: GitServiceError) =>
    error.code === 'TIMEOUT')
})

test('redacts credentials from Git failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-redaction-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.git'))
  const canonicalRoot = await realpath(root)
  const executable = join(root, 'failing-git.mjs')
  await writeFile(executable, `#!/usr/bin/env node
const root = ${JSON.stringify(canonicalRoot)}
if (process.argv.includes('status')) {
  process.stderr.write('https://user:top-secret@example.invalid/repo?access_token=also-secret\\n')
  process.exit(1)
}
if (process.env.GIT_FAKE_SECRET) process.exit(3)
if (process.argv.includes('--is-bare-repository')) process.stdout.write('false\\n')
else if (process.argv.includes('--show-toplevel')) process.stdout.write(root + '\\n')
else if (process.argv.includes('--absolute-git-dir')) process.stdout.write(root + '/.git\\n')
else if (process.argv.includes('--git-common-dir')) process.stdout.write(root + '/.git\\n')
else process.exit(2)
`)
  await chmod(executable, 0o755)

  const service = new GitService({ executable })
  const previousGitFakeSecret = process.env.GIT_FAKE_SECRET
  process.env.GIT_FAKE_SECRET = 'must-not-be-inherited'
  try {
    await assert.rejects(service.status(canonicalRoot), (error: GitServiceError) => {
      assert.equal(error.code, 'GIT_FAILED')
      assert.doesNotMatch(error.message, /top-secret|also-secret/)
      assert.match(error.message, /\[redacted\]/)
      return true
    })
  } finally {
    if (previousGitFakeSecret === undefined) delete process.env.GIT_FAKE_SECRET
    else process.env.GIT_FAKE_SECRET = previousGitFakeSecret
  }
})
