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
    selectTarget(input: SelectComputerTargetInput): Promise<ComputerControlSnapshot>
    grantPendingActions(): Promise<ComputerControlSnapshot>
    pauseActions(): Promise<ComputerControlSnapshot>
    resumeActions(): Promise<ComputerControlSnapshot>
    revokeActions(): Promise<ComputerControlSnapshot>
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
  AutomationChangedNotice,
  AutomationRunPage,
  AutomationTaskCenterSnapshot,
  BeginOAuthInput,
  BeginOAuthResult,
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
  SelectComputerTargetInput,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
  WorktreeRecoveryPreview,
  WorktreeRecoveryResult,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
  WorktreeSnapshot,
} from '@dolphinminer/dsh-desktop-protocol'
