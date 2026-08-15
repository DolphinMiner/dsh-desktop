import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
