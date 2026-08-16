import assert from 'node:assert/strict'
import test from 'node:test'

import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

import { isMutablePluginModule, PluginPolicyReconciler } from './plugin-policy.js'

class FakeEntry {
  readonly calls: boolean[] = []
  fail = false

  constructor(
    readonly id: string,
    readonly options: { name: string },
    public disabled: boolean,
  ) {}

  async update(options: { disabled?: boolean | null }): Promise<void> {
    const disabled = options.disabled === true
    this.calls.push(disabled)
    if (this.fail) throw new Error('activation failed')
    this.disabled = disabled
  }
}

function loader(...entries: FakeEntry[]): { entries(): Iterable<Entry> } {
  return { entries: () => entries as unknown as Entry[] }
}

test('allows Skills and third-party packages but protects Harness internals', () => {
  assert.equal(isMutablePluginModule('@deepseek-ai/dsh-skill-filesystem'), true)
  assert.equal(isMutablePluginModule('@acme/dsh-plugin-review'), true)
  assert.equal(isMutablePluginModule('plain-plugin'), true)
  assert.equal(isMutablePluginModule('@deepseek-ai/dsh-agent'), false)
  assert.equal(isMutablePluginModule('@dolphinminer/dsh-desktop-host'), false)
  assert.equal(isMutablePluginModule('cordis:include'), false)
  assert.equal(isMutablePluginModule('./local-plugin.js'), false)
})

test('applies explicit enable and disable choices idempotently', async () => {
  const entry = new FakeEntry('include:skill-filesystem', {
    name: '@deepseek-ai/dsh-skill-filesystem',
  }, true)
  const reconciler = new PluginPolicyReconciler(loader(entry))
  const enabled = {
    overrides: {
      [entry.id]: { moduleName: entry.options.name, enabled: true },
    },
  }

  await reconciler.reconcile(enabled)
  await reconciler.reconcile(enabled)
  assert.equal(entry.disabled, false)
  assert.deepEqual(entry.calls, [false])

  await reconciler.reconcile({
    overrides: {
      [entry.id]: { moduleName: entry.options.name, enabled: false },
    },
  })
  assert.equal(entry.disabled, true)
  assert.deepEqual(entry.calls, [false, true])
})

test('fails closed for stale identities and immutable plugins', async () => {
  const stale = new FakeEntry('plugin', { name: '@acme/current' }, false)
  const core = new FakeEntry('core', { name: '@deepseek-ai/dsh-agent' }, false)
  const failures: string[] = []
  const reconciler = new PluginPolicyReconciler(loader(stale, core), message => failures.push(message))

  await reconciler.reconcile({
    overrides: {
      plugin: { moduleName: '@acme/old', enabled: false },
      core: { moduleName: core.options.name, enabled: false },
    },
  })
  assert.deepEqual(stale.calls, [])
  assert.deepEqual(core.calls, [])
  assert.equal(failures.length, 2)
})

test('contains failed activation and permits a later cold-start retry', async () => {
  const entry = new FakeEntry('skill', { name: '@deepseek-ai/dsh-skill-badge' }, true)
  entry.fail = true
  const policy = { overrides: { skill: { moduleName: entry.options.name, enabled: true } } }
  const first = new PluginPolicyReconciler(loader(entry))
  await assert.rejects(first.reconcile(policy), /activation failed/)
  assert.equal(entry.disabled, true)

  entry.fail = false
  const restarted = new PluginPolicyReconciler(loader(entry))
  await restarted.reconcile(policy)
  assert.equal(entry.disabled, false)
})

test('serializes concurrent Loader updates', async () => {
  const entry = new FakeEntry('skill', { name: '@deepseek-ai/dsh-skill-badge' }, true)
  let release: (() => void) | undefined
  let active = 0
  let maximum = 0
  entry.update = async options => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise<void>(resolve => { release = resolve })
    entry.disabled = options.disabled === true
    active -= 1
  }
  const reconciler = new PluginPolicyReconciler(loader(entry))
  const enable = reconciler.reconcile({
    overrides: { skill: { moduleName: entry.options.name, enabled: true } },
  })
  await new Promise(resolve => setImmediate(resolve))
  const disable = reconciler.reconcile({
    overrides: { skill: { moduleName: entry.options.name, enabled: false } },
  })
  release?.()
  await enable
  await new Promise(resolve => setImmediate(resolve))
  release?.()
  await disable
  assert.equal(maximum, 1)
  assert.equal(entry.disabled, true)
})
