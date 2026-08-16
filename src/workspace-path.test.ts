import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadWorkspaceUploadFiles,
  resolveWorkspaceTarget,
  saveWorkspaceDownload,
  WorkspacePathError,
} from './workspace-path'

async function withWorkspace(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-desktop-path-'))
  const root = join(parent, 'workspace')
  const outside = join(parent, 'outside.txt')
  await mkdir(root)
  await writeFile(join(root, 'README.md'), '# Test\n')
  await writeFile(outside, 'private\n')
  try {
    await run(root, outside)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

test('resolves existing files inside a canonical workspace', async () => {
  await withWorkspace(async root => {
    const canonicalRoot = await realpath(root)
    assert.equal(
      await resolveWorkspaceTarget(root, 'README.md', { operation: 'open' }),
      join(canonicalRoot, 'README.md'),
    )
    assert.equal(await resolveWorkspaceTarget(root, '.', { operation: 'reveal' }), canonicalRoot)
  })
})

test('rejects parent traversal and symlinks that leave the workspace', async () => {
  await withWorkspace(async (root, outside) => {
    await symlink(outside, join(root, 'escape.txt'))
    for (const path of ['../outside.txt', 'escape.txt']) {
      await assert.rejects(
        resolveWorkspaceTarget(root, path, { operation: 'reveal' }),
        (error: unknown) => error instanceof WorkspacePathError && error.code === 'BAD_MESSAGE',
      )
    }
  })
})

test('rejects missing, directory, and executable open targets', async () => {
  await withWorkspace(async root => {
    const executable = join(root, 'run')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)
    await assert.rejects(resolveWorkspaceTarget(root, 'missing', { operation: 'open' }), {
      code: 'NOT_FOUND',
    })
    await assert.rejects(resolveWorkspaceTarget(root, '.', { operation: 'open' }), {
      code: 'BAD_MESSAGE',
    })
    await assert.rejects(resolveWorkspaceTarget(root, 'run', { operation: 'open' }), {
      code: 'BAD_MESSAGE',
    })
  })
})

test('loads bounded browser upload payloads without exposing paths to the page', async () => {
  await withWorkspace(async (root, outside) => {
    await writeFile(join(root, 'image.png'), new Uint8Array([1, 2, 3]))
    const files = await loadWorkspaceUploadFiles(root, ['README.md', 'image.png'])
    assert.deepEqual(files.map(file => ({
      name: file.name,
      mediaType: file.mediaType,
      data: [...file.data],
    })), [
      { name: 'README.md', mediaType: 'text/markdown', data: [...Buffer.from('# Test\n')] },
      { name: 'image.png', mediaType: 'image/png', data: [1, 2, 3] },
    ])

    await symlink(outside, join(root, 'upload-escape.txt'))
    await assert.rejects(loadWorkspaceUploadFiles(root, ['upload-escape.txt']), {
      code: 'BAD_MESSAGE',
    })
    await assert.rejects(loadWorkspaceUploadFiles(root, Array.from({ length: 9 }, (_, index) => `file-${index}`)), {
      code: 'BAD_MESSAGE',
    })
  })
})

test('atomically saves a new browser download inside the active workspace', async () => {
  await withWorkspace(async root => {
    await mkdir(join(root, 'downloads'))
    let finalChecks = 0
    const saved = await saveWorkspaceDownload(
      root,
      'downloads/report.csv',
      Buffer.from('a,b\n1,2\n'),
      {
        signal: new AbortController().signal,
        beforeCommit: () => { finalChecks += 1 },
      },
    )
    assert.deepEqual(saved, { path: 'downloads/report.csv' })
    assert.equal(await readFile(join(root, saved.path), 'utf8'), 'a,b\n1,2\n')
    assert.equal(finalChecks, 1)
    assert.deepEqual(await readdir(join(root, 'downloads')), ['report.csv'])

    await assert.rejects(saveWorkspaceDownload(
      root,
      saved.path,
      Buffer.from('replacement'),
      { signal: new AbortController().signal, beforeCommit: () => undefined },
    ), { code: 'CONFLICT' })
    assert.equal(await readFile(join(root, saved.path), 'utf8'), 'a,b\n1,2\n')
  })
})

test('rejects download traversal and a failed final authorization without artifacts', async () => {
  await withWorkspace(async root => {
    await assert.rejects(saveWorkspaceDownload(
      root,
      '../outside-download.txt',
      Buffer.from('private'),
      { signal: new AbortController().signal, beforeCommit: () => undefined },
    ), { code: 'BAD_MESSAGE' })

    await assert.rejects(saveWorkspaceDownload(
      root,
      'cancelled.txt',
      Buffer.from('private'),
      {
        signal: new AbortController().signal,
        beforeCommit: () => { throw new WorkspacePathError('CONFLICT', 'Session stopped.') },
      },
    ), { code: 'CONFLICT' })
    assert.deepEqual((await readdir(root)).sort(), ['README.md'])
  })
})

test('allows only one concurrent download writer to claim a destination', async () => {
  await withWorkspace(async root => {
    const options = () => ({ signal: new AbortController().signal, beforeCommit: () => undefined })
    const results = await Promise.allSettled([
      saveWorkspaceDownload(root, 'report.csv', Buffer.from('first'), options()),
      saveWorkspaceDownload(root, 'report.csv', Buffer.from('second'), options()),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status === 'rejected') assert.equal(rejected.reason.code, 'CONFLICT')
    assert.ok(['first', 'second'].includes(await readFile(join(root, 'report.csv'), 'utf8')))
    assert.deepEqual((await readdir(root)).sort(), ['README.md', 'report.csv'])
  })
})
