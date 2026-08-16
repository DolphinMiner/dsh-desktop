import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_DESKTOP_PLUGIN_POLICY_OVERRIDES,
  parseDesktopPluginPolicy,
  parseDesktopPluginPolicySnapshot,
  parseInstallDesktopPluginInput,
  parseUpdateDesktopPluginPolicyInput,
} from './plugin-policy.js'

test('parses bounded plugin policy snapshots without retaining input objects', () => {
  const value = {
    revision: 3,
    overrides: {
      'include:skill-filesystem': {
        moduleName: '@deepseek-ai/dsh-skill-filesystem',
        enabled: true,
      },
    },
  }
  const parsed = parseDesktopPluginPolicySnapshot(value)
  assert.deepEqual(parsed, value)
  assert.notEqual(parsed?.overrides, value.overrides)
  assert.deepEqual(parseDesktopPluginPolicy({ overrides: value.overrides }), { overrides: value.overrides })
})

test('parses one revision-bound plugin policy mutation', () => {
  const value = {
    expectedRevision: 4,
    entryId: 'include:skill-badge',
    moduleName: '@deepseek-ai/dsh-skill-badge',
    enabled: false,
  }
  assert.deepEqual(parseUpdateDesktopPluginPolicyInput(value), value)
  assert.equal(parseUpdateDesktopPluginPolicyInput({ ...value, extra: true }), undefined)
  assert.equal(parseUpdateDesktopPluginPolicyInput({ ...value, entryId: ' bad' }), undefined)
})

test('rejects malformed, polluted, or unbounded plugin policies', () => {
  assert.equal(parseDesktopPluginPolicy(undefined), undefined)
  assert.equal(parseDesktopPluginPolicy({ overrides: [] }), undefined)
  assert.equal(parseDesktopPluginPolicy({
    overrides: { plugin: { moduleName: 'example', enabled: 'yes' } },
  }), undefined)
  assert.equal(parseDesktopPluginPolicy({
    overrides: Object.fromEntries(Array.from({ length: MAX_DESKTOP_PLUGIN_POLICY_OVERRIDES + 1 }, (_, index) => [
      `plugin-${String(index)}`,
      { moduleName: `plugin-${String(index)}`, enabled: true },
    ])),
  }), undefined)
  assert.equal(parseDesktopPluginPolicySnapshot({ revision: -1, overrides: {} }), undefined)
  assert.equal(parseDesktopPluginPolicySnapshot({ revision: 0, overrides: {}, extra: true }), undefined)
})

test('parses only one bounded registry plugin package spec', () => {
  assert.deepEqual(parseInstallDesktopPluginInput({ packageSpec: '@acme/dsh-plugin-review@1.2.3' }), {
    packageSpec: '@acme/dsh-plugin-review@1.2.3',
  })
  assert.equal(parseInstallDesktopPluginInput({ packageSpec: ' plugin' }), undefined)
  assert.equal(parseInstallDesktopPluginInput({ packageSpec: 'plugin', args: ['--force'] }), undefined)
  assert.equal(parseInstallDesktopPluginInput({ packageSpec: 'x'.repeat(513) }), undefined)
})
