import {
  DesktopPluginPolicy,
  DesktopPluginPolicySnapshot,
  MAX_DESKTOP_PLUGIN_POLICY_OVERRIDES,
  parseDesktopPluginPolicy,
  UpdateDesktopPluginPolicyInput,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

const PLUGIN_POLICY_SCHEMA_VERSION = 1

interface PluginPolicyDocument {
  schemaVersion: typeof PLUGIN_POLICY_SCHEMA_VERSION
  revision: number
  policy: DesktopPluginPolicy
}

export interface PluginPolicyStoredState {
  revision: number
  policy: DesktopPluginPolicy
  recovered: boolean
}

export interface PluginPolicyPersistence {
  load(): PluginPolicyStoredState
  save(revision: number, policy: DesktopPluginPolicy): void
}

function cloneOverrides(
  overrides: DesktopPluginPolicy['overrides'],
): DesktopPluginPolicy['overrides'] {
  return Object.fromEntries(Object.entries(overrides).map(([entryId, override]) => [
    entryId,
    { ...override },
  ]))
}

function clonePolicy(policy: DesktopPluginPolicy): DesktopPluginPolicy {
  return { overrides: cloneOverrides(policy.overrides) }
}

export class PluginPolicyStore implements PluginPolicyPersistence {
  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  load(): PluginPolicyStoredState {
    try {
      const value = readJsonFile(this.path)
      if (value === undefined) return { revision: 0, policy: { overrides: {} }, recovered: false }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('The plugin policy file has an invalid shape.')
      }
      const document = value as Partial<PluginPolicyDocument>
      const policy = parseDesktopPluginPolicy(document.policy)
      if (document.schemaVersion !== PLUGIN_POLICY_SCHEMA_VERSION ||
        !Number.isSafeInteger(document.revision) || Number(document.revision) < 0 ||
        policy === undefined) {
        throw new Error('The plugin policy file uses an unsupported schema.')
      }
      return { revision: Number(document.revision), policy, recovered: false }
    } catch (error) {
      this.onError(error)
      return { revision: 0, policy: { overrides: {} }, recovered: true }
    }
  }

  save(revision: number, policy: DesktopPluginPolicy): void {
    writeJsonAtomically(this.path, {
      schemaVersion: PLUGIN_POLICY_SCHEMA_VERSION,
      revision,
      policy: clonePolicy(policy),
    } satisfies PluginPolicyDocument)
  }
}

export class PluginPolicyController {
  private revision: number
  private policy: DesktopPluginPolicy
  private statusMessage?: string

  constructor(
    private readonly persistence: PluginPolicyPersistence,
    private readonly onChange: (snapshot: DesktopPluginPolicySnapshot) => void = () => undefined,
  ) {
    const loaded = persistence.load()
    this.revision = loaded.revision
    this.policy = clonePolicy(loaded.policy)
    this.statusMessage = loaded.recovered
      ? 'Plugin preferences were reset because the saved file could not be read.'
      : undefined
  }

  snapshot(): DesktopPluginPolicySnapshot {
    return {
      revision: this.revision,
      overrides: cloneOverrides(this.policy.overrides),
      ...(this.statusMessage === undefined ? {} : { statusMessage: this.statusMessage }),
    }
  }

  update(input: UpdateDesktopPluginPolicyInput): DesktopPluginPolicySnapshot {
    if (input.expectedRevision !== this.revision) {
      throw new Error('Plugin preferences changed. Refresh and try again.')
    }
    const current = this.policy.overrides[input.entryId]
    if (current?.moduleName === input.moduleName && current.enabled === input.enabled) {
      return this.snapshot()
    }
    if (current === undefined &&
      Object.keys(this.policy.overrides).length >= MAX_DESKTOP_PLUGIN_POLICY_OVERRIDES) {
      throw new Error('The plugin preference limit has been reached.')
    }
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error('The plugin preference revision is exhausted.')
    }

    const nextRevision = this.revision + 1
    const next: DesktopPluginPolicy = {
      overrides: {
        ...cloneOverrides(this.policy.overrides),
        [input.entryId]: { moduleName: input.moduleName, enabled: input.enabled },
      },
    }
    this.persistence.save(nextRevision, next)
    this.revision = nextRevision
    this.policy = next
    this.statusMessage = undefined
    const snapshot = this.snapshot()
    this.onChange(snapshot)
    return snapshot
  }
}
