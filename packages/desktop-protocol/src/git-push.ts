import type { GitDiscoverParams, GitStatusParams } from './git.js'
import { parseGitDiscoverParams, parseGitStatusParams } from './git.js'

const MAX_REMOTE_LENGTH = 256
const MAX_REMOTE_URL_LENGTH = 4_096
const MAX_REF_LENGTH = 1_024

export interface DesktopGitPushPreviewInput extends GitDiscoverParams {}

export interface GitPushTarget {
  remote: string
  remoteUrl: string
  localBranch: string
  localRef: string
  remoteRef: string
  trackingRef: string
  head: string
  upstreamHead: string
  ahead: number
  behind: number
}

export interface GitPushState extends GitPushTarget {
  remoteUrlFingerprint: string
}

export interface GitPushPreview {
  previewId: string
  expiresAt: string
  target: GitPushTarget
}

export interface DesktopGitPushConfirmInput extends GitDiscoverParams {
  previewId: string
  confirmed: true
}

export interface GitPushParams extends GitStatusParams {
  operationId: string
  target: GitPushState
}

export interface GitPushResult {
  operationId: string
  remote: string
  remoteRef: string
  head: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !value.includes('\0') && !/[\r\n]/.test(value)
}

function isHeadRef(value: unknown): value is string {
  return isBoundedText(value, MAX_REF_LENGTH) && value.startsWith('refs/heads/')
}

function isTrackingRef(value: unknown): value is string {
  return isBoundedText(value, MAX_REF_LENGTH) && value.startsWith('refs/remotes/')
}

function parseTarget(value: unknown, includeFingerprint: false): GitPushTarget | undefined
function parseTarget(value: unknown, includeFingerprint: true): GitPushState | undefined
function parseTarget(value: unknown, includeFingerprint: boolean): GitPushTarget | GitPushState | undefined {
  const keys = [
    'remote', 'remoteUrl', 'localBranch', 'localRef', 'remoteRef', 'trackingRef', 'head', 'upstreamHead',
    'ahead', 'behind',
    ...(includeFingerprint ? ['remoteUrlFingerprint'] : []),
  ]
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !isBoundedText(value.remote, MAX_REMOTE_LENGTH) ||
    !isBoundedText(value.remoteUrl, MAX_REMOTE_URL_LENGTH) || !isBoundedText(value.localBranch, MAX_REF_LENGTH) ||
    !isHeadRef(value.localRef) || value.localRef !== `refs/heads/${value.localBranch}` ||
    !isHeadRef(value.remoteRef) || !isTrackingRef(value.trackingRef) || !isObjectId(value.head) ||
    !isObjectId(value.upstreamHead) || !Number.isSafeInteger(value.ahead) || Number(value.ahead) < 0 ||
    !Number.isSafeInteger(value.behind) || Number(value.behind) < 0 ||
    (includeFingerprint && (typeof value.remoteUrlFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.remoteUrlFingerprint)))) return undefined
  const target: GitPushTarget = {
    remote: value.remote,
    remoteUrl: value.remoteUrl,
    localBranch: value.localBranch,
    localRef: value.localRef,
    remoteRef: value.remoteRef,
    trackingRef: value.trackingRef,
    head: value.head,
    upstreamHead: value.upstreamHead,
    ahead: Number(value.ahead),
    behind: Number(value.behind),
  }
  return includeFingerprint
    ? { ...target, remoteUrlFingerprint: value.remoteUrlFingerprint as string }
    : target
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value))
}

export function parseDesktopGitPushPreviewInput(value: unknown): DesktopGitPushPreviewInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot'])) return undefined
  return parseGitDiscoverParams(value)
}

export function parseGitPushTarget(value: unknown): GitPushTarget | undefined {
  return parseTarget(value, false)
}

export function parseGitPushState(value: unknown): GitPushState | undefined {
  return parseTarget(value, true)
}

export function parseGitPushPreview(value: unknown): GitPushPreview | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['previewId', 'expiresAt', 'target']) ||
    !isUuid(value.previewId) || !isIsoDate(value.expiresAt)) return undefined
  const target = parseGitPushTarget(value.target)
  return target === undefined ? undefined : { previewId: value.previewId, expiresAt: value.expiresAt, target }
}

export function parseDesktopGitPushConfirmInput(value: unknown): DesktopGitPushConfirmInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'workspaceRoot', 'previewId', 'confirmed']) ||
    !isUuid(value.previewId) || value.confirmed !== true) return undefined
  const base = parseGitDiscoverParams(value)
  return base === undefined ? undefined : { ...base, previewId: value.previewId, confirmed: true }
}

export function parseGitPushParams(value: unknown): GitPushParams | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'sessionId', 'workspaceRoot', 'repositoryRoot', 'operationId', 'target',
  ]) || !isUuid(value.operationId)) return undefined
  const base = parseGitStatusParams(value)
  const target = parseGitPushState(value.target)
  return base === undefined || target === undefined ? undefined : { ...base, operationId: value.operationId, target }
}

export function parseGitPushResult(value: unknown): GitPushResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operationId', 'remote', 'remoteRef', 'head']) ||
    !isUuid(value.operationId) || !isBoundedText(value.remote, MAX_REMOTE_LENGTH) ||
    !isHeadRef(value.remoteRef) || !isObjectId(value.head)) return undefined
  return { operationId: value.operationId, remote: value.remote, remoteRef: value.remoteRef, head: value.head }
}
