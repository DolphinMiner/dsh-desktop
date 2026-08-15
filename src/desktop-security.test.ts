import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrustedDesktopBridgeSender } from './desktop-security'

const LOADING_PAGE = 'file:///Applications/DSH%20Desktop.app/Contents/Resources/app/renderer/index.html'

test('allows desktop IPC only from the exact bundled loading page', () => {
  assert.equal(isTrustedDesktopBridgeSender(LOADING_PAGE, LOADING_PAGE), true)
  assert.equal(isTrustedDesktopBridgeSender(`${LOADING_PAGE}?source=harness`, LOADING_PAGE), false)
  assert.equal(isTrustedDesktopBridgeSender('http://127.0.0.1:43127', LOADING_PAGE), false)
  assert.equal(isTrustedDesktopBridgeSender('https://example.com', LOADING_PAGE), false)
})
