import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { DesktopProtocolError } from '@dolphinminer/dsh-desktop-protocol'

const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.app', '.bash', '.command', '.dmg', '.exe', '.pkg', '.sh', '.url', '.webloc', '.workflow', '.zsh',
])

const MAX_UPLOAD_FILES = 8
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const UPLOAD_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

export class WorkspacePathError extends Error {
  constructor(readonly code: DesktopProtocolError['code'], message: string) {
    super(message)
    this.name = 'WorkspacePathError'
  }
}

export interface ResolveWorkspaceTargetOptions {
  operation: 'open' | 'reveal' | 'upload'
}

export interface WorkspaceUploadFile {
  name: string
  mediaType: string
  data: Buffer
}

export async function resolveWorkspaceTarget(
  workspaceRoot: string,
  inputPath: string,
  options: ResolveWorkspaceTargetOptions,
): Promise<string> {
  let canonicalRoot: string
  let canonicalTarget: string
  try {
    canonicalRoot = await realpath(workspaceRoot)
    canonicalTarget = await realpath(isAbsolute(inputPath) ? inputPath : resolve(canonicalRoot, inputPath))
  } catch {
    throw new WorkspacePathError('NOT_FOUND', 'The requested workspace path does not exist.')
  }

  const relation = relative(canonicalRoot, canonicalTarget)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new WorkspacePathError('BAD_MESSAGE', 'The requested path is outside the active workspace.')
  }

  const rootStats = await stat(canonicalRoot)
  if (!rootStats.isDirectory()) {
    throw new WorkspacePathError('BAD_MESSAGE', 'The active workspace root is not a directory.')
  }
  if (options.operation === 'reveal') return canonicalTarget

  const targetStats = await stat(canonicalTarget)
  if (!targetStats.isFile()) {
    throw new WorkspacePathError('BAD_MESSAGE', 'Only regular workspace files can be used.')
  }
  if (options.operation === 'open' &&
    ((targetStats.mode & 0o111) !== 0 || BLOCKED_OPEN_EXTENSIONS.has(extname(canonicalTarget).toLowerCase()))) {
    throw new WorkspacePathError('BAD_MESSAGE', 'Executable workspace files cannot be opened by the agent.')
  }
  return canonicalTarget
}

export async function loadWorkspaceUploadFiles(
  workspaceRoot: string,
  inputPaths: readonly string[],
): Promise<WorkspaceUploadFile[]> {
  if (inputPaths.length === 0 || inputPaths.length > MAX_UPLOAD_FILES) {
    throw new WorkspacePathError(
      'BAD_MESSAGE',
      `Select between 1 and ${String(MAX_UPLOAD_FILES)} workspace files to upload.`,
    )
  }

  const files: WorkspaceUploadFile[] = []
  const canonicalPaths = new Set<string>()
  let totalBytes = 0
  for (const inputPath of inputPaths) {
    const target = await resolveWorkspaceTarget(workspaceRoot, inputPath, { operation: 'upload' })
    if (canonicalPaths.has(target)) {
      throw new WorkspacePathError('BAD_MESSAGE', 'The same workspace file cannot be uploaded twice.')
    }
    canonicalPaths.add(target)

    const targetStats = await stat(target)
    if (totalBytes + targetStats.size > MAX_UPLOAD_BYTES) {
      throw new WorkspacePathError('BAD_MESSAGE', 'Browser uploads are limited to 25 MB per action.')
    }
    const data = await readFile(target)
    totalBytes += data.byteLength
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new WorkspacePathError('BAD_MESSAGE', 'Browser uploads are limited to 25 MB per action.')
    }
    const name = basename(target)
    files.push({
      name,
      mediaType: UPLOAD_MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
      data,
    })
  }
  return files
}
