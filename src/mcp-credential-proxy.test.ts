import assert from 'node:assert/strict'
import { createServer, Server } from 'node:http'
import test from 'node:test'

import { ConnectionSummary } from '@dolphinminer/dsh-desktop-protocol'

import { McpCredentialProxy } from './mcp-credential-proxy'

function connection(access: 'read-only' | 'read-write'): ConnectionSummary {
  return {
    id: 'connection-1',
    provider: 'linear',
    label: 'Linear test',
    authKind: 'api-key',
    access,
    scopes: access === 'read-only' ? ['read'] : ['read', 'write'],
    status: 'connecting',
    enabledTools: [],
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  return `http://127.0.0.1:${String(address.port)}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

test('attaches credentials only at the upstream hop and blocks duplicate writes', async () => {
  const requests: Array<{ authorization?: string; body: string }> = []
  const upstream = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push({
      ...(typeof request.headers.authorization === 'string'
        ? { authorization: request.headers.authorization }
        : {}),
      body,
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'session-1',
    })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }))
  })
  const upstreamUrl = await listen(upstream)
  const proxy = new McpCredentialProxy({
    resolveCredential: () => Promise.resolve({
      connection: connection('read-write'),
      credential: { kind: 'api-key', accessToken: 'linear-secret-token', scopes: ['read', 'write'] },
    }),
  }, { endpointFor: () => upstreamUrl })

  try {
    await proxy.start()
    const resolved = await proxy.resolveMcpTransport('connection-1')
    if (resolved.transport.transport !== 'streamable-http') throw new Error('expected HTTP transport')
    assert.equal(resolved.transport.url.includes('linear-secret-token'), false)

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'One issue' } },
    })
    const first = await fetch(resolved.transport.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer renderer-supplied-token',
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
      },
      body,
    })
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('mcp-session-id'), 'session-1')

    const duplicate = await fetch(resolved.transport.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      body,
    })
    assert.equal(duplicate.status, 409)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, 'Bearer linear-secret-token')
    assert.equal(requests[0].body, body)

    proxy.revoke('connection-1')
    assert.equal((await fetch(resolved.transport.url)).status, 404)
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})

test('does not deduplicate read calls', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  const upstreamUrl = await listen(upstream)
  const proxy = new McpCredentialProxy({
    resolveCredential: () => Promise.resolve({
      connection: connection('read-write'),
      credential: { kind: 'api-key', accessToken: 'secret', scopes: ['read', 'write'] },
    }),
  }, { endpointFor: () => upstreamUrl })
  try {
    await proxy.start()
    const resolved = await proxy.resolveMcpTransport('connection-1')
    if (resolved.transport.transport !== 'streamable-http') throw new Error('expected HTTP transport')
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'list_issues' },
    })
    await fetch(resolved.transport.url, { method: 'POST', body })
    await fetch(resolved.transport.url, { method: 'POST', body })
    assert.equal(calls, 2)
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})
