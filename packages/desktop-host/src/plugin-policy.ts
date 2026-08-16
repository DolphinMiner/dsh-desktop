import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

import type { DesktopPluginPolicy } from '@dolphinminer/dsh-desktop-protocol'

export interface PluginPolicyLoader {
  entries(): Iterable<Entry>
}

export type PluginPolicyFailureHandler = (message: string, error?: unknown) => void

export function isMutablePluginModule(moduleName: string): boolean {
  if (moduleName.includes('/dsh-skill-')) return true
  if (/^(?:cordis|node|file):/.test(moduleName) || moduleName.startsWith('.')) return false
  return !moduleName.startsWith('@deepseek-ai/') && !moduleName.startsWith('@dolphinminer/')
}

export class PluginPolicyReconciler {
  private tail = Promise.resolve()
  private disposed = false

  constructor(
    private readonly loader: PluginPolicyLoader,
    private readonly onFailure: PluginPolicyFailureHandler = () => undefined,
  ) {}

  reconcile(policy: DesktopPluginPolicy): Promise<void> {
    const run = this.tail.then(() => this.apply(policy))
    this.tail = run.catch(() => undefined)
    return run
  }

  schedule(policy: DesktopPluginPolicy): void {
    void this.reconcile(policy).catch(error => {
      this.onFailure('Plugin policy reconciliation failed.', error)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.tail
  }

  private async apply(policy: DesktopPluginPolicy): Promise<void> {
    if (this.disposed) return
    const entries = new Map([...this.loader.entries()].map(entry => [entry.id, entry]))
    for (const [entryId, override] of Object.entries(policy.overrides)) {
      if (this.disposed) return
      const entry = entries.get(entryId)
      if (entry === undefined) continue
      if (entry.options.name !== override.moduleName) {
        this.onFailure(`Ignored stale plugin policy for Loader entry "${entryId}".`)
        continue
      }
      if (!isMutablePluginModule(override.moduleName)) {
        this.onFailure(`Ignored immutable Harness plugin "${override.moduleName}".`)
        continue
      }
      const disabled = !override.enabled
      if (entry.disabled === disabled) continue
      await entry.update({ disabled })
      if (entry.disabled !== disabled) {
        throw new Error(`Loader did not apply plugin policy for "${override.moduleName}".`)
      }
    }
  }
}
