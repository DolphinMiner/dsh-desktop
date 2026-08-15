import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { GitService, GitServiceError, parseGitStatus } from './git-service'

const execFileAsync = promisify(execFile)

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
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
