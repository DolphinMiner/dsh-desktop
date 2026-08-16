import assert from 'node:assert/strict'
import test from 'node:test'

import { DesktopAccessoryController } from './desktop-accessory-controller.js'

test('publishes stable root accessory transitions and returns to the launcher after close', () => {
  const controller = new DesktopAccessoryController()
  const snapshots: Array<{ open: boolean; view: string }> = []
  const initial = controller.getSnapshot()
  const unsubscribe = controller.subscribe(() => {
    snapshots.push(controller.getSnapshot())
  })

  assert.deepEqual(initial, { open: false, view: 'launcher' })
  assert.equal(controller.getSnapshot(), initial)
  controller.open()
  controller.open()
  controller.open('browser')
  controller.close()
  unsubscribe()
  controller.open('files')

  assert.deepEqual(snapshots, [
    { open: true, view: 'launcher' },
    { open: true, view: 'browser' },
    { open: false, view: 'launcher' },
  ])
})
