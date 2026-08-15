import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ComputerActionAuditError, ComputerActionAuditStore } from './computer-action-audit'

const target = {
  id: 'window:7:42',
  kind: 'window' as const,
  name: 'Editor',
  applicationName: 'Editor',
  bundleId: 'dev.editor',
  pid: 42,
}

function clock(): () => Date {
  let time = Date.parse('2026-08-16T12:00:00.000Z')
  return () => {
    const value = new Date(time)
    time += 1_000
    return value
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-audit-test-'))
  const path = join(root, 'computer-actions.v1.json')
  return { root, path }
}

test('persists an ordered action chain without typed content', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ComputerActionAuditStore(path, { now: clock() })

  store.recordIntent({
    actionId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-1',
    sourceSnapshotId: 'snapshot-1',
    target,
    action: { kind: 'type', elementId: 'ax:0.1', text: 'private draft', replace: true },
  })
  store.recordApproval('11111111-1111-4111-8111-111111111111')
  store.recordDispatch('11111111-1111-4111-8111-111111111111')
  store.recordOutcome('11111111-1111-4111-8111-111111111111', 'succeeded', 'completed', 'snapshot-2')

  const source = await readFile(path, 'utf8')
  assert.equal(source.includes('private draft'), false)
  assert.equal(source.includes('"textLength": 13'), true)
  assert.deepEqual(store.recent()[0]?.events.map(event => event.phase), [
    'intent', 'approved', 'dispatch', 'succeeded',
  ])
})

test('recovers a dispatched action as ambiguous and rejects replay after restart', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new ComputerActionAuditStore(path, { now: clock() })
  first.recordIntent({
    actionId: '22222222-2222-4222-8222-222222222222',
    sessionId: 'session-1',
    sourceSnapshotId: 'snapshot-1',
    target,
    action: {
      kind: 'click',
      target: { mode: 'element', elementId: 'ax:0.2' },
      button: 'left',
      clickCount: 1,
    },
  })
  first.recordApproval('22222222-2222-4222-8222-222222222222')
  first.recordDispatch('22222222-2222-4222-8222-222222222222')

  const recovered = new ComputerActionAuditStore(path, { now: clock() })
  assert.equal(recovered.recent()[0]?.events.at(-1)?.phase, 'ambiguous')
  assert.equal(recovered.recent()[0]?.events.at(-1)?.reason, 'interrupted-after-dispatch')
  assert.throws(() => recovered.recordIntent({
    actionId: '22222222-2222-4222-8222-222222222222',
    sessionId: 'session-1',
    sourceSnapshotId: 'snapshot-1',
    target,
    action: { kind: 'key', key: 'enter', modifiers: [] },
  }), (error: ComputerActionAuditError) => error.code === 'DUPLICATE_REQUEST')
})

test('cancels a pre-dispatch intent and enforces phase order', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new ComputerActionAuditStore(path, { now: clock() })
  first.recordIntent({
    actionId: '33333333-3333-4333-8333-333333333333',
    sessionId: 'session-1',
    sourceSnapshotId: 'snapshot-1',
    target,
    action: { kind: 'scroll', deltaX: 0, deltaY: 300 },
  })
  assert.throws(
    () => first.recordDispatch('33333333-3333-4333-8333-333333333333'),
    (error: ComputerActionAuditError) => error.code === 'DUPLICATE_REQUEST',
  )

  const recovered = new ComputerActionAuditStore(path, { now: clock() })
  assert.equal(recovered.recent()[0]?.events.at(-1)?.phase, 'cancelled')
  assert.equal(recovered.recent()[0]?.events.at(-1)?.reason, 'interrupted-before-dispatch')
})

test('fails closed when the durable audit file is corrupt', async t => {
  const { root, path } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path, '{"version":1,"actions":[{"text":"secret"}]}')

  const store = new ComputerActionAuditStore(path)
  assert.equal(store.status().available, false)
  assert.throws(() => store.recordIntent({
    actionId: '44444444-4444-4444-8444-444444444444',
    sessionId: 'session-1',
    sourceSnapshotId: 'snapshot-1',
    target,
    action: { kind: 'key', key: 'escape', modifiers: [] },
  }), (error: ComputerActionAuditError) => error.code === 'DESKTOP_UNAVAILABLE')
  assert.equal((await readFile(path, 'utf8')).includes('secret'), true)
})
