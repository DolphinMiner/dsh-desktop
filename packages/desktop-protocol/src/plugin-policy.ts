export const MAX_DESKTOP_PLUGIN_POLICY_OVERRIDES = 256
const MAX_PLUGIN_ID_LENGTH = 512
const MAX_PLUGIN_MODULE_LENGTH = 512
const MAX_STATUS_MESSAGE_LENGTH = 1_000

export interface DesktopPluginPolicyOverride {
  moduleName: string
  enabled: boolean
}

export interface DesktopPluginPolicy {
  overrides: Record<string, DesktopPluginPolicyOverride>
}

export interface DesktopPluginPolicySnapshot extends DesktopPluginPolicy {
  revision: number
  statusMessage?: string
}

export interface UpdateDesktopPluginPolicyInput {
  expectedRevision: number
  entryId: string
  moduleName: string
  enabled: boolean
}

export interface InstallDesktopPluginInput {
  packageSpec: string
}

export interface DesktopPluginInstallResult {
  packageName: string
  changed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

export function parseDesktopPluginPolicy(value: unknown): DesktopPluginPolicy | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['overrides']) || !isRecord(value.overrides)) {
    return undefined
  }
  const entries = Object.entries(value.overrides)
  if (entries.length > MAX_DESKTOP_PLUGIN_POLICY_OVERRIDES) return undefined

  const parsed: Array<[string, DesktopPluginPolicyOverride]> = []
  for (const [entryId, candidate] of entries) {
    if (!isBoundedIdentity(entryId, MAX_PLUGIN_ID_LENGTH) || !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ['moduleName', 'enabled']) ||
      !isBoundedIdentity(candidate.moduleName, MAX_PLUGIN_MODULE_LENGTH) ||
      typeof candidate.enabled !== 'boolean') return undefined
    parsed.push([entryId, { moduleName: candidate.moduleName, enabled: candidate.enabled }])
  }
  return { overrides: Object.fromEntries(parsed) }
}

export function parseDesktopPluginPolicySnapshot(value: unknown): DesktopPluginPolicySnapshot | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    (value.statusMessage !== undefined &&
      (typeof value.statusMessage !== 'string' || value.statusMessage.length > MAX_STATUS_MESSAGE_LENGTH))) {
    return undefined
  }
  const policy = parseDesktopPluginPolicy({ overrides: value.overrides })
  if (policy === undefined || !hasOnlyKeys(value, ['revision', 'overrides', 'statusMessage'])) return undefined
  return {
    revision: Number(value.revision),
    overrides: policy.overrides,
    ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage }),
  }
}

export function parseUpdateDesktopPluginPolicyInput(value: unknown): UpdateDesktopPluginPolicyInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['expectedRevision', 'entryId', 'moduleName', 'enabled']) ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
    !isBoundedIdentity(value.entryId, MAX_PLUGIN_ID_LENGTH) ||
    !isBoundedIdentity(value.moduleName, MAX_PLUGIN_MODULE_LENGTH) ||
    typeof value.enabled !== 'boolean') return undefined
  return {
    expectedRevision: Number(value.expectedRevision),
    entryId: value.entryId,
    moduleName: value.moduleName,
    enabled: value.enabled,
  }
}

export function parseInstallDesktopPluginInput(value: unknown): InstallDesktopPluginInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['packageSpec']) ||
    !isBoundedIdentity(value.packageSpec, MAX_PLUGIN_MODULE_LENGTH)) return undefined
  return { packageSpec: value.packageSpec }
}
