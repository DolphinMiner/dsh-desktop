import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DesktopFilesController, DesktopTerminalController } from './desktop-accessory'

test('lists only the selected workspace and opens validated regular files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-accessory-files-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-accessory-outside-'))
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'README.md'), '# Test')
  await writeFile(join(root, '.secret'), 'hidden')
  await writeFile(join(outside, 'outside.txt'), 'outside')
  const opened: string[] = []
  const files = new DesktopFilesController(path => {
    opened.push(path)
    return Promise.resolve()
  })

  const listing = await files.list({ workspaceRoot: root })
  const canonicalRoot = await realpath(root)
  assert.deepEqual(listing.entries.map(entry => [entry.kind, entry.name]), [
    ['directory', 'src'],
    ['file', 'README.md'],
  ])
  await files.open(root, join(root, 'README.md'))
  assert.deepEqual(opened, [join(canonicalRoot, 'README.md')])
  await assert.rejects(files.list({ workspaceRoot: root, path: outside }), { code: 'BAD_MESSAGE' })
  await assert.rejects(files.open(root, join(outside, 'outside.txt')), { code: 'BAD_MESSAGE' })
})

test('runs one workspace shell and streams human-entered commands', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-accessory-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let output = ''
  let resolveOutput: (() => void) | undefined
  const received = new Promise<void>(resolve => { resolveOutput = resolve })
  const terminal = new DesktopTerminalController({
    shellPath: '/bin/sh',
    shellArgs: [],
    onData: data => {
      output += data
      if (output.includes('terminal-ready')) resolveOutput?.()
    },
  })
  t.after(() => terminal.dispose())

  const started = await terminal.start({ workspaceRoot: root })
  assert.deepEqual(started, { running: true, cwd: await realpath(root) })
  terminal.write({ data: "printf 'terminal-ready\\n'\n" })
  await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(new Error('terminal output timeout')), 2_000)),
  ])
  assert.match(output, /terminal-ready/)
  assert.equal((await terminal.stop()).running, false)
})
