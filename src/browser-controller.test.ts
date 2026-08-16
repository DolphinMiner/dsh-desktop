import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { BrowserFrame, BrowserUiKeyboardAction } from '@dolphinminer/dsh-desktop-protocol'

import { BrowserController, isLocalBrowserUrl } from './browser-controller'
import { BrowserStore } from './browser-store'
import type {
  BrowserEngine,
  BrowserEngineObservation,
  BrowserEngineState,
  PlaywrightBrowserLaunchOptions,
} from './playwright-browser'

class FakeBrowserEngine implements BrowserEngine {
  starts = 0
  stops = 0
  clicks = 0
  pointerClicks: Array<{ x: number; y: number; button: 'left' | 'right' }> = []
  typed: string[] = []
  scrolls = 0
  pointerScrolls: Array<{ x: number; y: number; deltaX: number; deltaY: number }> = []
  keyboardBatches: BrowserUiKeyboardAction[][] = []
  captures: boolean[] = []
  url = 'about:blank'
  title = ''
  activeTabId = 'tab-1'
  tabs = ['tab-1']

  start(_options: PlaywrightBrowserLaunchOptions, _signal: AbortSignal): Promise<void> {
    this.starts += 1
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.stops += 1
    return Promise.resolve()
  }

  state(): Promise<BrowserEngineState> {
    return Promise.resolve({
      tabs: this.tabs.map(id => ({ id, url: id === this.activeTabId ? this.url : 'about:blank', title: '', loading: false })),
      activeTabId: this.activeTabId,
      canGoBack: this.url !== 'about:blank',
      canGoForward: false,
    })
  }

  navigate(url: string, newTab: boolean): Promise<void> {
    if (newTab) {
      this.activeTabId = `tab-${String(this.tabs.length + 1)}`
      this.tabs.push(this.activeTabId)
    }
    this.url = url
    this.title = 'Example'
    return Promise.resolve()
  }

  observe(tabId: string | undefined, captureScreenshot: boolean): Promise<BrowserEngineObservation> {
    this.captures.push(captureScreenshot)
    if (tabId !== undefined) this.activeTabId = tabId
    return Promise.resolve({
      tabId: this.activeTabId,
      url: this.url,
      title: this.title,
      ariaSnapshot: '- heading "Example" [level=1]\n- button "Continue"',
      truncated: false,
      ...(captureScreenshot ? {
        screenshot: { data: new Uint8Array([1, 2, 3]), pixelWidth: 1280, pixelHeight: 800 },
      } : {}),
    })
  }

  click(): Promise<void> {
    this.clicks += 1
    this.title = 'Clicked'
    return Promise.resolve()
  }

  clickAt(
    _tabId: string,
    normalizedX: number,
    normalizedY: number,
    button: 'left' | 'right',
  ): Promise<void> {
    this.pointerClicks.push({ x: normalizedX, y: normalizedY, button })
    this.title = 'Pointer clicked'
    return Promise.resolve()
  }

  type(_tabId: string, _role: string, _name: string, text: string): Promise<void> {
    this.typed.push(text)
    return Promise.resolve()
  }

  scroll(): Promise<void> {
    this.scrolls += 1
    return Promise.resolve()
  }

  scrollAt(
    _tabId: string,
    normalizedX: number,
    normalizedY: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    this.pointerScrolls.push({ x: normalizedX, y: normalizedY, deltaX, deltaY })
    return Promise.resolve()
  }

  keyboard(_tabId: string, actions: BrowserUiKeyboardAction[]): Promise<void> {
    this.keyboardBatches.push(actions)
    this.title = 'Keyboard input'
    return Promise.resolve()
  }

  activate(tabId: string): Promise<void> {
    this.activeTabId = tabId
    return Promise.resolve()
  }

  newTab(): Promise<void> {
    this.activeTabId = `tab-${String(this.tabs.length + 1)}`
    this.tabs.push(this.activeTabId)
    this.url = 'about:blank'
    return Promise.resolve()
  }

  closeTab(tabId: string): Promise<void> {
    this.tabs = this.tabs.filter(id => id !== tabId)
    if (this.tabs.length === 0) this.tabs.push('tab-new')
    this.activeTabId = this.tabs[0]
    return Promise.resolve()
  }

  goBack(): Promise<void> {
    this.url = 'about:blank'
    return Promise.resolve()
  }

  goForward(): Promise<void> {
    return Promise.resolve()
  }

  reload(): Promise<void> {
    return Promise.resolve()
  }
}

async function fixture(): Promise<{
  root: string
  engine: FakeBrowserEngine
  frames: Array<BrowserFrame | undefined>
  controller: BrowserController
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-controller-'))
  const engine = new FakeBrowserEngine()
  const frames: Array<BrowserFrame | undefined> = []
  const controller = new BrowserController(
    new BrowserStore(join(root, 'browser.v1.json')),
    engine,
    {
      profilePath: join(root, 'profile'),
      now: () => new Date('2026-08-16T08:00:00.000Z'),
      onFrame: frame => frames.push(frame),
    },
  )
  return { root, engine, frames, controller }
}

test('runs one Main-owned browser lifecycle and persists its policy', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })

  const initial = await runtime.controller.start()
  assert.equal(initial.settings.enabled, false)
  assert.equal(runtime.engine.starts, 0)

  const enabled = await runtime.controller.update({ enabled: true })
  assert.equal(enabled.runtimeStatus, 'ready')
  assert.equal(runtime.engine.starts, 1)
  assert.equal(runtime.controller.shouldOpenControlled('http://localhost:3000'), true)
  assert.equal(runtime.controller.shouldOpenControlled('https://example.com'), false)

  const restored = new BrowserStore(join(runtime.root, 'browser.v1.json')).load()
  assert.equal(restored.settings.enabled, true)
})

test('rejects stale actions, deduplicates action IDs, and re-observes after actions', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start()
  await runtime.controller.update({ enabled: true })
  const first = await runtime.controller.navigate({
    actionId: 'navigate-1',
    sessionId: 'session-1',
    url: 'https://example.com/',
  }, new AbortController().signal)
  assert.equal(first.screenshotCaptured, true)
  assert.equal(runtime.controller.snapshot().historyCount, 1)

  const click = {
    actionId: 'click-1',
    sessionId: 'session-1',
    snapshotId: first.snapshotId,
    role: 'button',
    name: 'Continue',
  }
  const second = await runtime.controller.click(click, new AbortController().signal)
  assert.notEqual(second.snapshotId, first.snapshotId)
  assert.equal(runtime.engine.clicks, 1)
  assert.deepEqual(
    await runtime.controller.click(click, new AbortController().signal),
    second,
  )
  assert.equal(runtime.engine.clicks, 1)

  await assert.rejects(runtime.controller.click({
    ...click,
    actionId: 'click-stale',
  }, new AbortController().signal), error => {
    assert.equal((error as { code?: string }).code, 'TARGET_CHANGED')
    return true
  })
  assert.equal(runtime.frames.some(frame => frame?.snapshotId === second.snapshotId), true)
})

test('clear data stops, removes the profile, and restarts only when enabled', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start()
  await runtime.controller.update({ enabled: true, storageMode: 'persistent' })
  const profile = join(runtime.root, 'profile')
  await writeFile(join(runtime.root, 'marker'), 'kept')
  await writeFile(profile, 'profile-data')

  const cleared = await runtime.controller.clearData()
  assert.equal(cleared.historyCount, 0)
  assert.equal(cleared.runtimeStatus, 'ready')
  assert.equal(runtime.engine.stops >= 1, true)
  assert.equal(runtime.engine.starts >= 2, true)
})

test('keeps the renderer preview independent from the Agent screenshot policy', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start()
  await runtime.controller.update({ enabled: true, screenshotPolicy: 'never' })

  const agentObservation = await runtime.controller.observe(
    { sessionId: 'session-1' },
    new AbortController().signal,
  )
  assert.equal(agentObservation.screenshotCaptured, false)
  assert.equal(runtime.engine.captures.at(-1), false)
  await assert.rejects(runtime.controller.screenshot({
    sessionId: 'session-1',
    snapshotId: agentObservation.snapshotId,
  }), error => {
    assert.equal((error as { code?: string }).code, 'NOT_FOUND')
    return true
  })

  await runtime.controller.navigateFromUi({ url: 'https://example.com/' })

  assert.equal(runtime.engine.captures.at(-1), true)
  assert.equal(runtime.frames.at(-1)?.pixelWidth, 1280)
})

test('returns only the latest session-bound browser screenshot as a defensive copy', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start()
  await runtime.controller.update({ enabled: true, screenshotPolicy: 'always' })
  const observation = await runtime.controller.observe(
    { sessionId: 'session-1' },
    new AbortController().signal,
  )

  const first = await runtime.controller.screenshot({
    sessionId: 'session-1',
    snapshotId: observation.snapshotId,
  })
  first.data[0] = 99
  const second = await runtime.controller.screenshot({
    sessionId: 'session-1',
    snapshotId: observation.snapshotId,
  })
  assert.deepEqual(second.data, new Uint8Array([1, 2, 3]))

  await assert.rejects(runtime.controller.screenshot({
    sessionId: 'another-session',
    snapshotId: observation.snapshotId,
  }), error => {
    assert.equal((error as { code?: string }).code, 'TARGET_CHANGED')
    return true
  })
})

test('binds direct pointer and scroll intents to the rendered browser snapshot', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start()
  await runtime.controller.update({ enabled: true })
  await runtime.controller.navigateFromUi({ url: 'https://example.com/' })
  const first = runtime.controller.snapshot().lastObservation!

  const clicked = await runtime.controller.pointerFromUi({
    snapshotId: first.snapshotId,
    tabId: first.tabId,
    normalizedX: 0.25,
    normalizedY: 0.75,
    button: 'right',
  })
  assert.deepEqual(runtime.engine.pointerClicks, [{ x: 0.25, y: 0.75, button: 'right' }])
  assert.notEqual(clicked.lastObservation?.snapshotId, first.snapshotId)

  await assert.rejects(runtime.controller.scrollFromUi({
    snapshotId: first.snapshotId,
    tabId: first.tabId,
    normalizedX: 0.5,
    normalizedY: 0.5,
    deltaX: 0,
    deltaY: 320,
  }), error => {
    assert.equal((error as { code?: string }).code, 'TARGET_CHANGED')
    return true
  })

  await runtime.controller.scrollFromUi({
    snapshotId: clicked.lastObservation!.snapshotId,
    tabId: clicked.lastObservation!.tabId,
    normalizedX: 0.5,
    normalizedY: 0.5,
    deltaX: 0,
    deltaY: 320,
  })
  assert.deepEqual(runtime.engine.pointerScrolls, [{ x: 0.5, y: 0.5, deltaX: 0, deltaY: 320 }])
})

test('serializes direct keyboard batches against the latest rendered browser snapshot', async t => {
  const runtime = await fixture()
  t.after(async () => {
    await runtime.controller.dispose()
    await rm(runtime.root, { recursive: true, force: true })
  })
  await runtime.controller.start()
  await runtime.controller.update({ enabled: true })
  await runtime.controller.navigateFromUi({ url: 'https://example.com/' })
  const first = runtime.controller.snapshot().lastObservation!
  const actions: BrowserUiKeyboardAction[] = [
    { kind: 'text', text: 'hello' },
    { kind: 'press', key: 'Enter' },
  ]

  const typed = await runtime.controller.keyboardFromUi({
    snapshotId: first.snapshotId,
    tabId: first.tabId,
    actions,
  })
  assert.deepEqual(runtime.engine.keyboardBatches, [actions])
  assert.notEqual(typed.lastObservation?.snapshotId, first.snapshotId)

  await assert.rejects(runtime.controller.keyboardFromUi({
    snapshotId: first.snapshotId,
    tabId: first.tabId,
    actions: [{ kind: 'press', key: 'Tab' }],
  }), error => {
    assert.equal((error as { code?: string }).code, 'TARGET_CHANGED')
    return true
  })
})

test('classifies only local development hosts as local browser URLs', () => {
  assert.equal(isLocalBrowserUrl('http://localhost:5173'), true)
  assert.equal(isLocalBrowserUrl('https://docs.local/path'), true)
  assert.equal(isLocalBrowserUrl('https://example.com'), false)
  assert.equal(isLocalBrowserUrl('not a url'), false)
})
