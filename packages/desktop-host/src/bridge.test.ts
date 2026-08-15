import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createFailureResponse,
  createSuccessResponse,
  DESKTOP_PROTOCOL_VERSION,
  DesktopProtocolMessage,
  parseDesktopProtocolMessage,
} from '@dolphinminer/dsh-desktop-protocol'

import { DesktopCapabilityClient, DesktopCapabilityError, DesktopIpcTransport } from './bridge.js'

class FakeTransport implements DesktopIpcTransport {
  connected = true
  readonly sent: DesktopProtocolMessage[] = []
  private readonly messages = new Set<(message: unknown) => void>()
  private readonly disconnects = new Set<() => void>()

  send(value: unknown): boolean {
    const message = parseDesktopProtocolMessage(value)
    if (message !== undefined) this.sent.push(message)
    return this.connected
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnects.add(listener)
    return () => this.disconnects.delete(listener)
  }

  receive(message: unknown): void {
    for (const listener of this.messages) listener(message)
  }

  disconnect(): void {
    this.connected = false
    for (const listener of this.disconnects) listener()
  }
}

test('resolves a validated response', async () => {
  const transport = new FakeTransport()
  const client = new DesktopCapabilityClient(transport)
  const pending = client.call('desktop.ping', { nonce: 'hello' })
  const request = transport.sent[0]
  if (request?.kind !== 'request') throw new Error('expected a request')
  transport.receive(createSuccessResponse(request.id, {
    nonce: 'hello',
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  }))

  assert.deepEqual(await pending, { nonce: 'hello', protocolVersion: DESKTOP_PROTOCOL_VERSION })
  client.dispose()
})

test('rejects structured failures and invalid responses', async () => {
  const transport = new FakeTransport()
  const client = new DesktopCapabilityClient(transport)
  const failed = client.call('desktop.ping', { nonce: 'failure' })
  const first = transport.sent[0]
  if (first?.kind !== 'request') throw new Error('expected a request')
  transport.receive(createFailureResponse(first.id, {
    code: 'METHOD_NOT_FOUND',
    message: 'missing',
  }))
  await assert.rejects(failed, (error: unknown) => {
    return error instanceof DesktopCapabilityError && error.code === 'METHOD_NOT_FOUND'
  })

  const malformed = client.call('desktop.ping', { nonce: 'bad-result' })
  const second = transport.sent[1]
  if (second?.kind !== 'request') throw new Error('expected a request')
  transport.receive(createSuccessResponse(second.id, { nope: true }))
  await assert.rejects(malformed, (error: unknown) => {
    return error instanceof DesktopCapabilityError && error.code === 'BAD_MESSAGE'
  })
  client.dispose()
})

test('cancels timed out work and rejects all work on disconnect', async () => {
  const transport = new FakeTransport()
  const client = new DesktopCapabilityClient(transport)
  const timedOut = client.call('desktop.ping', { nonce: 'slow' }, { timeoutMs: 5 })
  await assert.rejects(timedOut, (error: unknown) => {
    return error instanceof DesktopCapabilityError && error.code === 'TIMEOUT' && error.ambiguous
  })
  assert.equal(transport.sent.some(message => message.kind === 'cancel'), true)

  const disconnected = client.call('desktop.ping', { nonce: 'disconnect' })
  transport.disconnect()
  await assert.rejects(disconnected, (error: unknown) => {
    return error instanceof DesktopCapabilityError && error.code === 'DESKTOP_UNAVAILABLE'
  })
  client.dispose()
})
