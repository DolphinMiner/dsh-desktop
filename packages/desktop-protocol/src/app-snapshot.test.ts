import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseAppSnapshotCapture,
  parseAppSnapshotSettings,
  parseAppSnapshotState,
  parseUpdateAppSnapshotSettingsInput,
} from './app-snapshot.js'

const settings = {
  shortcut: 'CommandOrControl+Shift+2' as const,
  destination: { kind: 'automatic' as const },
  captureSound: true,
}

test('validates durable App Snapshot settings and partial updates', () => {
  assert.deepEqual(parseAppSnapshotSettings(settings), settings)
  assert.deepEqual(parseUpdateAppSnapshotSettingsInput({
    destination: { kind: 'session', sessionId: 'session-1' },
    captureSound: false,
  }), {
    destination: { kind: 'session', sessionId: 'session-1' },
    captureSound: false,
  })
  assert.equal(parseAppSnapshotSettings({ ...settings, shortcut: 'Command+Space' }), undefined)
  assert.equal(parseUpdateAppSnapshotSettingsInput({ captureSound: true, extra: true }), undefined)
})

test('validates bounded App Snapshot state and in-memory image delivery', () => {
  const state = {
    revision: 2,
    settings,
    shortcutRegistered: true,
    capturing: false,
    permissions: {
      supported: true,
      screenRecording: 'granted' as const,
      accessibility: 'denied' as const,
      canObserve: true,
      canAct: false,
    },
    lastCapture: {
      id: 'capture-1',
      capturedAt: '2026-08-16T04:00:00.000Z',
      sourceName: 'Safari',
      bundleId: 'com.apple.Safari',
      pixelWidth: 1600,
      pixelHeight: 1000,
    },
  }
  assert.deepEqual(parseAppSnapshotState(state), state)

  const capture = {
    ...state.lastCapture,
    destination: settings.destination,
    mediaType: 'image/jpeg' as const,
    fileName: 'app-snapshot.jpg',
    data: new Uint8Array([1, 2, 3]),
    ocrText: 'Visible text',
  }
  assert.deepEqual(parseAppSnapshotCapture(capture), capture)
  assert.equal(parseAppSnapshotCapture({ ...capture, data: new Uint8Array(5 * 1024 * 1024 + 1) }), undefined)
  assert.equal(parseAppSnapshotCapture({ ...capture, pixelWidth: 0 }), undefined)
})
