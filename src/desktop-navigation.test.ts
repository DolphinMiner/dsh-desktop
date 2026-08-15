import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopCommandQueue, parseDesktopDeepLink } from './desktop-navigation'

test('parses bounded desktop navigation links', () => {
  assert.deepEqual(parseDesktopDeepLink('dsh-desktop://session/session-123'), {
    type: 'session.open',
    sessionId: 'session-123',
  })
  assert.deepEqual(parseDesktopDeepLink('dsh-desktop://workspace/workspace-123'), {
    type: 'workspace.open',
    workspaceId: 'workspace-123',
  })
  assert.deepEqual(parseDesktopDeepLink('dsh-desktop://settings/connections'), {
    type: 'settings.open',
    sectionId: 'connections',
  })
  assert.deepEqual(parseDesktopDeepLink('dsh-desktop://settings'), { type: 'settings.open' })
})

test('rejects OAuth, malformed, nested, and credential-bearing links', () => {
  assert.equal(parseDesktopDeepLink('dsh-desktop://oauth/linear/callback?code=secret'), undefined)
  assert.equal(parseDesktopDeepLink('dsh-desktop://session/a/b'), undefined)
  assert.equal(parseDesktopDeepLink('dsh-desktop://settings/a/b'), undefined)
  assert.equal(parseDesktopDeepLink('dsh-desktop://settings/unknown'), undefined)
  assert.equal(parseDesktopDeepLink('dsh-desktop://user:password@session/id'), undefined)
  assert.equal(parseDesktopDeepLink('not a URL'), undefined)
})

test('queues commands until delivery is available and deduplicates pending targets', () => {
  const queue = new DesktopCommandQueue()
  queue.enqueue({ type: 'session.open', sessionId: 'one' })
  queue.enqueue({ type: 'session.open', sessionId: 'one' })
  queue.enqueue({ type: 'workspace.open', workspaceId: 'two' })

  assert.equal(queue.size, 2)
  assert.equal(queue.drain(() => false), 0)
  const delivered: string[] = []
  assert.equal(queue.drain(command => {
    delivered.push(command.type)
    return true
  }), 2)
  assert.deepEqual(delivered, ['session.open', 'workspace.open'])
  assert.equal(queue.size, 0)
})
