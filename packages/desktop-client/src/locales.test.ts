import assert from 'node:assert/strict'
import test from 'node:test'

import { en, zh } from './locales.js'

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!).sort()
}

test('ships balanced English and Chinese desktop dictionaries', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key)
  }
})
