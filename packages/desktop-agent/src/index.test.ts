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
