import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeBrowserAddress,
  normalizeBrowserAddress,
  normalizedBrowserPoint,
} from './browser-view-model.js'

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

test('maps pointer coordinates through a contained browser frame', () => {
  const bounds = { left: 100, top: 50, width: 1_000, height: 600 }
  const frame = { pixelWidth: 1_280, pixelHeight: 800 }

  assert.deepEqual(normalizedBrowserPoint(600, 350, bounds, frame), {
    normalizedX: 0.5,
    normalizedY: 0.5,
  })
  assert.deepEqual(normalizedBrowserPoint(100, 50, bounds, frame), undefined)
  assert.deepEqual(normalizedBrowserPoint(1_080, 650, bounds, frame), {
    normalizedX: 1,
    normalizedY: 1,
  })
})
