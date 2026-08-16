import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PluginPolicyController,
  PluginPolicyPersistence,
  PluginPolicyStore,
} from './plugin-policy'

test('persists one revisioned plugin policy and restores it after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-policy-'))
  const path = join(root, 'plugins.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const changes: number[] = []
  const controller = new PluginPolicyController(new PluginPolicyStore(path), snapshot => {
    changes.push(snapshot.revision)
  })

  assert.deepEqual(controller.snapshot(), { revision: 0, overrides: {} })
  const updated = controller.update({
    expectedRevision: 0,
    entryId: 'include:skill-badge',
    moduleName: '@deepseek-ai/dsh-skill-badge',
    enabled: true,
  })
  assert.equal(updated.revision, 1)
  assert.deepEqual(changes, [1])
  assert.deepEqual(new PluginPolicyController(new PluginPolicyStore(path)).snapshot(), updated)
  assert.equal((await readFile(path, 'utf8')).includes('"schemaVersion": 1'), true)
})

test('rejects stale writes and keeps failed persistence out of visible state', () => {
  let fail = false
  const persistence: PluginPolicyPersistence = {
    load: () => ({ revision: 2, policy: { overrides: {} }, recovered: false }),
    save: () => { if (fail) throw new Error('disk full') },
  }
  const controller = new PluginPolicyController(persistence)
  assert.throws(() => controller.update({
    expectedRevision: 1,
    entryId: 'plugin',
    moduleName: '@acme/plugin',
    enabled: true,
  }), /changed/)

  fail = true
  assert.throws(() => controller.update({
    expectedRevision: 2,
    entryId: 'plugin',
    moduleName: '@acme/plugin',
    enabled: true,
  }), /disk full/)
  assert.deepEqual(controller.snapshot(), { revision: 2, overrides: {} })
})

test('fails closed on corrupt storage and clears the recovery notice after a valid write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-policy-'))
  const path = join(root, 'plugins.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path, '{"schemaVersion":1,"revision":4,"policy":{"overrides":[]}}')
  const errors: unknown[] = []
  const controller = new PluginPolicyController(new PluginPolicyStore(path, error => errors.push(error)))

  assert.equal(controller.snapshot().revision, 0)
  assert.match(controller.snapshot().statusMessage ?? '', /reset/)
  assert.equal(errors.length, 1)
  const updated = controller.update({
    expectedRevision: 0,
    entryId: 'include:skill-filesystem',
    moduleName: '@deepseek-ai/dsh-skill-filesystem',
    enabled: false,
  })
  assert.equal(updated.statusMessage, undefined)
  assert.equal(updated.revision, 1)
})
