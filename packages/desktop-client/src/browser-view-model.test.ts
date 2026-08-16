import assert from 'node:assert/strict'
import test from 'node:test'

import { activeBrowserAddress, normalizeBrowserAddress } from './browser-view-model.js'

test('projects the address from the active browser tab', () => {
  const tabs = [
    { id: 'tab-1', url: 'https://example.com/', title: 'Example', loading: false },
    { id: 'tab-2', url: 'about:blank', title: '', loading: false },
  ]

  assert.equal(activeBrowserAddress({ tabs, activeTabId: 'tab-1' }), 'https://example.com/')
  assert.equal(activeBrowserAddress({ tabs, activeTabId: 'tab-2' }), '')
  assert.equal(activeBrowserAddress({ tabs, activeTabId: undefined }), '')
})

test('normalizes browser addresses without rewriting explicit schemes', () => {
  assert.equal(normalizeBrowserAddress(' example.com '), 'https://example.com')
  assert.equal(normalizeBrowserAddress('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBrowserAddress(''), '')
})
