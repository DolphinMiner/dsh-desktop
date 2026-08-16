export type HarnessPhase = 'starting' | 'ready' | 'error' | 'stopped'

export interface HarnessState {
  phase: HarnessPhase
  message: string
  url?: string
  logPath: string
  recovery?: {
    attempt: number
    maxAttempts: number
    retryAt: string
  }
}

export interface OAuthResultNotice {
  ok: boolean
  message: string
}

export interface DesktopBridge {
  getHarnessState(): Promise<HarnessState>
  retryHarness(): Promise<void>
  showHarnessLog(): Promise<void>
  pickProjectDirectory(): Promise<string | null>
  onHarnessState(listener: (state: HarnessState) => void): () => void
  onCommand(listener: (command: DesktopRendererCommand) => void): () => void
  plugins: {
    getState(): Promise<DesktopPluginPolicySnapshot>
    update(input: UpdateDesktopPluginPolicyInput): Promise<DesktopPluginPolicySnapshot>
    installRegistry(input: InstallDesktopPluginInput): Promise<DesktopPluginInstallResult>
    installDirectory(): Promise<DesktopPluginInstallResult | undefined>
    onChanged(listener: (snapshot: DesktopPluginPolicySnapshot) => void): () => void
  }
  appSnapshots: {
    getState(): Promise<AppSnapshotState>
    refresh(): Promise<AppSnapshotState>
    update(input: UpdateAppSnapshotSettingsInput): Promise<AppSnapshotState>
    capture(): Promise<void>
    openScreenRecordingSettings(): Promise<void>
    onChanged(listener: (state: AppSnapshotState) => void): () => void
    onCaptured(listener: (capture: AppSnapshotCapture) => void): () => void
    onError(listener: (notice: AppSnapshotErrorNotice) => void): () => void
  }
  browser: {
    getState(): Promise<BrowserState>
    update(input: UpdateBrowserSettingsInput): Promise<BrowserState>
    navigate(input: BrowserUiNavigateInput): Promise<BrowserState>
    openManagement(input: BrowserUiOpenManagementInput): Promise<BrowserState>
    activateTab(input: BrowserUiTabInput): Promise<BrowserState>
    pointer(input: BrowserUiPointerInput): Promise<BrowserState>
    scrollAt(input: BrowserUiScrollInput): Promise<BrowserState>
    keyboard(input: BrowserUiKeyboardInput): Promise<BrowserState>
    newTab(): Promise<BrowserState>
    closeTab(input: BrowserUiTabInput): Promise<BrowserState>
    back(): Promise<BrowserState>
    forward(): Promise<BrowserState>
    reload(): Promise<BrowserState>
    refreshFrame(): Promise<BrowserState>
    stop(): Promise<BrowserState>
    listHistory(): Promise<BrowserHistoryEntry[]>
    clearHistory(): Promise<BrowserState>
    clearData(): Promise<BrowserState>
    onChanged(listener: (state: BrowserState) => void): () => void
    onFrame(listener: (frame: BrowserFrame | undefined) => void): () => void
  }
  git: {
    review(input: DesktopGitReviewInput): Promise<GitReviewSnapshot>
    mutateIndex(input: DesktopGitIndexMutationInput): Promise<GitIndexMutationResult>
    previewCommit(input: DesktopGitCommitPreviewInput): Promise<GitCommitPreview>
    confirmCommit(input: DesktopGitCommitConfirmInput): Promise<GitCommitResult>
    previewRevert(input: DesktopGitRevertPreviewInput): Promise<GitRevertPreview>
    confirmRevert(input: DesktopGitRevertConfirmInput): Promise<GitRevertResult>
    previewPush(input: DesktopGitPushPreviewInput): Promise<GitPushPreview>
    confirmPush(input: DesktopGitPushConfirmInput): Promise<GitPushResult>
    comments: {
      list(input: DesktopGitReviewCommentsInput): Promise<GitReviewCommentSnapshot>
      add(input: AddGitReviewCommentInput): Promise<GitReviewCommentSnapshot>
      remove(input: DeleteGitReviewCommentInput): Promise<GitReviewCommentSnapshot>
      onChanged(listener: (event: GitReviewCommentsChangedEvent) => void): () => void
    }
  }
  worktrees: {
    list(): Promise<WorktreeSnapshot>
    reconcile(): Promise<WorktreeSnapshot>
    previewCleanup(input: DesktopWorktreeCleanupPreviewInput): Promise<WorktreeCleanupPreview>
    confirmCleanup(input: DesktopWorktreeCleanupConfirmInput): Promise<WorktreeCleanupResult>
    previewRecovery(input: DesktopWorktreeRecoveryPreviewInput): Promise<WorktreeRecoveryPreview>
    confirmRecovery(input: DesktopWorktreeRecoveryConfirmInput): Promise<WorktreeRecoveryResult>
    previewHandoff(input: DesktopWorktreeHandoffPreflightInput): Promise<WorktreeHandoffPreview>
    confirmHandoff(input: DesktopWorktreeHandoffConfirmInput): Promise<WorktreeHandoffResult>
    onChanged(listener: (snapshot: WorktreeSnapshot) => void): () => void
  }
  computer: {
    getState(): Promise<ComputerControlSnapshot>
    refresh(): Promise<ComputerControlSnapshot>
    updatePolicy(input: UpdateComputerControlPolicyInput): Promise<ComputerControlSnapshot>
    pauseActions(): Promise<ComputerControlSnapshot>
    resumeActions(): Promise<ComputerControlSnapshot>
    stop(): Promise<ComputerControlSnapshot>
    openPermissionSettings(kind: 'screen-recording' | 'accessibility'): Promise<void>
    onChanged(listener: (snapshot: ComputerControlSnapshot) => void): () => void
  }
  automations: {
    list(): Promise<AutomationTaskCenterSnapshot>
    listRuns(input: DesktopListAutomationRunsInput): Promise<AutomationRunPage>
    create(input: DesktopCreateAutomationInput): Promise<AutomationTaskCenterSnapshot>
    setState(input: DesktopSetAutomationStateInput): Promise<AutomationTaskCenterSnapshot>
    delete(input: DesktopDeleteAutomationInput): Promise<AutomationTaskCenterSnapshot>
    queueRun(input: DesktopQueueAutomationRunInput): Promise<AutomationTaskCenterSnapshot>
    cancelRun(input: DesktopCancelAutomationRunInput): Promise<AutomationTaskCenterSnapshot>
    openSession(input: DesktopOpenAutomationSessionInput): Promise<void>
    onChanged(listener: (notice: AutomationChangedNotice) => void): () => void
  }
  connections: {
    list(): Promise<ConnectionSnapshot>
    connectApiKey(input: ConnectApiKeyInput): Promise<ConnectionSnapshot>
    disconnect(input: DisconnectConnectionInput): Promise<ConnectionSnapshot>
    beginOAuth(input: BeginOAuthInput): Promise<BeginOAuthResult>
    cancelOAuth(input: CancelOAuthInput): Promise<void>
    onChanged(listener: (snapshot: ConnectionSnapshot) => void): () => void
    onOAuthResult(listener: (result: OAuthResultNotice) => void): () => void
  }
}
import type {
  AppSnapshotCapture,
  AppSnapshotErrorNotice,
  AppSnapshotState,
  AutomationChangedNotice,
  AutomationRunPage,
  AutomationTaskCenterSnapshot,
  BeginOAuthInput,
  BeginOAuthResult,
  BrowserFrame,
  BrowserHistoryEntry,
  BrowserState,
  BrowserUiKeyboardInput,
  BrowserUiNavigateInput,
  BrowserUiOpenManagementInput,
  BrowserUiPointerInput,
  BrowserUiScrollInput,
  BrowserUiTabInput,
  CancelOAuthInput,
  AddGitReviewCommentInput,
  ConnectApiKeyInput,
  ConnectionSnapshot,
  ComputerControlSnapshot,
  DisconnectConnectionInput,
  DesktopCancelAutomationRunInput,
  DesktopCreateAutomationInput,
  DesktopDeleteAutomationInput,
  DesktopListAutomationRunsInput,
  DesktopRendererCommand,
  DesktopGitCommitConfirmInput,
  DesktopGitCommitPreviewInput,
  DesktopGitIndexMutationInput,
  DesktopGitPushConfirmInput,
  DesktopGitPushPreviewInput,
  DesktopGitRevertConfirmInput,
  DesktopGitRevertPreviewInput,
  DesktopGitReviewInput,
  DesktopGitReviewCommentsInput,
  DesktopOpenAutomationSessionInput,
  DesktopPluginInstallResult,
  DesktopPluginPolicySnapshot,
  DesktopQueueAutomationRunInput,
  DesktopSetAutomationStateInput,
  DesktopWorktreeCleanupConfirmInput,
  DesktopWorktreeCleanupPreviewInput,
  DesktopWorktreeRecoveryConfirmInput,
  DesktopWorktreeRecoveryPreviewInput,
  DesktopWorktreeHandoffConfirmInput,
  DesktopWorktreeHandoffPreflightInput,
  DeleteGitReviewCommentInput,
  GitReviewCommentSnapshot,
  GitReviewCommentsChangedEvent,
  GitReviewSnapshot,
  GitCommitPreview,
  GitCommitResult,
  GitIndexMutationResult,
  GitPushPreview,
  GitPushResult,
  GitRevertPreview,
  GitRevertResult,
  InstallDesktopPluginInput,
  UpdateComputerControlPolicyInput,
  UpdateDesktopPluginPolicyInput,
  UpdateBrowserSettingsInput,
  UpdateAppSnapshotSettingsInput,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
  WorktreeRecoveryPreview,
  WorktreeRecoveryResult,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
  WorktreeSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'
