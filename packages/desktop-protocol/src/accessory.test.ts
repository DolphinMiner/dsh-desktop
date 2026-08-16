import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseDesktopFileOpenInput,
  parseDesktopFilesListInput,
  parseDesktopTerminalStartInput,
  parseDesktopTerminalWriteInput,
} from './accessory.js'

test('validates workspace-bound file accessory intents', () => {
  assert.deepEqual(parseDesktopFilesListInput({ workspaceRoot: '/repo', path: '/repo/src' }), {
    workspaceRoot: '/repo',
    path: '/repo/src',
  })
  assert.deepEqual(parseDesktopFileOpenInput({ workspaceRoot: '/repo', path: '/repo/README.md' }), {
    workspaceRoot: '/repo',
    path: '/repo/README.md',
  })
  assert.equal(parseDesktopFilesListInput({ workspaceRoot: '', path: '/repo' }), undefined)
  assert.equal(parseDesktopFilesListInput({ workspaceRoot: '/repo', path: '/repo', extra: true }), undefined)
  assert.equal(parseDesktopFileOpenInput({ workspaceRoot: '/repo', path: '' }), undefined)
})

test('validates bounded terminal accessory intents', () => {
  assert.deepEqual(parseDesktopTerminalStartInput({ workspaceRoot: '/repo' }), { workspaceRoot: '/repo' })
  assert.deepEqual(parseDesktopTerminalWriteInput({ data: 'npm test\n' }), { data: 'npm test\n' })
  assert.equal(parseDesktopTerminalStartInput({ workspaceRoot: '' }), undefined)
  assert.equal(parseDesktopTerminalWriteInput({ data: '' }), undefined)
  assert.equal(parseDesktopTerminalWriteInput({ data: 'x'.repeat(8_193) }), undefined)
})
