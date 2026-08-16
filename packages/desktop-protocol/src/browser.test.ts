import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_OBSERVATION_VERSION,
  parseBrowserClickParams,
  parseBrowserFrame,
  parseBrowserHistory,
  parseBrowserNavigateParams,
  parseBrowserObservation,
  parseBrowserSettings,
  parseBrowserState,
  parseBrowserTypeParams,
  parseBrowserUiPointerInput,
  parseBrowserUiScrollInput,
  parseControlledBrowserUrl,
  parseUpdateBrowserSettingsInput,
} from './browser.js'

const settings = {
  enabled: true,
  webUrlTarget: 'system' as const,
  localUrlTarget: 'controlled' as const,
  screenshotPolicy: 'always' as const,
  storageMode: 'isolated' as const,
}

test('validates browser settings and controlled URLs', () => {
  assert.deepEqual(parseBrowserSettings(settings), settings)
  assert.deepEqual(parseUpdateBrowserSettingsInput({
    enabled: false,
    screenshotPolicy: 'on-demand',
  }), {
    enabled: false,
    screenshotPolicy: 'on-demand',
  })
  assert.equal(parseUpdateBrowserSettingsInput({}), undefined)
  assert.equal(parseControlledBrowserUrl('file:///etc/passwd'), undefined)
  assert.equal(parseControlledBrowserUrl('https://user:secret@example.com'), undefined)
  assert.equal(parseControlledBrowserUrl('javascript:alert(1)'), undefined)
  assert.equal(parseControlledBrowserUrl('https://example.com/docs'), 'https://example.com/docs')
})

test('validates bounded browser state, frame, history, and observations', () => {
  const summary = {
    snapshotId: 'snapshot-1',
    tabId: 'tab-1',
    observedAt: '2026-08-16T08:00:00.000Z',
    url: 'https://example.com/',
    title: 'Example',
  }
  const state = {
    revision: 3,
    settings,
    runtimeStatus: 'ready' as const,
    tabs: [{ id: 'tab-1', url: summary.url, title: summary.title, loading: false }],
    activeTabId: 'tab-1',
    canGoBack: false,
    canGoForward: true,
    historyCount: 1,
    lastObservation: summary,
  }
  assert.deepEqual(parseBrowserState(state), state)
  assert.equal(parseBrowserState({ ...state, activeTabId: 'missing' }), undefined)

  const observation = {
    version: BROWSER_OBSERVATION_VERSION,
    ...summary,
    ariaSnapshot: '- heading "Example" [level=1]',
    truncated: false,
    screenshotCaptured: true,
  }
  assert.deepEqual(parseBrowserObservation(observation), observation)
  assert.equal(parseBrowserObservation({ ...observation, version: 99 }), undefined)

  const frame = {
    snapshotId: 'snapshot-1',
    tabId: 'tab-1',
    capturedAt: summary.observedAt,
    mediaType: 'image/jpeg' as const,
    pixelWidth: 1280,
    pixelHeight: 800,
    data: new Uint8Array([1, 2, 3]),
  }
  assert.deepEqual(parseBrowserFrame(frame), frame)
  assert.equal(parseBrowserFrame({ ...frame, data: new Uint8Array(5 * 1024 * 1024 + 1) }), undefined)

  const history = [{ id: 'history-1', url: summary.url, title: summary.title, visitedAt: summary.observedAt }]
  assert.deepEqual(parseBrowserHistory(history), history)
  assert.equal(parseBrowserHistory([...history, history[0]]), undefined)
})

test('requires idempotency and latest-snapshot identities for browser actions', () => {
  assert.deepEqual(parseBrowserNavigateParams({
    actionId: 'navigate-1',
    sessionId: 'session-1',
    url: 'https://example.com',
    newTab: true,
  }), {
    actionId: 'navigate-1',
    sessionId: 'session-1',
    url: 'https://example.com/',
    newTab: true,
  })
  assert.equal(parseBrowserNavigateParams({
    sessionId: 'session-1',
    url: 'https://example.com',
  }), undefined)

  const click = {
    actionId: 'click-1',
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
    role: 'button',
    name: 'Continue',
    exact: true,
  }
  assert.deepEqual(parseBrowserClickParams(click), click)
  assert.equal(parseBrowserClickParams({ ...click, actionId: '' }), undefined)

  const type = {
    actionId: 'type-1',
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
    role: 'textbox',
    name: 'Search',
    text: 'DeepSeek Harness',
    submit: true,
  }
  assert.deepEqual(parseBrowserTypeParams(type), type)
  assert.equal(parseBrowserTypeParams({ ...type, role: '' }), undefined)
})

test('validates snapshot-bound renderer pointer and scroll intents', () => {
  const pointer = {
    snapshotId: 'snapshot-1',
    tabId: 'tab-1',
    normalizedX: 0.25,
    normalizedY: 0.75,
    button: 'right' as const,
  }
  assert.deepEqual(parseBrowserUiPointerInput(pointer), pointer)
  assert.equal(parseBrowserUiPointerInput({ ...pointer, normalizedX: 1.01 }), undefined)
  assert.equal(parseBrowserUiPointerInput({ ...pointer, button: 'middle' }), undefined)

  const scroll = {
    snapshotId: 'snapshot-1',
    tabId: 'tab-1',
    normalizedX: 0.5,
    normalizedY: 0.5,
    deltaX: 0,
    deltaY: 640,
  }
  assert.deepEqual(parseBrowserUiScrollInput(scroll), scroll)
  assert.equal(parseBrowserUiScrollInput({ ...scroll, deltaY: 0 }), undefined)
})
