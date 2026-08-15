import { createHash, randomBytes } from 'node:crypto'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'

import {
  ConnectionCredential,
  ConnectionSummary,
  isLikelyReadOnlyMcpTool,
  McpTransportDescriptor,
} from '@dolphinminer/dsh-desktop-protocol'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_WRITE_RECEIPTS = 2_048

export interface McpCredentialResolver {
  resolveCredential(connectionId: string, signal?: AbortSignal): Promise<{
    connection: ConnectionSummary
    credential: ConnectionCredential
  }>
}

export interface McpCredentialProxyOptions {
  endpointFor?: (connection: ConnectionSummary) => string
}

interface RouteCapability {
  connectionId: string
  secret: string
}

function defaultEndpoint(connection: ConnectionSummary): string {
  return connection.access === 'read-only'
    ? 'https://mcp.linear.app/mcp/readonly'
    : 'https://mcp.linear.app/mcp'
}

function serverName(connectionId: string): string {
  const digest = createHash('sha256').update(connectionId).digest('hex').slice(0, 16)
  return `linear_${digest}`
}

function copyRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const name of ['accept', 'content-type', 'last-event-id', 'mcp-protocol-version', 'mcp-session-id']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  return headers
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function toolCall(value: unknown): { id: string; name: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const message = value as { id?: unknown; method?: unknown; params?: unknown }
  if (message.method !== 'tools/call' ||
    (typeof message.id !== 'string' && typeof message.id !== 'number') ||
    typeof message.params !== 'object' || message.params === null || Array.isArray(message.params)) {
    return undefined
  }
  const name = (message.params as { name?: unknown }).name
  return typeof name === 'string' ? { id: String(message.id), name } : undefined
}

function sendJson(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: message }))
}

export class McpCredentialProxy {
  private readonly capabilities = new Map<string, RouteCapability>()
  private readonly writeReceipts = new Set<string>()
  private server?: Server
  private port?: number

  constructor(
    private readonly credentials: McpCredentialResolver,
    private readonly options: McpCredentialProxyOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('The desktop MCP credential proxy did not receive a TCP address.')
    }
    this.server = server
    this.port = address.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.capabilities.clear()
    this.writeReceipts.clear()
    if (server === undefined) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  async resolveMcpTransport(connectionId: string, signal?: AbortSignal): Promise<{
    connection: ConnectionSummary
    transport: McpTransportDescriptor
  }> {
    if (this.port === undefined) throw new Error('The desktop MCP credential proxy is not running.')
    const { connection } = await this.credentials.resolveCredential(connectionId, signal)
    let capability = this.capabilities.get(connection.id)
    if (capability === undefined) {
      capability = { connectionId: connection.id, secret: randomBytes(32).toString('hex') }
      this.capabilities.set(connection.id, capability)
    }
    return {
      connection,
      transport: {
        transport: 'streamable-http',
        serverName: serverName(connection.id),
        url: `http://127.0.0.1:${String(this.port)}/mcp/${encodeURIComponent(connection.id)}/${capability.secret}`,
      },
    }
  }

  revoke(connectionId: string): void {
    this.capabilities.delete(connectionId)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const capability = this.match(request.url)
    if (capability === undefined ||
      (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE')) {
      sendJson(response, 404, 'MCP connection not found.')
      return
    }

    const controller = new AbortController()
    request.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    let body: Buffer
    try {
      body = await readBody(request)
    } catch {
      sendJson(response, 413, 'MCP request is too large.')
      return
    }

    let resolved: Awaited<ReturnType<McpCredentialResolver['resolveCredential']>>
    try {
      resolved = await this.credentials.resolveCredential(capability.connectionId, controller.signal)
    } catch {
      sendJson(response, 401, 'The desktop connection is unavailable.')
      return
    }

    const duplicate = this.reserveWrite(request, body, resolved.connection)
    if (duplicate) {
      sendJson(response, 409, 'A duplicate Linear write was blocked and was not replayed.')
      return
    }

    const headers = copyRequestHeaders(request)
    headers.set('authorization', `Bearer ${resolved.credential.accessToken}`)
    let upstream: Response
    try {
      upstream = await fetch((this.options.endpointFor ?? defaultEndpoint)(resolved.connection), {
        method: request.method,
        headers,
        ...(body.length === 0 ? {} : { body: body.toString('utf8') }),
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      if (!response.headersSent) sendJson(response, 502, 'The Linear MCP request did not complete.')
      return
    }

    response.statusCode = upstream.status
    for (const name of ['content-type', 'mcp-session-id', 'retry-after']) {
      const value = upstream.headers.get(name)
      if (value !== null) response.setHeader(name, value)
    }
    if (upstream.body === null) {
      response.end()
      return
    }
    try {
      for await (const chunk of upstream.body) response.write(Buffer.from(chunk))
      response.end()
    } catch {
      response.destroy()
    }
  }

  private match(rawUrl: string | undefined): RouteCapability | undefined {
    if (rawUrl === undefined) return undefined
    let pathname: string
    try {
      pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
    } catch {
      return undefined
    }
    const parts = pathname.split('/')
    if (parts.length !== 4 || parts[1] !== 'mcp') return undefined
    let connectionId: string
    try {
      connectionId = decodeURIComponent(parts[2])
    } catch {
      return undefined
    }
    const capability = this.capabilities.get(connectionId)
    return capability?.secret === parts[3] ? capability : undefined
  }

  private reserveWrite(
    request: IncomingMessage,
    body: Buffer,
    connection: ConnectionSummary,
  ): boolean {
    if (request.method !== 'POST' || connection.access !== 'read-write' || body.length === 0) return false
    let call: ReturnType<typeof toolCall>
    try {
      call = toolCall(JSON.parse(body.toString('utf8')) as unknown)
    } catch {
      return false
    }
    if (call === undefined || isLikelyReadOnlyMcpTool(call.name)) return false
    const session = typeof request.headers['mcp-session-id'] === 'string'
      ? request.headers['mcp-session-id']
      : 'no-session'
    const key = `${connection.id}:${session}:${call.id}`
    if (this.writeReceipts.has(key)) return true
    this.writeReceipts.add(key)
    while (this.writeReceipts.size > MAX_WRITE_RECEIPTS) {
      const oldest = this.writeReceipts.values().next().value as string | undefined
      if (oldest === undefined) break
      this.writeReceipts.delete(oldest)
    }
    return false
  }
}
