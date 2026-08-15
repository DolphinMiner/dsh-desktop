import { randomUUID } from 'node:crypto'

import { ConnectionCredential } from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

const VAULT_SCHEMA_VERSION = 1

interface VaultDocument {
  schemaVersion: typeof VAULT_SCHEMA_VERSION
  entries: Record<string, {
    ciphertext: string
    createdAt: string
    updatedAt: string
  }>
}

export interface CredentialEncryptionAdapter {
  isAvailable(): boolean
  backend(): string | undefined
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export function safeStorageBackend(
  platform: NodeJS.Platform,
  selectedLinuxBackend: () => string,
): string {
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi'
  if (platform === 'linux') return selectedLinuxBackend()
  return 'safe-storage'
}

export class CredentialVaultError extends Error {
  readonly code = 'VAULT_UNAVAILABLE' as const

  constructor(message: string) {
    super(message)
    this.name = 'CredentialVaultError'
  }
}

function emptyDocument(): VaultDocument {
  return { schemaVersion: VAULT_SCHEMA_VERSION, entries: {} }
}

function parseDocument(value: unknown): VaultDocument {
  if (value === undefined) return emptyDocument()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desktop credential vault has an invalid document shape.')
  }
  const candidate = value as Partial<VaultDocument>
  if (candidate.schemaVersion !== VAULT_SCHEMA_VERSION ||
    typeof candidate.entries !== 'object' || candidate.entries === null ||
    Array.isArray(candidate.entries)) {
    throw new Error('The desktop credential vault uses an unsupported schema version.')
  }
  for (const [reference, entry] of Object.entries(candidate.entries)) {
    if (reference.length === 0 || typeof entry !== 'object' || entry === null ||
      typeof entry.ciphertext !== 'string' || typeof entry.createdAt !== 'string' ||
      typeof entry.updatedAt !== 'string') {
      throw new Error('The desktop credential vault contains an invalid entry.')
    }
  }
  return candidate as VaultDocument
}

function parseCredential(value: unknown): ConnectionCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The encrypted credential has an invalid shape.')
  }
  const candidate = value as Partial<ConnectionCredential>
  if ((candidate.kind !== 'api-key' && candidate.kind !== 'oauth') ||
    typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0 ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.every(scope => typeof scope === 'string')) {
    throw new Error('The encrypted credential has invalid fields.')
  }
  if (candidate.refreshToken !== undefined && typeof candidate.refreshToken !== 'string') {
    throw new Error('The encrypted credential has an invalid refresh token.')
  }
  if (candidate.expiresAt !== undefined &&
    (typeof candidate.expiresAt !== 'string' || Number.isNaN(Date.parse(candidate.expiresAt)))) {
    throw new Error('The encrypted credential has an invalid expiry.')
  }
  return {
    kind: candidate.kind,
    accessToken: candidate.accessToken,
    ...(candidate.refreshToken === undefined ? {} : { refreshToken: candidate.refreshToken }),
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
    scopes: [...candidate.scopes],
  }
}

export class CredentialVault {
  constructor(
    private readonly path: string,
    private readonly encryption: CredentialEncryptionAdapter,
  ) {}

  get available(): boolean {
    return this.encryption.isAvailable()
  }

  get backend(): string | undefined {
    return this.available ? this.encryption.backend() : undefined
  }

  put(credential: ConnectionCredential, reference: string = randomUUID()): string {
    this.assertAvailable()
    const document = this.read()
    const now = new Date().toISOString()
    const previous = document.entries[reference]
    const ciphertext = this.encryption.encrypt(JSON.stringify(credential)).toString('base64')
    document.entries[reference] = {
      ciphertext,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    writeJsonAtomically(this.path, document)
    return reference
  }

  get(reference: string): ConnectionCredential | undefined {
    this.assertAvailable()
    const entry = this.read().entries[reference]
    if (entry === undefined) return undefined
    const plaintext = this.encryption.decrypt(Buffer.from(entry.ciphertext, 'base64'))
    return parseCredential(JSON.parse(plaintext) as unknown)
  }

  delete(reference: string): void {
    const document = this.read()
    if (document.entries[reference] === undefined) return
    delete document.entries[reference]
    writeJsonAtomically(this.path, document)
  }

  prune(references: ReadonlySet<string>): void {
    const document = this.read()
    let changed = false
    for (const reference of Object.keys(document.entries)) {
      if (references.has(reference)) continue
      delete document.entries[reference]
      changed = true
    }
    if (changed) writeJsonAtomically(this.path, document)
  }

  private read(): VaultDocument {
    return parseDocument(readJsonFile(this.path))
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new CredentialVaultError(
        'Secure credential storage is unavailable. Unlock the macOS login Keychain and try again.',
      )
    }
  }
}
