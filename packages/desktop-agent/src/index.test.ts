import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply } from './index.js'

test('registers workspace-bound file tools and asks before opening', async () => {
  const definitions: ToolDefinition[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  let gate: ((execution: { name: string }, next: () => Promise<{ kind: 'allow' }>) => Promise<unknown>) | undefined
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return { opened: true, path: '/repo/README.md' }
      },
    },
    on: (event: string, listener: typeof gate) => {
      if (event === 'tools/pre-execute') gate = listener
    },
  } as unknown as Context

  apply(ctx)
  assert.deepEqual(definitions.map(definition => definition.name), [
    'computer_get_permissions',
    'computer_list_apps',
    'computer_observe',
    'desktop_reveal_file',
    'desktop_open_file',
    'desktop_git_status',
    'desktop_create_worktree',
    'computer_click',
    'computer_click_at',
    'computer_type',
    'computer_key',
    'computer_scroll',
    'computer_scroll_at',
  ])

  const signal = new AbortController().signal
  await definitions[3]!.execute({ path: 'README.md' }, {
    agent: { id: 'session-1', session: { header: { cwd: '/repo' } } },
    signal,
  } as never)
  assert.deepEqual(calls, [{
    method: 'desktop.revealPath',
    params: {
      sessionId: 'session-1',
      workspaceRoot: '/repo',
      path: 'README.md',
    },
  }])

  assert.deepEqual(await gate?.({ name: 'desktop_open_file' }, async () => ({ kind: 'allow' })), {
    kind: 'ask',
    reason: 'Opening a file launches another application. Approve this operation once to continue.',
  })
  assert.deepEqual(await gate?.({ name: 'desktop_reveal_file' }, async () => ({ kind: 'allow' })), {
    kind: 'allow',
  })
  assert.deepEqual(await gate?.({ name: 'computer_click' }, async () => ({ kind: 'allow' })), {
    kind: 'ask',
    reason: 'This computer action can change another application. Approve this operation once to continue.',
  })
  assert.deepEqual(await gate?.({ name: 'desktop_create_worktree' }, async () => ({ kind: 'allow' })), {
    kind: 'ask',
    reason: 'Creating a worktree adds a local Git branch and checkout. Approve this operation once to continue.',
  })
})

test('reads Git status only through the current workspace repository identity', async () => {
  const definitions: ToolDefinition[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const repository = { root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git' }
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'git.discover') return repository
        return {
          repository,
          head: 'a'.repeat(40),
          branch: 'main',
          ahead: 0,
          behind: 0,
          clean: false,
          entries: Array.from({ length: 501 }, (_, index) => ({
            kind: 'untracked',
            path: `file-${String(index)}.txt`,
            indexStatus: '?',
            worktreeStatus: '?',
          })),
        }
      },
    },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)

  const tool = definitions.find(definition => definition.name === 'desktop_git_status')!
  const result = await tool.execute({}, {
    agent: { id: 'session-git', session: { header: { cwd: '/repo' } } },
    signal: new AbortController().signal,
  } as never) as { totalEntries: number; entriesTruncated: boolean; entries: unknown[] }

  assert.deepEqual(calls, [
    {
      method: 'git.discover',
      params: { sessionId: 'session-git', workspaceRoot: '/repo' },
    },
    {
      method: 'git.status',
      params: { sessionId: 'session-git', workspaceRoot: '/repo', repositoryRoot: '/repo' },
    },
  ])
  assert.equal(result.totalEntries, 501)
  assert.equal(result.entriesTruncated, true)
  assert.equal(result.entries.length, 500)
})

test('provisions an isolated worktree with a fresh durable operation ID', async () => {
  const definitions: ToolDefinition[] = []
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return { lifecycle: 'ready', worktreePath: '/worktrees/session-1' }
      },
    },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)

  const tool = definitions.find(definition => definition.name === 'desktop_create_worktree')!
  await tool.execute({ base_ref: 'refs/heads/main' }, {
    agent: { id: 'session-worktree', session: { header: { cwd: '/repo' } } },
    signal: new AbortController().signal,
  } as never)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'worktrees.provision')
  assert.match(String(calls[0]!.params.operationId), /^[a-f0-9-]{36}$/i)
  assert.deepEqual({ ...calls[0]!.params, operationId: '<id>' }, {
    operationId: '<id>',
    requestedBySessionId: 'session-worktree',
    workspaceRoot: '/repo',
    baseRef: 'refs/heads/main',
  })
})

test('refuses a desktop file action without an authoritative workspace', async () => {
  const definitions: ToolDefinition[] = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: { call: () => Promise.reject(new Error('must not be called')) },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)

  await assert.rejects(definitions[3]!.execute({ path: 'README.md' }, {
    agent: { id: 'session-1', session: { header: {} } },
    signal: new AbortController().signal,
  } as never), /requires an agent session with a workspace/)
})

test('registers read-only computer tools and binds observations to the agent session', async () => {
  const definitions: ToolDefinition[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params })
        return {}
      },
    },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)
  const execution = {
    agent: { id: 'session-7', session: { header: { cwd: '/repo' } } },
    signal: new AbortController().signal,
  } as never

  await definitions[0]!.execute({}, execution)
  await definitions[1]!.execute({}, execution)
  await definitions[2]!.execute({}, execution)
  assert.deepEqual(calls, [
    { method: 'computer.getPermissions', params: {} },
    { method: 'computer.listApps', params: {} },
    { method: 'computer.observe', params: { sessionId: 'session-7' } },
  ])
})

test('binds approved computer actions to fresh IDs and redacts typed text from presentation', async () => {
  const definitions: ToolDefinition[] = []
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return { accepted: true }
      },
    },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)

  const typeTool = definitions.find(definition => definition.name === 'computer_type')!
  const clickTool = definitions.find(definition => definition.name === 'computer_click')!
  const execution = {
    agent: { id: 'session-action', session: { header: { cwd: '/repo' } } },
    signal: new AbortController().signal,
  } as never

  await clickTool.execute({
    snapshot_id: 'snapshot-1',
    element_id: 'ax:button',
    button: 'left',
    click_count: 1,
  }, execution)
  await typeTool.execute({
    snapshot_id: 'snapshot-2',
    element_id: 'ax:text',
    text: 'private draft',
    replace: true,
  }, execution)

  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'computer.act')
  assert.equal(calls[1]!.method, 'computer.act')
  assert.match(String(calls[0]!.params.actionId), /^[a-f0-9-]{36}$/i)
  assert.notEqual(calls[0]!.params.actionId, calls[1]!.params.actionId)
  assert.equal(calls[0]!.params.sessionId, 'session-action')
  assert.deepEqual(calls[0]!.params.action, {
    kind: 'click',
    target: { mode: 'element', elementId: 'ax:button' },
    button: 'left',
    clickCount: 1,
  })
  assert.deepEqual(calls[1]!.params.action, {
    kind: 'type',
    elementId: 'ax:text',
    text: 'private draft',
    replace: true,
  })
  assert.deepEqual(typeTool.presentCall?.({
    snapshot_id: 'snapshot-2',
    element_id: 'ax:text',
    text: 'private draft',
    replace: true,
  }), {
    card: 'generic',
    title: 'Type 13 characters',
    kind: 'execute',
  })
  assert.equal(JSON.stringify(typeTool.presentCall?.({
    snapshot_id: 'snapshot-2',
    element_id: 'ax:text',
    text: 'private draft',
    replace: true,
  })).includes('private draft'), false)
})
