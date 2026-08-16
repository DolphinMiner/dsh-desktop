import {
  ComputerApplicationRule,
  ComputerControlPolicy,
  parseComputerControlPolicy,
} from '@dolphinminer/dsh-desktop-protocol'

import { readJsonFile, writeJsonAtomically } from './atomic-json'

const COMPUTER_POLICY_SCHEMA_VERSION = 1

interface ComputerPolicyDocument {
  schemaVersion: typeof COMPUTER_POLICY_SCHEMA_VERSION
  policy: ComputerControlPolicy
}

export const DEFAULT_COMPUTER_CONTROL_POLICY: ComputerControlPolicy = {
  allowAnyApplication: false,
  lockScreenOperations: false,
  applicationRules: [],
}

function cloneRule(rule: ComputerApplicationRule): ComputerApplicationRule {
  return { ...rule }
}

export function cloneComputerControlPolicy(policy: ComputerControlPolicy): ComputerControlPolicy {
  return {
    ...policy,
    applicationRules: policy.applicationRules.map(cloneRule),
  }
}

export class ComputerControlPolicyStore {
  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  load(): { policy: ComputerControlPolicy; recovered: boolean } {
    try {
      const value = readJsonFile(this.path)
      if (value === undefined) {
        return { policy: cloneComputerControlPolicy(DEFAULT_COMPUTER_CONTROL_POLICY), recovered: false }
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('The Computer Control policy file has an invalid shape.')
      }
      const document = value as Partial<ComputerPolicyDocument>
      const policy = parseComputerControlPolicy(document.policy)
      if (document.schemaVersion !== COMPUTER_POLICY_SCHEMA_VERSION || policy === undefined) {
        throw new Error('The Computer Control policy file uses an unsupported schema.')
      }
      return { policy, recovered: false }
    } catch (error) {
      this.onError(error)
      return { policy: cloneComputerControlPolicy(DEFAULT_COMPUTER_CONTROL_POLICY), recovered: true }
    }
  }

  save(policy: ComputerControlPolicy): void {
    writeJsonAtomically(this.path, {
      schemaVersion: COMPUTER_POLICY_SCHEMA_VERSION,
      policy: cloneComputerControlPolicy(policy),
    } satisfies ComputerPolicyDocument)
  }
}
