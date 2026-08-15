import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@dolphinminer/dsh-desktop-host'
import type { ComputerAction, GitReviewScope } from '@dolphinminer/dsh-desktop-protocol'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opened: { type: 'boolean', required: true },
    path: { type: 'string', required: true },
  },
} as const

const JSON_OUTPUT_SCHEMA = { type: 'json' } as const
const COMPUTER_ACTION_TIMEOUT_MS = 65_000
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

function agentSessionId(exec: { agent?: { id: string } }): string {
  const sessionId = exec.agent?.id
  if (sessionId === undefined) throw new Error('Computer actions require an agent session.')
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
    description: 'List running Mac applications and report which user-selected target may be observed.',
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
    description: 'Observe the application, window, or display explicitly selected in Desktop settings. Read only.',
    parameters: {},
    output: {
      schema: JSON_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Observe selected computer target', kind: 'read' }),
    timeoutMs: 30_000,
    async execute(_args, exec) {
      const sessionId = exec.agent?.id
      if (sessionId === undefined) throw new Error('Computer observation requires an agent session.')
      return JSON.parse(JSON.stringify(await ctx.desktopBridge.call(
        'computer.observe',
        { sessionId },
        { signal: exec.signal, timeoutMs: 30_000 },
      )))
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
    description: 'Read an authoritative Git patch for unstaged, staged, commit, or branch-versus-merge-base review.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['unstaged', 'staged', 'commit', 'branch'],
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
