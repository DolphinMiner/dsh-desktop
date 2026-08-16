import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_OBSERVATION_VERSION,
  parseBrowserClickParams,
  parseBrowserFrame,
  parseBrowserHistory,
  parseBrowserNavigateParams,
  parseBrowserObservation,
  parseBrowserSelectParams,
  parseBrowserScreenshotParams,
  parseBrowserSettings,
  parseBrowserState,
  parseBrowserTabParams,
  parseBrowserTabsParams,
  parseBrowserTabsSnapshot,
  parseBrowserTypeParams,
  parseBrowserUiKeyboardInput,
  parseBrowserUiFindInput,
  parseBrowserUiOpenManagementInput,
  parseBrowserUiPointerInput,
  parseBrowserUiScrollInput,
  parseBrowserUiViewportInput,
  parseBrowserUiZoomInput,
  parseControlledBrowserUrl,
  parseUpdateBrowserSettingsInput,
} from './browser.js'

const settings = {
  enabled: true,
  webUrlTarget: 'system' as const,
  localUrlTarget: 'controlled' as const,
  screenshotPolicy: 'always' as const,
  storageMode: 'persistent' as const,
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
  assert.equal(parseUpdateBrowserSettingsInput({ storageMode: 'isolated' }), undefined)
  assert.equal(parseControlledBrowserUrl('file:///etc/passwd'), undefined)
  assert.equal(parseControlledBrowserUrl('https://user:secret@example.com'), undefined)
  assert.equal(parseControlledBrowserUrl('javascript:alert(1)'), undefined)
  assert.equal(parseControlledBrowserUrl('https://example.com/docs'), 'https://example.com/docs')
})

test('allows only fixed Browser management destinations', () => {
  assert.deepEqual(parseBrowserUiOpenManagementInput({ page: 'import' }), { page: 'import' })
  assert.deepEqual(parseBrowserUiOpenManagementInput({ page: 'passwords' }), { page: 'passwords' })
  assert.deepEqual(parseBrowserUiOpenManagementInput({ page: 'contacts' }), { page: 'contacts' })
  assert.deepEqual(parseBrowserUiOpenManagementInput({ page: 'downloads' }), { page: 'downloads' })
  assert.deepEqual(parseBrowserUiOpenManagementInput({ page: 'history' }), { page: 'history' })
  assert.equal(parseBrowserUiOpenManagementInput({ page: 'chrome://settings' }), undefined)
  assert.equal(parseBrowserUiOpenManagementInput({ page: 'passwords', url: 'chrome://settings' }), undefined)
})

test('browser UI find and zoom inputs are bounded', () => {
  assert.deepEqual(parseBrowserUiFindInput({ query: 'Dolphin', forward: false }), {
    query: 'Dolphin',
    forward: false,
  })
  assert.equal(parseBrowserUiFindInput({ query: '' }), undefined)
  assert.equal(parseBrowserUiFindInput({ query: 'Dolphin', forward: 'yes' }), undefined)
  assert.deepEqual(parseBrowserUiZoomInput({ factor: 1.25 }), { factor: 1.25 })
  assert.equal(parseBrowserUiZoomInput({ factor: 0.49 }), undefined)
  assert.equal(parseBrowserUiZoomInput({ factor: Number.NaN }), undefined)
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
    tabs: [{
      id: 'tab-1',
      url: summary.url,
      title: summary.title,
      loading: false,
      faviconDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }],
    activeTabId: 'tab-1',
    canGoBack: false,
    canGoForward: true,
    zoomFactor: 1.1,
    historyCount: 1,
    lastObservation: summary,
  }
  assert.deepEqual(parseBrowserState(state), state)
  assert.equal(parseBrowserState({ ...state, activeTabId: 'missing' }), undefined)
  assert.equal(parseBrowserState({ ...state, zoomFactor: 2.1 }), undefined)
  assert.equal(parseBrowserState({
    ...state,
    tabs: [{ ...state.tabs[0], faviconDataUrl: 'https://example.com/favicon.ico' }],
  }), undefined)

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

test('binds browser screenshot reads to one agent session and observation', () => {
  const input = { sessionId: 'session-1', snapshotId: 'snapshot-1' }
  assert.deepEqual(parseBrowserScreenshotParams(input), input)
  assert.equal(parseBrowserScreenshotParams({ ...input, tabId: 'tab-1' }), undefined)
  assert.equal(parseBrowserScreenshotParams({ ...input, snapshotId: '' }), undefined)
})

test('validates revision-bound browser tab operations and bounded tab snapshots', () => {
  const tabs = {
    version: 1 as const,
    revision: 7,
    activeTabId: 'tab-1',
    tabs: [
      { id: 'tab-1', url: 'https://example.com/', title: 'Example', loading: false },
      { id: 'tab-2', url: 'about:blank', title: '', loading: false },
    ],
  }
  assert.deepEqual(parseBrowserTabsSnapshot(tabs), tabs)
  assert.equal(parseBrowserTabsSnapshot({ ...tabs, activeTabId: 'missing' }), undefined)
  assert.deepEqual(parseBrowserTabsParams({ sessionId: 'session-1' }), { sessionId: 'session-1' })
  assert.equal(parseBrowserTabsParams({ sessionId: 'session-1', extra: true }), undefined)

  const activate = {
    actionId: 'tab-1',
    sessionId: 'session-1',
    revision: 7,
    action: 'activate' as const,
    tabId: 'tab-2',
  }
  assert.deepEqual(parseBrowserTabParams(activate), activate)
  assert.equal(parseBrowserTabParams({ ...activate, tabId: undefined }), undefined)
  assert.deepEqual(parseBrowserTabParams({
    actionId: 'tab-new',
    sessionId: 'session-1',
    revision: 7,
    action: 'new',
  }), {
    actionId: 'tab-new',
    sessionId: 'session-1',
    revision: 7,
    action: 'new',
  })
  assert.equal(parseBrowserTabParams({ ...activate, action: 'new' }), undefined)
})

test('requires a latest browser snapshot for native dropdown selection', () => {
  const input = {
    actionId: 'select-1',
    sessionId: 'session-1',
    snapshotId: 'snapshot-1',
    name: 'Country',
    option: 'China',
    exact: true,
  }
  assert.deepEqual(parseBrowserSelectParams(input), input)
  assert.equal(parseBrowserSelectParams({ ...input, option: '' }), undefined)
  assert.equal(parseBrowserSelectParams({ ...input, snapshotId: '' }), undefined)
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

test('accepts only bounded integer browser viewport dimensions', () => {
  assert.deepEqual(parseBrowserUiViewportInput({ pixelWidth: 512, pixelHeight: 820 }), {
    pixelWidth: 512,
    pixelHeight: 820,
  })
  assert.equal(parseBrowserUiViewportInput({ pixelWidth: 239, pixelHeight: 820 }), undefined)
  assert.equal(parseBrowserUiViewportInput({ pixelWidth: 512.5, pixelHeight: 820 }), undefined)
  assert.equal(parseBrowserUiViewportInput({ pixelWidth: 512, pixelHeight: 2_561 }), undefined)
  assert.equal(parseBrowserUiViewportInput({ pixelWidth: 512, pixelHeight: 820, scale: 2 }), undefined)
})

test('validates bounded snapshot-bound renderer keyboard batches', () => {
  const input = {
    snapshotId: 'snapshot-1',
    tabId: 'tab-1',
    actions: [
      { kind: 'text' as const, text: 'hello' },
      { kind: 'press' as const, key: 'Enter' },
      { kind: 'press' as const, key: 'a', modifiers: ['Meta' as const] },
    ],
  }
  assert.deepEqual(parseBrowserUiKeyboardInput(input), input)
  assert.equal(parseBrowserUiKeyboardInput({ ...input, actions: [] }), undefined)
  assert.equal(parseBrowserUiKeyboardInput({ ...input, actions: [{ kind: 'press', key: 'Shift' }] }), undefined)
  assert.equal(parseBrowserUiKeyboardInput({
    ...input,
    actions: [{ kind: 'press', key: 'a', modifiers: ['Meta', 'Meta'] }],
  }), undefined)
  assert.equal(parseBrowserUiKeyboardInput({
    ...input,
    actions: Array.from({ length: 65 }, () => ({ kind: 'press', key: 'Enter' })),
  }), undefined)
})
