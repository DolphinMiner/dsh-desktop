import assert from 'node:assert/strict'
import test from 'node:test'

import { LineBuffer, parseHarnessUrl } from './harness-output'

test('parses the loopback URL announced by dsh', () => {
  assert.equal(
    parseHarnessUrl('dsh web: http://127.0.0.1:43127'),
    'http://127.0.0.1:43127',
  )
})

test('rejects remote and malformed readiness URLs', () => {
  assert.equal(parseHarnessUrl('dsh web: http://0.0.0.0:3080'), undefined)
  assert.equal(parseHarnessUrl('dsh web: https://127.0.0.1:3080'), undefined)
  assert.equal(parseHarnessUrl('not a readiness line'), undefined)
})

test('assembles output split across process chunks', () => {
  const buffer = new LineBuffer()

  assert.deepEqual(buffer.push('booting\ndsh web: http://127.'), ['booting'])
  assert.deepEqual(buffer.push('0.0.1:3080\nready\n'), [
    'dsh web: http://127.0.0.1:3080',
    'ready',
  ])
  assert.equal(buffer.flush(), undefined)
})
