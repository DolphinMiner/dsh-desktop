import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { AppSnapshotCapture } from '@dolphinminer/dsh-desktop-protocol'

import { attachAppSnapshotCapture, mountAppSnapshotDelivery } from './app-snapshot-delivery.js'

const capture: AppSnapshotCapture = {
  id: 'capture-1',
  capturedAt: '2026-08-16T05:00:00.000Z',
  sourceName: 'Safari',
  bundleId: 'com.apple.Safari',
  pixelWidth: 1200,
  pixelHeight: 750,
  destination: { kind: 'automatic' },
  mediaType: 'image/jpeg',
  fileName: 'app-snapshot.jpg',
  data: new Uint8Array([1, 2, 3]),
  ocrText: 'Visible page text',
}

function fixture(options: { withSession?: boolean; acceptImages?: boolean } = {}): {
  ctx: ClientContext
  operations: string[]
  draft: () => string
} {
  const operations: string[] = []
  let draft = 'Existing request'
  const withSession = options.withSession ?? true
  const input = {
    state: { getSnapshot: () => ({ draft, imageIds: [], phase: 'plain' }) },
    addImages: (ids: readonly string[]) => {
      operations.push(`images.add:${ids.join(',')}`)
      return options.acceptImages ?? true
    },
    setDraft: (value: string) => {
      draft = value
      operations.push('draft.set')
    },
    notify: (_level: string, message: string) => { operations.push(`notify:${message}`) },
  }
  const session = {
    projections: {
      faceOf: () => ({ getSnapshot: () => undefined }),
    },
  }
  const ctx = {
    effect: (register: () => (() => void)) => register(),
    sessions: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          ids: withSession ? ['session-1'] : [],
          byId: withSession ? { 'session-1': { displayTitle: 'Project chat' } } : {},
          current: withSession ? 'session-1' : undefined,
        }),
      },
      binding: () => withSession ? { session } : undefined,
      scope: () => withSession ? {} : undefined,
      open: (id: string) => { operations.push(`session.open:${id}`) },
    },
    conversation: {
      input: { for: () => input },
      draftImages: () => [],
      createDraftImages: (files: readonly File[]) => {
        operations.push(`image.create:${files[0]?.type}:${String(files[0]?.size)}`)
        return [{ id: 'draft-image-1', file: files[0], previewUrl: 'blob:test', kind: 'image' }]
      },
      releaseDraftImages: () => { operations.push('images.release') },
    },
  } as unknown as ClientContext
  return { ctx, operations, draft: () => draft }
}

test('adds one App Snapshot through the official draft attachment and input boundaries', async () => {
  const runtime = fixture()
  const title = await attachAppSnapshotCapture(runtime.ctx, capture)

  assert.equal(title, 'Project chat')
  assert.deepEqual(runtime.operations, [
    'image.create:image/jpeg:3',
    'images.add:draft-image-1',
    'draft.set',
    'session.open:session-1',
    'notify:App snapshot from Safari added to the draft.',
  ])
  assert.match(runtime.draft(), /Existing request\n\nApp snapshot from Safari\./)
  assert.match(runtime.draft(), /Extracted text:\nVisible page text/)
})

test('keeps the image out of the draft when admission is busy or no conversation exists', async () => {
  const busy = fixture({ acceptImages: false })
  await assert.rejects(attachAppSnapshotCapture(busy.ctx, capture), /current prompt submission/)
  assert.deepEqual(busy.operations, [
    'image.create:image/jpeg:3',
    'images.add:draft-image-1',
    'images.release',
  ])

  const empty = fixture({ withSession: false })
  await assert.rejects(attachAppSnapshotCapture(empty.ctx, capture), /Open a conversation/)
  assert.deepEqual(empty.operations, [])
})

test('installs App Snapshot delivery in the conversation injector scope', async () => {
  const runtime = fixture()
  let injected = false
  let deliver: ((capture: AppSnapshotCapture) => void) | undefined
  const root = {
    inject(dependencies: readonly string[], apply: (scope: ClientContext) => void) {
      assert.deepEqual(dependencies, ['conversation'])
      injected = true
      apply(runtime.ctx)
    },
    get conversation(): never {
      throw new Error('root conversation access is forbidden')
    },
  } as unknown as ClientContext

  mountAppSnapshotDelivery(root, scope => {
    deliver = value => { void attachAppSnapshotCapture(scope, value) }
    return () => { deliver = undefined }
  })
  assert.equal(injected, true)
  assert.ok(deliver, 'capture listener should be installed')
  deliver(capture)
  await new Promise(resolve => setImmediate(resolve))

  assert.ok(runtime.operations.includes('images.add:draft-image-1'))
  assert.ok(runtime.operations.includes('session.open:session-1'))
})
