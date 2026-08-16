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
    'browser_navigate',
    'browser_observe',
    'browser_tabs',
    'browser_tab',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_scroll',
    'desktop_reveal_file',
    'desktop_open_file',
    'desktop_git_status',
    'desktop_git_review',
    'desktop_create_worktree',
    'computer_click',
    'computer_click_at',
    'computer_type',
    'computer_key',
    'computer_scroll',
    'computer_scroll_at',
  ])

  const signal = new AbortController().signal
  await definitions.find(definition => definition.name === 'desktop_reveal_file')!.execute({ path: 'README.md' }, {
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

test('reads bounded Git review scopes through the authoritative workspace repository', async () => {
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
          scope: { kind: 'branch', baseRef: 'main' },
          head: 'a'.repeat(40),
          baseCommit: 'b'.repeat(40),
          mergeBase: 'b'.repeat(40),
          files: Array.from({ length: 501 }, (_, index) => ({
            status: 'modified',
            path: `file-${String(index)}.txt`,
            patchAvailable: true,
          })),
          patch: 'x'.repeat(200_001),
        }
      },
    },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)

  const tool = definitions.find(definition => definition.name === 'desktop_git_review')!
  const execution = {
    agent: { id: 'session-review', session: { header: { cwd: '/repo' } } },
    signal: new AbortController().signal,
  } as never
  const result = await tool.execute({ scope: 'branch', ref: 'main' }, execution) as {
    totalFiles: number
    filesTruncated: boolean
    files: unknown[]
    patchTruncated: boolean
    patch: string
  }

  assert.deepEqual(calls, [{
    method: 'git.discover',
    params: { sessionId: 'session-review', workspaceRoot: '/repo' },
  }, {
    method: 'git.review',
    params: {
      sessionId: 'session-review',
      workspaceRoot: '/repo',
      repositoryRoot: '/repo',
      scope: { kind: 'branch', baseRef: 'main' },
    },
  }])
  assert.equal(result.totalFiles, 501)
  assert.equal(result.filesTruncated, true)
  assert.equal(result.files.length, 500)
  assert.equal(result.patchTruncated, true)
  assert.equal(result.patch.length, 200_000)

  calls.length = 0
  await assert.rejects(tool.execute({ scope: 'commit' }, execution), /requires an explicit ref/)
  assert.deepEqual(calls, [])

  await tool.execute({ scope: 'completed-turn' }, execution)
  assert.deepEqual(calls.at(-1), {
    method: 'git.review',
    params: {
      sessionId: 'session-review',
      workspaceRoot: '/repo',
      repositoryRoot: '/repo',
      scope: { kind: 'completed-turn' },
    },
  })
  calls.length = 0
  await assert.rejects(tool.execute({ scope: 'completed-turn', ref: 'HEAD' }, execution), /does not accept a ref/)
  assert.deepEqual(calls, [])
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

  await assert.rejects(definitions.find(definition => definition.name === 'desktop_reveal_file')!.execute({ path: 'README.md' }, {
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

test('binds browser tools to one agent session and latest browser snapshots', async () => {
  const definitions: ToolDefinition[] = []
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (method === 'browser.tabs') {
          return {
            version: 1,
            revision: 4,
            activeTabId: 'tab-1',
            tabs: [{ id: 'tab-1', url: 'https://example.com/', title: 'Example', loading: false }],
          }
        }
        return { snapshotId: 'snapshot-next' }
      },
    },
    on: () => undefined,
  } as unknown as Context
  apply(ctx)
  const execution = {
    agent: { id: 'session-browser', session: { header: { cwd: '/repo' } } },
    signal: new AbortController().signal,
  } as never

  await definitions.find(definition => definition.name === 'browser_navigate')!.execute({
    url: 'https://example.com',
    new_tab: true,
  }, execution)
  await definitions.find(definition => definition.name === 'browser_observe')!.execute({
    tab_id: 'tab-1',
  }, execution)
  await definitions.find(definition => definition.name === 'browser_tabs')!.execute({}, execution)
  await definitions.find(definition => definition.name === 'browser_tab')!.execute({
    action: 'new',
    revision: 4,
  }, execution)
  const typeTool = definitions.find(definition => definition.name === 'browser_type')!
  await typeTool.execute({
    snapshot_id: 'snapshot-1',
    role: 'textbox',
    name: 'Search',
    text: 'private query',
    submit: true,
  }, execution)
  const selectTool = definitions.find(definition => definition.name === 'browser_select')!
  await selectTool.execute({
    snapshot_id: 'snapshot-2',
    name: 'Country',
    option: 'China',
  }, execution)

  assert.equal(calls[0]!.method, 'browser.navigate')
  assert.match(String(calls[0]!.params.actionId), /^[a-f0-9-]{36}$/i)
  assert.deepEqual({ ...calls[0]!.params, actionId: '<id>' }, {
    actionId: '<id>',
    sessionId: 'session-browser',
    url: 'https://example.com',
    newTab: true,
  })
  assert.deepEqual(calls[1], {
    method: 'browser.observe',
    params: { sessionId: 'session-browser', tabId: 'tab-1' },
  })
  assert.deepEqual(calls[2], {
    method: 'browser.tabs',
    params: { sessionId: 'session-browser' },
  })
  assert.equal(calls[3]!.method, 'browser.tab')
  assert.match(String(calls[3]!.params.actionId), /^[a-f0-9-]{36}$/i)
  assert.deepEqual({ ...calls[3]!.params, actionId: '<id>' }, {
    actionId: '<id>',
    sessionId: 'session-browser',
    revision: 4,
    action: 'new',
  })
  assert.equal(calls[4]!.method, 'browser.type')
  assert.match(String(calls[4]!.params.actionId), /^[a-f0-9-]{36}$/i)
  assert.equal(calls[4]!.params.snapshotId, 'snapshot-1')
  assert.equal(calls[5]!.method, 'browser.select')
  assert.match(String(calls[5]!.params.actionId), /^[a-f0-9-]{36}$/i)
  assert.deepEqual({ ...calls[5]!.params, actionId: '<id>' }, {
    actionId: '<id>',
    sessionId: 'session-browser',
    snapshotId: 'snapshot-2',
    name: 'Country',
    option: 'China',
  })
  assert.deepEqual(typeTool.presentCall?.({
    snapshot_id: 'snapshot-1',
    role: 'textbox',
    name: 'Search',
    text: 'private query',
    submit: true,
  }), {
    card: 'generic',
    title: 'Type 13 characters in browser',
    kind: 'execute',
  })
  assert.equal(JSON.stringify(typeTool.presentCall?.({
    snapshot_id: 'snapshot-1',
    role: 'textbox',
    name: 'Search',
    text: 'private query',
    submit: true,
  })).includes('private query'), false)
  assert.equal(JSON.stringify(selectTool.presentCall?.({
    snapshot_id: 'snapshot-2',
    name: 'Account',
    option: 'private account',
  })).includes('private account'), false)
})

test('commits Browser screenshots through the official attachment store for vision routes', async () => {
  const definitions: ToolDefinition[] = []
  const calls: string[] = []
  const saved: Uint8Array[] = []
  let vision = true
  const observation = {
    version: 1 as const,
    snapshotId: 'snapshot-vision',
    tabId: 'tab-1',
    observedAt: '2026-08-16T12:00:00.000Z',
    url: 'https://example.com/',
    title: 'Example',
    ariaSnapshot: '- heading "Example" [level=1]',
    truncated: false,
    screenshotCaptured: true,
  }
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition) } },
    desktopBridge: {
      call: async (method: string) => {
        calls.push(method)
        if (method === 'browser.observe') return observation
        return {
          snapshotId: observation.snapshotId,
          tabId: observation.tabId,
          capturedAt: observation.observedAt,
          mediaType: 'image/jpeg',
          pixelWidth: 1280,
          pixelHeight: 800,
          data: new Uint8Array([1, 2, 3]),
        }
      },
    },
    get: (service: string) => service === 'attachments'
      ? {
          imageLimits: {
            maxImageBytes: 5_000_000,
            maxImagesPerMessage: 10,
            maxMessageImageBytes: 10_000_000,
            maxImagePixels: 2_000_000,
            mediaTypes: ['image/jpeg'],
          },
          saveImage: async ({ data }: { data: Uint8Array }) => {
            saved.push(data.slice())
            return {
              attachmentId: 'attachment-browser',
              mediaType: 'image/jpeg',
              bytes: data.byteLength,
              width: 1280,
              height: 800,
              name: 'browser-page.jpg',
            }
          },
        }
      : service === 'llm'
        ? { resolveModelInfo: async () => ({ inputModalities: vision ? ['text', 'image'] : ['text'] }) }
        : undefined,
    on: () => undefined,
  } as unknown as Context
  apply(ctx)
  const tool = definitions.find(definition => definition.name === 'browser_observe')!
  const result = await tool.execute({}, {
    agent: {
      id: 'session-browser',
      options: { provider: 'test', model: 'vision' },
      session: { header: { cwd: '/repo' }, requestHeader: () => undefined },
    },
    signal: new AbortController().signal,
  } as never) as typeof observation & { image: { attachmentId: string } }

  assert.deepEqual(calls, ['browser.observe', 'browser.screenshot'])
  assert.deepEqual(saved, [new Uint8Array([1, 2, 3])])
  assert.equal(result.image.attachmentId, 'attachment-browser')
  const content = tool.output.render({}, result)
  assert.equal(content[0]?.type, 'text')
  assert.equal(content[1]?.type, 'image')
  if (content[1]?.type === 'image') {
    assert.equal(content[1].attachment.attachmentId, 'attachment-browser')
  }

  vision = false
  calls.length = 0
  saved.length = 0
  const textOnly = await tool.execute({}, {
    agent: {
      id: 'session-browser',
      options: { provider: 'test', model: 'text-only' },
      session: { header: { cwd: '/repo' }, requestHeader: () => undefined },
    },
    signal: new AbortController().signal,
  } as never) as typeof observation & { image?: unknown }
  assert.deepEqual(calls, ['browser.observe'])
  assert.deepEqual(saved, [])
  assert.equal(textOnly.image, undefined)
})
