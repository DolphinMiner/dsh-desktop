import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@dolphinminer/dsh-desktop-host'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opened: { type: 'boolean', required: true },
    path: { type: 'string', required: true },
  },
} as const

const JSON_OUTPUT_SCHEMA = { type: 'json' } as const

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

  ctx.on('tools/pre-execute', async (execution, next) => {
    const downstream = await next()
    if (downstream.kind !== 'allow' || execution.name !== 'desktop_open_file') return downstream
    return {
      kind: 'ask',
      reason: 'Opening a file launches another application. Approve this operation once to continue.',
    }
  })
}
