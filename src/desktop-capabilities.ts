import {
  DESKTOP_PROTOCOL_VERSION,
  AutomationClaimNextParams,
  AutomationClaimNextResult,
  AutomationFinishParams,
  AutomationMarkRunningParams,
  AutomationRunSummary,
  ConnectionRuntimeStatusParams,
  ConnectionSnapshot,
  ConnectionSummary,
  BrowserClickParams,
  BrowserFrame,
  BrowserNavigateParams,
  BrowserObservation,
  BrowserObserveParams,
  BrowserSelectParams,
  BrowserScrollParams,
  BrowserScreenshotParams,
  BrowserState,
  BrowserTabParams,
  BrowserTabsParams,
  BrowserTabsSnapshot,
  BrowserTypeParams,
  BrowserUploadParams,
  ComputerApplicationList,
  ComputerActParams,
  ComputerActionResult,
  ComputerObservation,
  ComputerObserveParams,
  ComputerPermissions,
  GitDiscoverParams,
  GitRepositoryIdentity,
  GitReviewParams,
  GitReviewSnapshot,
  GitStatusParams,
  GitStatusSnapshot,
  GitTurnBoundaryParams,
  GitTurnBoundaryResult,
  WorktreeProvisionParams,
  WorktreeSessionBindingParams,
  WorktreeSessionBindingResult,
  WorktreeSnapshot,
  WorktreeSummary,
  McpTransportDescriptor,
  DesktopNotificationParams,
  DesktopSessionActivityParams,
  DesktopWorkspacePathParams,
  DesktopWorkspacePathResult,
} from '@dolphinminer/dsh-desktop-protocol'

import { DesktopCapabilityHandlers } from './desktop-capability-broker'

export interface DesktopNotificationAdapter {
  isSupported(): boolean
  show(params: DesktopNotificationParams): void
}

export interface DesktopCapabilityDependencies {
  isAppFocused(): boolean
  notifications: DesktopNotificationAdapter
  sessionActivity: {
    report(params: DesktopSessionActivityParams): boolean
  }
  workspaceFiles: {
    reveal(params: DesktopWorkspacePathParams, signal: AbortSignal): Promise<DesktopWorkspacePathResult>
    open(params: DesktopWorkspacePathParams, signal: AbortSignal): Promise<DesktopWorkspacePathResult>
  }
  connections: {
    snapshot(): ConnectionSnapshot
    resolveMcpTransport(connectionId: string, signal?: AbortSignal): Promise<{
      connection: ConnectionSummary
      transport: McpTransportDescriptor
    }>
    reportStatus(params: ConnectionRuntimeStatusParams): { accepted: boolean; revision: number }
  }
  computer?: {
    getPermissions(signal: AbortSignal): Promise<ComputerPermissions>
    listApplications(signal: AbortSignal): Promise<ComputerApplicationList>
    observe(params: ComputerObserveParams, signal: AbortSignal): Promise<ComputerObservation>
    act(params: ComputerActParams, signal: AbortSignal): Promise<ComputerActionResult>
  }
  browser?: {
    snapshot(): BrowserState
    navigate(params: BrowserNavigateParams, signal: AbortSignal): Promise<BrowserObservation>
    observe(params: BrowserObserveParams, signal: AbortSignal): Promise<BrowserObservation>
    screenshot(params: BrowserScreenshotParams, signal: AbortSignal): Promise<BrowserFrame>
    tabs(params: BrowserTabsParams, signal: AbortSignal): Promise<BrowserTabsSnapshot>
    tab(params: BrowserTabParams, signal: AbortSignal): Promise<BrowserObservation>
    click(params: BrowserClickParams, signal: AbortSignal): Promise<BrowserObservation>
    type(params: BrowserTypeParams, signal: AbortSignal): Promise<BrowserObservation>
    select(params: BrowserSelectParams, signal: AbortSignal): Promise<BrowserObservation>
    upload(params: BrowserUploadParams, signal: AbortSignal): Promise<BrowserObservation>
    scroll(params: BrowserScrollParams, signal: AbortSignal): Promise<BrowserObservation>
  }
  git: {
    discover(params: GitDiscoverParams, signal: AbortSignal): Promise<GitRepositoryIdentity>
    status(params: GitStatusParams, signal: AbortSignal): Promise<GitStatusSnapshot>
    review(params: GitReviewParams, signal: AbortSignal): Promise<GitReviewSnapshot>
    reportTurnBoundary(params: GitTurnBoundaryParams, signal: AbortSignal): Promise<GitTurnBoundaryResult>
  }
  worktrees: {
    snapshot(): WorktreeSnapshot
    provision(params: WorktreeProvisionParams, signal: AbortSignal): Promise<WorktreeSummary>
    reportSessionBinding(
      params: WorktreeSessionBindingParams,
      signal: AbortSignal,
    ): Promise<WorktreeSessionBindingResult>
  }
  automations?: {
    claimNext(params: AutomationClaimNextParams, signal: AbortSignal): Promise<AutomationClaimNextResult>
    inspectOwned(params: AutomationClaimNextParams): AutomationRunSummary | undefined
    markRunning(params: AutomationMarkRunningParams): AutomationRunSummary
    finish(params: AutomationFinishParams): AutomationRunSummary
  }
}

function unsupportedComputer(): never {
  throw {
    code: 'UNSUPPORTED',
    message: 'Computer observation is unavailable on this platform or build.',
  }
}

function unsupportedBrowser(): never {
  throw {
    code: 'UNSUPPORTED',
    message: 'The controlled browser is unavailable in this desktop build.',
  }
}

function unsupportedAutomations(): never {
  throw {
    code: 'UNSUPPORTED',
    message: 'Durable automations are unavailable in this desktop build.',
  }
}

export function createDesktopCapabilityHandlers(
  dependencies: DesktopCapabilityDependencies,
): DesktopCapabilityHandlers {
  return {
    'desktop.ping': params => ({
      nonce: params.nonce,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
    }),
    'desktop.notify': params => {
      if (dependencies.isAppFocused()) return { delivered: false, reason: 'foreground' }
      if (!dependencies.notifications.isSupported()) {
        return { delivered: false, reason: 'unsupported' }
      }
      dependencies.notifications.show(params)
      return { delivered: true }
    },
    'desktop.reportSessionActivity': params => ({
      accepted: dependencies.sessionActivity.report(params),
    }),
    'desktop.revealPath': (params, context) => dependencies.workspaceFiles.reveal(params, context.signal),
    'desktop.openPath': (params, context) => dependencies.workspaceFiles.open(params, context.signal),
    'computer.getPermissions': (_params, context) =>
      dependencies.computer?.getPermissions(context.signal) ?? unsupportedComputer(),
    'computer.listApps': (_params, context) =>
      dependencies.computer?.listApplications(context.signal) ?? unsupportedComputer(),
    'computer.observe': (params, context) =>
      dependencies.computer?.observe(params, context.signal) ?? unsupportedComputer(),
    'computer.act': (params, context) =>
      dependencies.computer?.act(params, context.signal) ?? unsupportedComputer(),
    'browser.list': () => dependencies.browser?.snapshot() ?? unsupportedBrowser(),
    'browser.navigate': (params, context) =>
      dependencies.browser?.navigate(params, context.signal) ?? unsupportedBrowser(),
    'browser.observe': (params, context) =>
      dependencies.browser?.observe(params, context.signal) ?? unsupportedBrowser(),
    'browser.screenshot': (params, context) =>
      dependencies.browser?.screenshot(params, context.signal) ?? unsupportedBrowser(),
    'browser.tabs': (params, context) =>
      dependencies.browser?.tabs(params, context.signal) ?? unsupportedBrowser(),
    'browser.tab': (params, context) =>
      dependencies.browser?.tab(params, context.signal) ?? unsupportedBrowser(),
    'browser.click': (params, context) =>
      dependencies.browser?.click(params, context.signal) ?? unsupportedBrowser(),
    'browser.type': (params, context) =>
      dependencies.browser?.type(params, context.signal) ?? unsupportedBrowser(),
    'browser.select': (params, context) =>
      dependencies.browser?.select(params, context.signal) ?? unsupportedBrowser(),
    'browser.upload': (params, context) =>
      dependencies.browser?.upload(params, context.signal) ?? unsupportedBrowser(),
    'browser.scroll': (params, context) =>
      dependencies.browser?.scroll(params, context.signal) ?? unsupportedBrowser(),
    'git.discover': (params, context) => dependencies.git.discover(params, context.signal),
    'git.status': (params, context) => dependencies.git.status(params, context.signal),
    'git.review': (params, context) => dependencies.git.review(params, context.signal),
    'git.reportTurnBoundary': (params, context) =>
      dependencies.git.reportTurnBoundary(params, context.signal),
    'worktrees.provision': (params, context) => dependencies.worktrees.provision(params, context.signal),
    'worktrees.list': () => dependencies.worktrees.snapshot(),
    'desktop.reportSessionBinding': (params, context) =>
      dependencies.worktrees.reportSessionBinding(params, context.signal),
    'automations.claimNext': (params, context) =>
      dependencies.automations?.claimNext(params, context.signal) ?? unsupportedAutomations(),
    'automations.inspectOwned': params => {
      if (dependencies.automations === undefined) return unsupportedAutomations()
      const run = dependencies.automations.inspectOwned(params)
      return run === undefined ? {} : { run }
    },
    'automations.markRunning': params =>
      dependencies.automations?.markRunning(params) ?? unsupportedAutomations(),
    'automations.finish': params =>
      dependencies.automations?.finish(params) ?? unsupportedAutomations(),
    'connections.list': () => dependencies.connections.snapshot(),
    'connections.resolveMcpTransport': (params, context) =>
      dependencies.connections.resolveMcpTransport(params.connectionId, context.signal),
    'connections.reportStatus': params => dependencies.connections.reportStatus(params),
  }
}
