import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dolphinminer/dsh-desktop-host'
import type {
  BrowserObservation,
  ComputerAction,
  GitReviewScope,
} from '@dolphinminer/dsh-desktop-protocol'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opened: { type: 'boolean', required: true },
    path: { type: 'string', required: true },
  },
} as const

const JSON_OUTPUT_SCHEMA = { type: 'json' } as const
const BROWSER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1], required: true },
    snapshotId: { type: 'string', required: true },
    tabId: { type: 'string', required: true },
    observedAt: { type: 'string', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    ariaSnapshot: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    screenshotCaptured: { type: 'boolean', required: true },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/jpeg'], required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
  },
} as const
const BROWSER_TABS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1], required: true },
    revision: { type: 'integer', required: true },
    activeTabId: { type: 'string', required: true },
    tabs: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          loading: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const
const COMPUTER_ACTION_TIMEOUT_MS = 65_000
const BROWSER_ACTION_TIMEOUT_MS = 45_000
const GIT_READ_TIMEOUT_MS = 35_000
const WORKTREE_PROVISION_TIMEOUT_MS = 65_000
const MAX_AGENT_GIT_ENTRIES = 500
const MAX_AGENT_PATCH_CHARS = 200_000
const COMPUTER_ACTION_TOOLS = new Set([
  'computer_click',
  'computer_click_at',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_scroll_at',
])

interface BrowserToolImage {
  attachmentId: string
  mediaType: 'image/jpeg'
  bytes: number
  width: number
  height: number
  name?: string
}

interface BrowserToolValue extends BrowserObservation {
  image?: BrowserToolImage
}

function renderBrowserResult(value: BrowserToolValue): ContentBlock[] {
  const { image, ...observation } = value
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(observation) }]
  if (image !== undefined) {
    content.push({
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(image.attachmentId),
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
      },
    })
  }
  return content
}

async function routeAcceptsImages(ctx: Context, exec: ToolRunContext): Promise<boolean> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal)
    return active.inputModalities?.includes('image') === true
  } catch (error) {
    if (exec.signal.aborted) throw exec.signal.reason ?? error
    return false
  }
}

async function browserToolValue(
  ctx: Context,
  observation: BrowserObservation,
  exec: ToolRunContext,
): Promise<BrowserToolValue> {
  if (!observation.screenshotCaptured) return observation
  const attachments = ctx.get('attachments')
  if (attachments === undefined || !attachments.imageLimits.mediaTypes.includes('image/jpeg') ||
    !(await routeAcceptsImages(ctx, exec))) return observation
  const frame = await ctx.desktopBridge.call('browser.screenshot', {
    sessionId: agentSessionId(exec),
    snapshotId: observation.snapshotId,
  }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
  const limits = attachments.imageLimits
  if (frame.data.byteLength > Math.min(limits.maxImageBytes, limits.maxMessageImageBytes) ||
    frame.pixelWidth * frame.pixelHeight > limits.maxImagePixels) return observation
  const ref = await attachments.saveImage({
    data: frame.data,
    mediaType: frame.mediaType,
    name: 'browser-page.jpg',
  })
  return {
    ...observation,
    image: {
      attachmentId: ref.attachmentId,
      mediaType: 'image/jpeg',
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    },
  }
}

function agentSessionId(exec: { agent?: { id: string } }): string {
  const sessionId = exec.agent?.id
  if (sessionId === undefined) throw new Error('Desktop actions require an agent session.')
  return sessionId
}

function agentWorkspace(exec: { agent?: { id: string; session: { header: { cwd?: string } } } }): {
  sessionId: string
  workspaceRoot: string
} {
  const sessionId = exec.agent?.id
  const workspaceRoot = exec.agent?.session.header.cwd
  if (sessionId === undefined || workspaceRoot === undefined) {
    throw new Error('This desktop file action requires an agent session with a workspace.')
  }
  return { sessionId, workspaceRoot }
}

export const inject = ['desktopBridge', 'tools']

export function apply(ctx: Context): void {
  const act = async (
    snapshotId: string,
    action: ComputerAction,
    exec: { agent?: { id: string }; signal: AbortSignal },
  ) => JSON.parse(JSON.stringify(await ctx.desktopBridge.call(
    'computer.act',
    {
      actionId: randomUUID(),
      sessionId: agentSessionId(exec),
      snapshotId,
      action,
    },
    { signal: exec.signal, timeoutMs: COMPUTER_ACTION_TIMEOUT_MS },
  )))

  ctx.tools.register(defineTool({
    name: 'computer_get_permissions',
    description: 'Check whether this Mac allows read-only screen observation and accessibility inspection.',
    parameters: {},
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Check computer permissions', kind: 'read' }),
    async execute(_args, exec) {
      return JSON.parse(JSON.stringify(await ctx.desktopBridge.call(
        'computer.getPermissions',
        {},
        { signal: exec.signal },
      )))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_list_apps',
    description: 'List running Mac applications and the durable Computer Control policy that allows each app.',
    parameters: {},
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'List running applications', kind: 'read' }),
    async execute(_args, exec) {
      return JSON.parse(JSON.stringify(await ctx.desktopBridge.call(
        'computer.listApps',
        {},
        { signal: exec.signal },
      )))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_observe',
    description: 'Observe an allowed Mac application. Omit application to use the allowed frontmost app. Read only.',
    parameters: {
      application: {
        type: 'string',
        description: 'Optional exact application name or bundle identifier from computer_list_apps.',
      },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: args.application === undefined ? 'Observe frontmost application' : `Observe ${args.application}`,
      kind: 'read',
    }),
    timeoutMs: 30_000,
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      if (sessionId === undefined) throw new Error('Computer observation requires an agent session.')
      return JSON.parse(JSON.stringify(await ctx.desktopBridge.call(
        'computer.observe',
        { sessionId, ...(args.application === undefined ? {} : { application: args.application }) },
        { signal: exec.signal, timeoutMs: 30_000 },
      )))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Open an HTTP or HTTPS URL in the isolated DSH controlled browser and return the resulting page observation.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute HTTP or HTTPS URL.' },
      new_tab: { type: 'boolean', description: 'Open the URL in a new controlled-browser tab.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'read' }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const observation = await ctx.desktopBridge.call('browser.navigate', {
        actionId: randomUUID(),
        sessionId: agentSessionId(exec),
        url: args.url,
        ...(args.new_tab === undefined ? {} : { newTab: args.new_tab }),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_observe',
    description: 'Read the current controlled-browser page as a bounded accessibility snapshot. Use this before semantic actions.',
    parameters: {
      tab_id: { type: 'string', description: 'Optional controlled-browser tab ID.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: () => ({ card: 'generic', title: 'Observe browser page', kind: 'read' }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const observation = await ctx.desktopBridge.call('browser.observe', {
        sessionId: agentSessionId(exec),
        ...(args.tab_id === undefined ? {} : { tabId: args.tab_id }),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List the open controlled-browser tabs and identify the active tab.',
    parameters: {},
    output: {
      schema: BROWSER_TABS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'List browser tabs', kind: 'read' }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return ctx.desktopBridge.call('browser.tabs', {
        sessionId: agentSessionId(exec),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tab',
    description: 'Create, activate, or close a controlled-browser tab from the latest tab list.',
    parameters: {
      action: { type: 'string', enum: ['new', 'activate', 'close'], required: true },
      revision: { type: 'integer', required: true, description: 'Revision returned by browser_tabs.' },
      tab_id: { type: 'string', description: 'Required for activate and close; omit for new.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'new' ? 'New browser tab' :
        args.action === 'activate' ? 'Switch browser tab' : 'Close browser tab',
      kind: 'execute',
    }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if ((args.action === 'new') === (args.tab_id !== undefined)) {
        throw new Error('browser_tab requires tab_id only for activate or close.')
      }
      const observation = await ctx.desktopBridge.call('browser.tab', {
        actionId: randomUUID(),
        sessionId: agentSessionId(exec),
        revision: args.revision,
        action: args.action,
        ...(args.tab_id === undefined ? {} : { tabId: args.tab_id }),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click one uniquely named accessible element from the latest controlled-browser observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest browser snapshot ID.' },
      role: { type: 'string', required: true, description: 'Accessible role from the snapshot.' },
      name: { type: 'string', required: true, description: 'Accessible name from the snapshot.' },
      exact: { type: 'boolean', description: 'Require an exact accessible-name match. Defaults to true.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: args => ({ card: 'generic', title: `Click ${args.name}`, kind: 'execute' }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const observation = await ctx.desktopBridge.call('browser.click', {
        actionId: randomUUID(),
        sessionId: agentSessionId(exec),
        snapshotId: args.snapshot_id,
        role: args.role,
        name: args.name,
        ...(args.exact === undefined ? {} : { exact: args.exact }),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Fill one uniquely named accessible field from the latest browser observation and optionally submit it.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest browser snapshot ID.' },
      role: { type: 'string', required: true, description: 'Accessible role from the snapshot.' },
      name: { type: 'string', required: true, description: 'Exact accessible name from the snapshot.' },
      text: { type: 'string', required: true, description: 'Text to enter.' },
      submit: { type: 'boolean', description: 'Press Enter after filling the field.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: args => ({
      card: 'generic',
      title: `Type ${String(args.text.length)} characters in browser`,
      kind: 'execute',
    }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const observation = await ctx.desktopBridge.call('browser.type', {
        actionId: randomUUID(),
        sessionId: agentSessionId(exec),
        snapshotId: args.snapshot_id,
        role: args.role,
        name: args.name,
        text: args.text,
        ...(args.submit === undefined ? {} : { submit: args.submit }),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select',
    description: 'Select one option in a native page dropdown from the latest browser observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Snapshot ID returned by a browser tool.' },
      name: { type: 'string', required: true, description: 'Accessible name of the dropdown.' },
      option: { type: 'string', required: true, description: 'Exact accessible name of the option.' },
      exact: { type: 'boolean', description: 'Require an exact dropdown-name match. Defaults to true.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Select browser option',
      kind: 'execute',
    }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const observation = await ctx.desktopBridge.call('browser.select', {
        actionId: randomUUID(),
        sessionId: agentSessionId(exec),
        snapshotId: args.snapshot_id,
        name: args.name,
        option: args.option,
        ...(args.exact === undefined ? {} : { exact: args.exact }),
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the current controlled-browser page from the latest compatible observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest browser snapshot ID.' },
      delta_x: { type: 'number', required: true, description: 'Horizontal scroll amount in CSS pixels.' },
      delta_y: { type: 'number', required: true, description: 'Vertical scroll amount in CSS pixels.' },
    },
    output: {
      schema: BROWSER_OUTPUT_SCHEMA,
      render: (_args, value) => renderBrowserResult(value),
    },
    presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'execute' }),
    timeoutMs: BROWSER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const observation = await ctx.desktopBridge.call('browser.scroll', {
        actionId: randomUUID(),
        sessionId: agentSessionId(exec),
        snapshotId: args.snapshot_id,
        deltaX: args.delta_x,
        deltaY: args.delta_y,
      }, { signal: exec.signal, timeoutMs: BROWSER_ACTION_TIMEOUT_MS })
      return browserToolValue(ctx, observation, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_reveal_file',
    description: 'Reveal an existing file or directory inside the current workspace in Finder.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Workspace-relative path, or an absolute path inside the current workspace.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Revealed ${value.path} in Finder.` }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Reveal ${args.path}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec) {
      return ctx.desktopBridge.call('desktop.revealPath', {
        ...agentWorkspace(exec),
        path: args.path,
      }, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_open_file',
    description: 'Open a non-executable file inside the current workspace with its default macOS application.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Workspace-relative path, or an absolute path inside the current workspace.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Opened ${value.path}.` }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Open ${args.path}`,
      kind: 'execute',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec) {
      return ctx.desktopBridge.call('desktop.openPath', {
        ...agentWorkspace(exec),
        path: args.path,
      }, { signal: exec.signal })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_git_status',
    description: 'Read the authoritative Git branch and working-tree status for the current workspace repository.',
    parameters: {},
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Read Git status', kind: 'read' }),
    timeoutMs: GIT_READ_TIMEOUT_MS * 2 + 5_000,
    async execute(_args, exec) {
      const workspace = agentWorkspace(exec)
      const repository = await ctx.desktopBridge.call(
        'git.discover',
        workspace,
        { signal: exec.signal, timeoutMs: GIT_READ_TIMEOUT_MS },
      )
      const status = await ctx.desktopBridge.call(
        'git.status',
        { ...workspace, repositoryRoot: repository.root },
        { signal: exec.signal, timeoutMs: GIT_READ_TIMEOUT_MS },
      )
      return JSON.parse(JSON.stringify({
        ...status,
        totalEntries: status.entries.length,
        entriesTruncated: status.entries.length > MAX_AGENT_GIT_ENTRIES,
        entries: status.entries.slice(0, MAX_AGENT_GIT_ENTRIES),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_git_review',
    description: 'Read an authoritative Git patch for unstaged, staged, commit, branch, or last completed turn review.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['unstaged', 'staged', 'commit', 'branch', 'completed-turn'],
        required: true,
        description: 'Git review scope.',
      },
      ref: {
        type: 'string',
        description: 'Required commit ref for commit scope or base ref for branch scope.',
      },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Review ${args.scope} changes`,
      kind: 'read',
    }),
    timeoutMs: GIT_READ_TIMEOUT_MS * 2 + 5_000,
    async execute(args, exec) {
      let scope: GitReviewScope
      if (args.scope === 'commit' || args.scope === 'branch') {
        if (args.ref === undefined || args.ref.trim() === '') {
          throw new Error(`${args.scope} review requires an explicit ref.`)
        }
        scope = args.scope === 'commit'
          ? { kind: 'commit', ref: args.ref }
          : { kind: 'branch', baseRef: args.ref }
      } else {
        if (args.ref !== undefined) throw new Error(`${args.scope} review does not accept a ref.`)
        scope = { kind: args.scope }
      }
      const workspace = agentWorkspace(exec)
      const repository = await ctx.desktopBridge.call(
        'git.discover',
        workspace,
        { signal: exec.signal, timeoutMs: GIT_READ_TIMEOUT_MS },
      )
      const review = await ctx.desktopBridge.call('git.review', {
        ...workspace,
        repositoryRoot: repository.root,
        scope,
      }, { signal: exec.signal, timeoutMs: GIT_READ_TIMEOUT_MS })
      return JSON.parse(JSON.stringify({
        ...review,
        totalFiles: review.files.length,
        filesTruncated: review.files.length > MAX_AGENT_GIT_ENTRIES,
        files: review.files.slice(0, MAX_AGENT_GIT_ENTRIES),
        patchTruncated: review.patch.length > MAX_AGENT_PATCH_CHARS,
        patch: review.patch.slice(0, MAX_AGENT_PATCH_CHARS),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'desktop_create_worktree',
    description: 'Create a new isolated, app-managed Git worktree for a follow-up agent session.',
    parameters: {
      base_ref: {
        type: 'string',
        required: true,
        description: 'Explicit branch, tag, or commit to use as the new worktree base.',
      },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Create worktree from ${args.base_ref}`,
      kind: 'execute',
    }),
    timeoutMs: WORKTREE_PROVISION_TIMEOUT_MS + 5_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspace = agentWorkspace(exec)
      const result = await ctx.desktopBridge.call('worktrees.provision', {
        operationId: randomUUID(),
        requestedBySessionId: workspace.sessionId,
        workspaceRoot: workspace.workspaceRoot,
        baseRef: args.base_ref,
      }, { signal: exec.signal, timeoutMs: WORKTREE_PROVISION_TIMEOUT_MS })
      return JSON.parse(JSON.stringify(result))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click',
    description: 'Click an accessibility element from the latest compatible computer observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest computer snapshot ID.' },
      element_id: { type: 'string', required: true, description: 'Accessibility element ID from that snapshot.' },
      button: { type: 'string', enum: ['left', 'right'], required: true },
      click_count: { type: 'integer', enum: [1, 2], required: true },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `${args.button === 'right' ? 'Right-click' : 'Click'} interface element`,
      kind: 'execute',
    }),
    timeoutMs: COMPUTER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: (args, exec) => act(args.snapshot_id, {
      kind: 'click',
      target: { mode: 'element', elementId: args.element_id },
      button: args.button,
      clickCount: args.click_count,
    }, exec),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click_at',
    description: 'Fallback click at capture-relative coordinates from the latest compatible computer observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest computer snapshot ID.' },
      x: { type: 'number', required: true, description: 'Capture-relative horizontal coordinate.' },
      y: { type: 'number', required: true, description: 'Capture-relative vertical coordinate.' },
      button: { type: 'string', enum: ['left', 'right'], required: true },
      click_count: { type: 'integer', enum: [1, 2], required: true },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Click observed point', kind: 'execute' }),
    timeoutMs: COMPUTER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: (args, exec) => act(args.snapshot_id, {
      kind: 'click',
      target: { mode: 'point', coordinateSpace: 'capture', point: { x: args.x, y: args.y } },
      button: args.button,
      clickCount: args.click_count,
    }, exec),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_type',
    description: 'Enter text into a non-secure accessibility element from the latest compatible observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest computer snapshot ID.' },
      element_id: { type: 'string', required: true, description: 'Editable accessibility element ID.' },
      text: { type: 'string', required: true, description: 'Text to enter. Secure fields are always refused.' },
      replace: { type: 'boolean', required: true, description: 'Replace the current field contents before typing.' },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Type ${String(args.text.length)} characters`,
      kind: 'execute',
    }),
    timeoutMs: COMPUTER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: (args, exec) => act(args.snapshot_id, {
      kind: 'type',
      elementId: args.element_id,
      text: args.text,
      replace: args.replace,
    }, exec),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_key',
    description: 'Press a named key or a Command/Control shortcut against the latest compatible observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest computer snapshot ID.' },
      key: { type: 'string', required: true, description: 'Named key or one alphanumeric shortcut key.' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['command', 'control', 'option', 'shift'] },
        required: true,
        description: 'Unique modifier keys. Printable keys require Command or Control.',
      },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Press ${[...args.modifiers, args.key].join('+')}`,
      kind: 'execute',
    }),
    timeoutMs: COMPUTER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: (args, exec) => act(args.snapshot_id, {
      kind: 'key',
      key: args.key,
      modifiers: args.modifiers,
    }, exec),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_scroll',
    description: 'Scroll the selected surface or an accessibility element from the latest compatible observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest computer snapshot ID.' },
      element_id: { type: 'string', description: 'Optional accessibility element to scroll over.' },
      delta_x: { type: 'number', required: true },
      delta_y: { type: 'number', required: true },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Scroll observed surface', kind: 'execute' }),
    timeoutMs: COMPUTER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: (args, exec) => act(args.snapshot_id, {
      kind: 'scroll',
      ...(args.element_id === undefined
        ? {}
        : { target: { mode: 'element' as const, elementId: args.element_id } }),
      deltaX: args.delta_x,
      deltaY: args.delta_y,
    }, exec),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_scroll_at',
    description: 'Fallback scroll at capture-relative coordinates from the latest compatible computer observation.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Latest computer snapshot ID.' },
      x: { type: 'number', required: true, description: 'Capture-relative horizontal coordinate.' },
      y: { type: 'number', required: true, description: 'Capture-relative vertical coordinate.' },
      delta_x: { type: 'number', required: true },
      delta_y: { type: 'number', required: true },
    },
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Scroll observed point', kind: 'execute' }),
    timeoutMs: COMPUTER_ACTION_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: (args, exec) => act(args.snapshot_id, {
      kind: 'scroll',
      target: { mode: 'point', coordinateSpace: 'capture', point: { x: args.x, y: args.y } },
      deltaX: args.delta_x,
      deltaY: args.delta_y,
    }, exec),
  }))

  ctx.on('tools/pre-execute', async (execution, next) => {
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    if (COMPUTER_ACTION_TOOLS.has(execution.name)) {
      return {
        kind: 'ask',
        reason: 'This computer action can change another application. Approve this operation once to continue.',
      }
    }
    if (execution.name === 'desktop_create_worktree') {
      return {
        kind: 'ask',
        reason: 'Creating a worktree adds a local Git branch and checkout. Approve this operation once to continue.',
      }
    }
    if (execution.name !== 'desktop_open_file') return downstream
    return {
      kind: 'ask',
      reason: 'Opening a file launches another application. Approve this operation once to continue.',
    }
  })
}
