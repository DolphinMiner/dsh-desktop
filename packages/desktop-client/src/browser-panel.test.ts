import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserPanelController } from './browser-panel-controller.js'

test('publishes only real Browser panel visibility transitions', () => {
  const controller = new BrowserPanelController()
  const snapshots: boolean[] = []
  const unsubscribe = controller.subscribe(() => {
    snapshots.push(controller.getSnapshot())
  })

  assert.equal(controller.getSnapshot(), false)
  controller.setOpen(true)
  controller.setOpen(true)
  controller.toggle()
  unsubscribe()
  controller.setOpen(true)

  assert.deepEqual(snapshots, [true, false])
})
