import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadWorkspaceUploadFiles, resolveWorkspaceTarget, WorkspacePathError } from './workspace-path'

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
