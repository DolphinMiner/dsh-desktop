import assert from 'node:assert/strict'
import test from 'node:test'

import type { DesktopRendererCommand } from '@dolphinminer/dsh-desktop-protocol'

import { DesktopCommandEnvironment, runDesktopCommand } from './desktop-command.js'

interface MutableSource<T> {
  source: {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }
  update(value: T): void
}

function mutableSource<T>(initial: T): MutableSource<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    update(value) {
      snapshot = value
      for (const listener of listeners) listener()
    },
  }
}

function environment(options: { projectPath?: string | null } = {}): {
  value: DesktopCommandEnvironment
  operations: string[]
  sessions: MutableSource<unknown>
  workspaces: MutableSource<unknown>
} {
  const operations: string[] = []
  const sessions = mutableSource<unknown>({ phase: 'ready', current: 'session-1', byId: { 'session-1': {} } })
  const workspaces = mutableSource<unknown>({ phase: 'ready', items: [{ workspaceId: 'workspace-1' }] })
  const ctx = {
    sessions: {
      list: sessions.source,
      open: (id: string) => { operations.push(`session.open:${id}`) },
      binding: (id: string) => ({
        session: {
          cancel: async () => {
            operations.push(`session.cancel:${id}`)
            return { ok: true as const, value: undefined }
          },
        },
      }),
    },
    workspaces: {
      list: workspaces.source,
      create: async ({ path }: { path: string }) => {
        operations.push(`workspace.create:${path}`)
        return { workspaceId: 'workspace-created' }
      },
      startSession: (id?: string) => { operations.push(`workspace.start:${id ?? 'new'}`) },
    },
    layout: { toggleSidebar: () => { operations.push('layout.toggle') } },
  } as unknown as DesktopCommandEnvironment['ctx']
  return {
    value: {
      ctx,
      pickProjectDirectory: async () => options.projectPath ?? null,
      openSettings: section => { operations.push(`settings.open:${section ?? 'root'}`) },
    },
    operations,
    sessions,
    workspaces,
  }
}

test('opens a native project through the official workspace service', async () => {
  const runtime = environment({ projectPath: '/repo' })
  await runDesktopCommand(runtime.value, { type: 'project.open' })
  assert.deepEqual(runtime.operations, ['workspace.create:/repo', 'workspace.start:workspace-created'])

  const cancelled = environment({ projectPath: null })
  await runDesktopCommand(cancelled.value, { type: 'project.open' })
  assert.deepEqual(cancelled.operations, [])
})

test('waits for reconnect before reopening official sessions and workspaces', async () => {
  const runtime = environment()
  runtime.sessions.update({ phase: 'loading', current: undefined, byId: {} })
  const session = runDesktopCommand(runtime.value, { type: 'session.open', sessionId: 'session-2' })
  runtime.sessions.update({ phase: 'ready', current: undefined, byId: { 'session-2': {} } })
  await session

  runtime.workspaces.update({ phase: 'loading', items: [] })
  const workspace = runDesktopCommand(runtime.value, { type: 'workspace.open', workspaceId: 'workspace-2' })
  runtime.workspaces.update({ phase: 'ready', items: [{ workspaceId: 'workspace-2' }] })
  await workspace

  assert.deepEqual(runtime.operations, ['session.open:session-2', 'workspace.start:workspace-2'])
})

test('routes native controls without creating a second desktop state store', async () => {
  const runtime = environment()
  const commands: DesktopRendererCommand[] = [
    { type: 'session.new' },
    { type: 'session.stop', sessionId: 'session-1' },
    { type: 'settings.open', sectionId: 'connections' },
    { type: 'sidebar.toggle' },
  ]
  for (const command of commands) await runDesktopCommand(runtime.value, command)

  assert.deepEqual(runtime.operations, [
    'workspace.start:new',
    'session.cancel:session-1',
    'settings.open:connections',
    'layout.toggle',
  ])
})
