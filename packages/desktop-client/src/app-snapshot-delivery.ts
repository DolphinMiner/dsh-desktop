import type { ClientContext, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AppSnapshotCapture } from '@dolphinminer/dsh-desktop-protocol'

interface DraftConversation {
  createDraftImages(files: readonly File[]): readonly ComposerAttachment[]
  draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[]
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void
}

export function mountAppSnapshotDelivery(
  ctx: ClientContext,
  install: (scope: ClientContext) => () => void,
): void {
  ctx.inject(['conversation'], scope => {
    scope.effect(
      () => install(scope),
      'dsh-desktop: App Snapshot delivery',
    )
  })
}

function imageLimits(value: unknown): {
  mediaTypes: readonly string[]
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
} | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.mediaTypes) ||
    !candidate.mediaTypes.every(item => typeof item === 'string') ||
    !Number.isSafeInteger(candidate.maxImageBytes) || Number(candidate.maxImageBytes) <= 0 ||
    !Number.isSafeInteger(candidate.maxImagesPerMessage) || Number(candidate.maxImagesPerMessage) <= 0 ||
    !Number.isSafeInteger(candidate.maxMessageImageBytes) || Number(candidate.maxMessageImageBytes) <= 0) {
    return undefined
  }
  return {
    mediaTypes: candidate.mediaTypes,
    maxImageBytes: Number(candidate.maxImageBytes),
    maxImagesPerMessage: Number(candidate.maxImagesPerMessage),
    maxMessageImageBytes: Number(candidate.maxMessageImageBytes),
  }
}

function targetSession(capture: AppSnapshotCapture, sessions: SessionListState): SessionId {
  if (capture.destination.kind === 'session') {
    const requestedSessionId = capture.destination.sessionId
    const sessionId = sessions.ids.find(id => id === requestedSessionId)
    if (sessionId === undefined) {
      throw new Error('The selected App Snapshot conversation is no longer available.')
    }
    return sessionId
  }
  const sessionId = sessions.current ?? sessions.ids[0]
  if (sessionId === undefined) throw new Error('Open a conversation before capturing an app snapshot.')
  return sessionId
}

function snapshotText(capture: AppSnapshotCapture): string {
  const heading = `App snapshot from ${capture.sourceName}.`
  return capture.ocrText === undefined
    ? heading
    : `${heading}\n\nExtracted text:\n${capture.ocrText}`
}

export async function attachAppSnapshotCapture(
  ctx: ClientContext,
  capture: AppSnapshotCapture,
): Promise<string> {
  const sessions = ctx.sessions.list.getSnapshot()
  const sessionId = targetSession(capture, sessions)
  const binding = ctx.sessions.binding(sessionId)
  const scope = ctx.sessions.scope(sessionId)
  if (binding === undefined || scope === undefined) {
    throw new Error('The App Snapshot conversation is not ready.')
  }

  const input = ctx.conversation.input.for(scope)
  const conversation = ctx.conversation as unknown as DraftConversation
  const state = input.state.getSnapshot()
  const limits = imageLimits(binding.session.projections.faceOf('imageLimits').getSnapshot())
  const existing = conversation.draftImages(state.imageIds)
  if (limits !== undefined) {
    if (!limits.mediaTypes.includes(capture.mediaType)) {
      throw new Error('This model does not accept the captured image format.')
    }
    if (capture.data.byteLength > limits.maxImageBytes) {
      throw new Error('The captured image is larger than this model accepts.')
    }
    if (existing.length + 1 > limits.maxImagesPerMessage) {
      throw new Error('The current draft already contains the maximum number of images.')
    }
    const totalBytes = existing.reduce((sum, attachment) => sum + attachment.file.size, 0) +
      capture.data.byteLength
    if (totalBytes > limits.maxMessageImageBytes) {
      throw new Error('The current draft images are larger than this model accepts.')
    }
  }

  const file = new File([capture.data.slice().buffer as ArrayBuffer], capture.fileName, {
    type: capture.mediaType,
    lastModified: Date.parse(capture.capturedAt),
  })
  const attachments = conversation.createDraftImages([file])
  if (!input.addImages(attachments.map(attachment => attachment.id))) {
    conversation.releaseDraftImages(attachments)
    throw new Error('Wait for the current prompt submission before adding an app snapshot.')
  }
  const prior = state.draft.trim()
  input.setDraft(prior === '' ? snapshotText(capture) : `${state.draft}\n\n${snapshotText(capture)}`)
  ctx.sessions.open(sessionId)
  input.notify('info', `App snapshot from ${capture.sourceName} added to the draft.`)
  return sessions.byId[sessionId]?.displayTitle ?? sessionId
}
