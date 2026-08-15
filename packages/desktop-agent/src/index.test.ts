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
    'desktop_reveal_file',
    'desktop_open_file',
  ])

  const signal = new AbortController().signal
  await definitions[0]!.execute({ path: 'README.md' }, {
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
})

test('refuses a desktop file action without an authoritative workspace', async () => {
  const definitions: ToolDefinition[] = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: { call: () => Promise.reject(new Error('must not be called')) },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)

  await assert.rejects(definitions[0]!.execute({ path: 'README.md' }, {
    agent: { id: 'session-1', session: { header: {} } },
    signal: new AbortController().signal,
  } as never), /requires an agent session with a workspace/)
})
