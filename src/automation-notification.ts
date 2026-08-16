import type { AutomationRunSummary } from '@dolphinminer/dsh-desktop-protocol'

export interface AutomationNotificationContent {
  title: string
  body: string
}

export function automationRunHasSession(run: AutomationRunSummary): boolean {
  return run.events.some(event => event.type === 'running')
}

export function automationNotificationContent(
  run: AutomationRunSummary,
): AutomationNotificationContent | undefined {
  if (run.phase === 'succeeded') {
    return {
      title: 'Automation finished',
      body: 'The Agent run completed. Review its session before relying on external changes.',
    }
  }
  if (run.phase === 'failed') {
    return {
      title: 'Automation needs attention',
      body: automationRunHasSession(run)
        ? 'The Agent run failed. Open its session for details.'
        : 'The Agent run failed before its session started. Open Task Center for details.',
    }
  }
  if (run.phase === 'ambiguous') {
    return {
      title: 'Automation outcome is uncertain',
      body: 'Review the Agent session before retrying or relying on external changes.',
    }
  }
  if (run.phase === 'interrupted') {
    return {
      title: 'Automation was interrupted',
      body: automationRunHasSession(run)
        ? 'Open the Agent session to review the last durable result.'
        : 'Open Task Center to review the last durable result.',
    }
  }
  if (run.phase === 'cancelled') {
    return {
      title: 'Automation stopped',
      body: 'The Agent run was cancelled.',
    }
  }
  return undefined
}
