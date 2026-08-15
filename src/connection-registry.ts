import { randomUUID } from 'node:crypto'

import {
  ConnectionAccess,
  ConnectionAuthKind,
  ConnectionProvider,
  ConnectionStatus,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

export const CONNECTION_REGISTRY_SCHEMA_VERSION = 1

export interface StoredConnection {
  id: string
  provider: ConnectionProvider
  label: string
  account?: string
  workspace?: string
  authKind: ConnectionAuthKind
  access: ConnectionAccess
  scopes: string[]
  enabled: boolean
  secretRef?: string
  enabledTools: string[]
  lastStatus: ConnectionStatus
  lastStatusMessage?: string
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

interface ConnectionRegistryDocument {
  schemaVersion: typeof CONNECTION_REGISTRY_SCHEMA_VERSION
  revision: number
  connections: StoredConnection[]
}

export interface ConnectionUpsert {
  id?: string
  provider: ConnectionProvider
  label: string
  account?: string
  workspace?: string
  authKind: ConnectionAuthKind
  access: ConnectionAccess
  scopes: string[]
  secretRef: string
}

function emptyDocument(): ConnectionRegistryDocument {
  return { schemaVersion: CONNECTION_REGISTRY_SCHEMA_VERSION, revision: 0, connections: [] }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseConnection(value: unknown): StoredConnection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desktop connection registry contains an invalid entry.')
  }
  const item = value as Partial<StoredConnection>
  if (typeof item.id !== 'string' || item.provider !== 'linear' || typeof item.label !== 'string' ||
    (item.authKind !== 'api-key' && item.authKind !== 'oauth') ||
    (item.access !== 'read-only' && item.access !== 'read-write') || !isStringList(item.scopes) ||
    typeof item.enabled !== 'boolean' || !isStringList(item.enabledTools) ||
    (item.lastStatus !== 'connecting' && item.lastStatus !== 'connected' &&
      item.lastStatus !== 'disconnected' && item.lastStatus !== 'expired' && item.lastStatus !== 'error') ||
    typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') {
    throw new Error('The desktop connection registry contains invalid fields.')
  }
  if (item.secretRef !== undefined && typeof item.secretRef !== 'string') {
    throw new Error('The desktop connection registry contains an invalid secret reference.')
  }
  if (item.account !== undefined && typeof item.account !== 'string') {
    throw new Error('The desktop connection registry contains an invalid account.')
  }
  if (item.workspace !== undefined && typeof item.workspace !== 'string') {
    throw new Error('The desktop connection registry contains an invalid workspace.')
  }
  if (item.lastStatusMessage !== undefined && typeof item.lastStatusMessage !== 'string') {
    throw new Error('The desktop connection registry contains an invalid status message.')
  }
  if (item.lastConnectedAt !== undefined && typeof item.lastConnectedAt !== 'string') {
    throw new Error('The desktop connection registry contains an invalid connection timestamp.')
  }
  return {
    ...item,
    scopes: [...item.scopes],
    enabledTools: [...item.enabledTools],
  } as StoredConnection
}

function parseDocument(value: unknown): ConnectionRegistryDocument {
  if (value === undefined) return emptyDocument()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desktop connection registry has an invalid document shape.')
  }
  const candidate = value as Partial<ConnectionRegistryDocument>
  if (candidate.schemaVersion !== CONNECTION_REGISTRY_SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0 ||
    !Array.isArray(candidate.connections)) {
    throw new Error('The desktop connection registry uses an unsupported schema version.')
  }
  const connections = candidate.connections.map(parseConnection)
  if (new Set(connections.map(connection => connection.id)).size !== connections.length) {
    throw new Error('The desktop connection registry contains duplicate IDs.')
  }
  return { schemaVersion: CONNECTION_REGISTRY_SCHEMA_VERSION, revision: Number(candidate.revision), connections }
}

function cloneConnection(connection: StoredConnection): StoredConnection {
  return {
    ...connection,
    scopes: [...connection.scopes],
    enabledTools: [...connection.enabledTools],
  }
}

export class ConnectionRegistry {
  constructor(private readonly path: string) {}

  get revision(): number {
    return this.read().revision
  }

  list(): StoredConnection[] {
    return this.read().connections.map(cloneConnection)
  }

  get(id: string): StoredConnection | undefined {
    const connection = this.read().connections.find(item => item.id === id)
    return connection === undefined ? undefined : cloneConnection(connection)
  }

  upsert(input: ConnectionUpsert): { connection: StoredConnection; previousSecretRef?: string } {
    const document = this.read()
    const index = input.id === undefined
      ? -1
      : document.connections.findIndex(connection => connection.id === input.id)
    const previous = index < 0 ? undefined : document.connections[index]
    if (previous !== undefined && previous.provider !== input.provider) {
      throw new Error('A connection cannot change providers.')
    }
    const now = new Date().toISOString()
    const connection: StoredConnection = {
      id: previous?.id ?? randomUUID(),
      provider: input.provider,
      label: input.label,
      ...(input.account === undefined ? {} : { account: input.account }),
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      authKind: input.authKind,
      access: input.access,
      scopes: [...input.scopes],
      enabled: true,
      secretRef: input.secretRef,
      enabledTools: [],
      lastStatus: 'connecting',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(previous?.lastConnectedAt === undefined ? {} : { lastConnectedAt: previous.lastConnectedAt }),
    }
    if (index < 0) document.connections.push(connection)
    else document.connections[index] = connection
    this.write(document)
    return {
      connection: cloneConnection(connection),
      ...(previous?.secretRef === undefined ? {} : { previousSecretRef: previous.secretRef }),
    }
  }

  disconnect(id: string): { connection: StoredConnection; previousSecretRef?: string } | undefined {
    const document = this.read()
    const index = document.connections.findIndex(connection => connection.id === id)
    if (index < 0) return undefined
    const previous = document.connections[index]
    const connection: StoredConnection = {
      ...previous,
      enabled: false,
      lastStatus: 'disconnected',
      updatedAt: new Date().toISOString(),
    }
    delete connection.secretRef
    delete connection.lastStatusMessage
    document.connections[index] = connection
    this.write(document)
    return {
      connection: cloneConnection(connection),
      ...(previous.secretRef === undefined ? {} : { previousSecretRef: previous.secretRef }),
    }
  }

  updateRuntime(
    id: string,
    status: Extract<ConnectionStatus, 'connecting' | 'connected' | 'expired' | 'error'>,
    statusMessage?: string,
    enabledTools?: string[],
  ): StoredConnection | undefined {
    const document = this.read()
    const index = document.connections.findIndex(connection => connection.id === id)
    if (index < 0 || !document.connections[index].enabled) return undefined
    const now = new Date().toISOString()
    const connection: StoredConnection = {
      ...document.connections[index],
      lastStatus: status,
      ...(enabledTools === undefined ? {} : { enabledTools: [...enabledTools] }),
      ...(status === 'connected' ? { lastConnectedAt: now } : {}),
    }
    if (statusMessage === undefined) delete connection.lastStatusMessage
    else connection.lastStatusMessage = statusMessage
    document.connections[index] = connection
    this.write(document)
    return cloneConnection(connection)
  }

  activeSecretReferences(): Set<string> {
    return new Set(this.list().flatMap(connection =>
      connection.enabled && connection.secretRef !== undefined ? [connection.secretRef] : [],
    ))
  }

  private read(): ConnectionRegistryDocument {
    return parseDocument(readJsonFile(this.path))
  }

  private write(document: ConnectionRegistryDocument): void {
    document.revision += 1
    writeJsonAtomically(this.path, document)
  }
}
