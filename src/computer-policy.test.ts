import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ComputerControlPolicyStore,
  DEFAULT_COMPUTER_CONTROL_POLICY,
} from './computer-policy'

test('persists one versioned Computer Control policy and restores it after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-policy-'))
  const path = join(root, 'computer-control-policy.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ComputerControlPolicyStore(path)

  assert.deepEqual(store.load(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, recovered: false })
  store.save({
    allowAnyApplication: false,
    lockScreenOperations: true,
    applicationRules: [{ bundleId: 'dev.editor', name: 'Editor', access: 'allow' }],
  })

  assert.deepEqual(new ComputerControlPolicyStore(path).load(), {
    policy: {
      allowAnyApplication: false,
      lockScreenOperations: true,
      applicationRules: [{ bundleId: 'dev.editor', name: 'Editor', access: 'allow' }],
    },
    recovered: false,
  })
  assert.equal((await readFile(path, 'utf8')).includes('"schemaVersion": 1'), true)
})

test('fails closed when the persisted Computer Control policy is corrupt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-policy-'))
  const path = join(root, 'computer-control-policy.v1.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path, '{"schemaVersion":1,"policy":{"allowAnyApplication":true}}')
  const errors: unknown[] = []

  const loaded = new ComputerControlPolicyStore(path, error => errors.push(error)).load()
  assert.equal(loaded.recovered, true)
  assert.deepEqual(loaded.policy, DEFAULT_COMPUTER_CONTROL_POLICY)
  assert.equal(errors.length, 1)
})
