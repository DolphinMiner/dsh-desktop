import { contextBridge, ipcRenderer } from 'electron'

import { DesktopBridge, HarnessState } from './types'

const commandListeners = new Set<Parameters<DesktopBridge['onCommand']>[0]>()
const pendingCommands: Parameters<DesktopBridge['onCommand']>[0] extends (command: infer C) => void ? C[] : never = []

ipcRenderer.on('desktop:command', (_event, command) => {
  if (commandListeners.size === 0) {
    if (pendingCommands.length === 32) pendingCommands.shift()
    pendingCommands.push(command)
    return
  }
  for (const listener of commandListeners) listener(command)
})

const bridge: DesktopBridge = {
  getHarnessState: () => ipcRenderer.invoke('desktop:get-harness-state'),
  retryHarness: () => ipcRenderer.invoke('desktop:retry-harness'),
  showHarnessLog: () => ipcRenderer.invoke('desktop:show-harness-log'),
  pickProjectDirectory: () => ipcRenderer.invoke('desktop:pick-project-directory'),
  onHarnessState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: HarnessState): void => listener(state)
    ipcRenderer.on('desktop:harness-state', handler)
    return () => ipcRenderer.removeListener('desktop:harness-state', handler)
  },
  onCommand(listener) {
    commandListeners.add(listener)
    for (const command of pendingCommands.splice(0)) listener(command)
    return () => { commandListeners.delete(listener) }
  },
  appSnapshots: {
    getState: () => ipcRenderer.invoke('desktop:app-snapshots:get-state'),
    refresh: () => ipcRenderer.invoke('desktop:app-snapshots:refresh'),
    update: input => ipcRenderer.invoke('desktop:app-snapshots:update', input),
    capture: () => ipcRenderer.invoke('desktop:app-snapshots:capture'),
    openScreenRecordingSettings: () => ipcRenderer.invoke('desktop:app-snapshots:open-screen-recording-settings'),
    onChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => {
        listener(state)
      }
      ipcRenderer.on('desktop:app-snapshots:changed', handler)
      return () => ipcRenderer.removeListener('desktop:app-snapshots:changed', handler)
    },
    onCaptured(listener) {
      const handler = (_event: Electron.IpcRendererEvent, capture: Parameters<typeof listener>[0]): void => {
        listener(capture)
      }
      ipcRenderer.on('desktop:app-snapshots:captured', handler)
      return () => ipcRenderer.removeListener('desktop:app-snapshots:captured', handler)
    },
    onError(listener) {
      const handler = (_event: Electron.IpcRendererEvent, notice: Parameters<typeof listener>[0]): void => {
        listener(notice)
      }
      ipcRenderer.on('desktop:app-snapshots:error', handler)
      return () => ipcRenderer.removeListener('desktop:app-snapshots:error', handler)
    },
  },
  browser: {
    getState: () => ipcRenderer.invoke('desktop:browser:get-state'),
    update: input => ipcRenderer.invoke('desktop:browser:update', input),
    navigate: input => ipcRenderer.invoke('desktop:browser:navigate', input),
    activateTab: input => ipcRenderer.invoke('desktop:browser:activate-tab', input),
    pointer: input => ipcRenderer.invoke('desktop:browser:pointer', input),
    scrollAt: input => ipcRenderer.invoke('desktop:browser:scroll-at', input),
    newTab: () => ipcRenderer.invoke('desktop:browser:new-tab'),
    closeTab: input => ipcRenderer.invoke('desktop:browser:close-tab', input),
    back: () => ipcRenderer.invoke('desktop:browser:back'),
    forward: () => ipcRenderer.invoke('desktop:browser:forward'),
    reload: () => ipcRenderer.invoke('desktop:browser:reload'),
    refreshFrame: () => ipcRenderer.invoke('desktop:browser:refresh-frame'),
    stop: () => ipcRenderer.invoke('desktop:browser:stop'),
    listHistory: () => ipcRenderer.invoke('desktop:browser:list-history'),
    clearHistory: () => ipcRenderer.invoke('desktop:browser:clear-history'),
    clearData: () => ipcRenderer.invoke('desktop:browser:clear-data'),
    onChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => {
        listener(state)
      }
      ipcRenderer.on('desktop:browser-changed', handler)
      return () => ipcRenderer.removeListener('desktop:browser-changed', handler)
    },
    onFrame(listener) {
      const handler = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]): void => {
        listener(frame)
      }
      ipcRenderer.on('desktop:browser-frame', handler)
      return () => ipcRenderer.removeListener('desktop:browser-frame', handler)
    },
  },
  git: {
    review: input => ipcRenderer.invoke('desktop:git:review', input),
    mutateIndex: input => ipcRenderer.invoke('desktop:git:index:mutate', input),
    previewCommit: input => ipcRenderer.invoke('desktop:git:commit:preview', input),
    confirmCommit: input => ipcRenderer.invoke('desktop:git:commit:confirm', input),
    previewRevert: input => ipcRenderer.invoke('desktop:git:revert:preview', input),
    confirmRevert: input => ipcRenderer.invoke('desktop:git:revert:confirm', input),
    previewPush: input => ipcRenderer.invoke('desktop:git:push:preview', input),
    confirmPush: input => ipcRenderer.invoke('desktop:git:push:confirm', input),
    comments: {
      list: input => ipcRenderer.invoke('desktop:git:comments:list', input),
      add: input => ipcRenderer.invoke('desktop:git:comments:add', input),
      remove: input => ipcRenderer.invoke('desktop:git:comments:remove', input),
      onChanged(listener) {
        const handler = (_event: Electron.IpcRendererEvent, change: Parameters<typeof listener>[0]): void => {
          listener(change)
        }
        ipcRenderer.on('desktop:git:comments:changed', handler)
        return () => ipcRenderer.removeListener('desktop:git:comments:changed', handler)
      },
    },
  },
  worktrees: {
    list: () => ipcRenderer.invoke('desktop:worktrees:list'),
    reconcile: () => ipcRenderer.invoke('desktop:worktrees:reconcile'),
    previewCleanup: input => ipcRenderer.invoke('desktop:worktrees:cleanup:preview', input),
    confirmCleanup: input => ipcRenderer.invoke('desktop:worktrees:cleanup:confirm', input),
    previewRecovery: input => ipcRenderer.invoke('desktop:worktrees:recovery:preview', input),
    confirmRecovery: input => ipcRenderer.invoke('desktop:worktrees:recovery:confirm', input),
    previewHandoff: input => ipcRenderer.invoke('desktop:worktrees:handoff:preview', input),
    confirmHandoff: input => ipcRenderer.invoke('desktop:worktrees:handoff:confirm', input),
    onChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => {
        listener(snapshot)
      }
      ipcRenderer.on('desktop:worktrees:changed', handler)
      return () => ipcRenderer.removeListener('desktop:worktrees:changed', handler)
    },
  },
  computer: {
    getState: () => ipcRenderer.invoke('desktop:computer:get-state'),
    refresh: () => ipcRenderer.invoke('desktop:computer:refresh'),
    updatePolicy: input => ipcRenderer.invoke('desktop:computer:update-policy', input),
    pauseActions: () => ipcRenderer.invoke('desktop:computer:pause-actions'),
    resumeActions: () => ipcRenderer.invoke('desktop:computer:resume-actions'),
    stop: () => ipcRenderer.invoke('desktop:computer:stop'),
    openPermissionSettings: kind => ipcRenderer.invoke('desktop:computer:open-permission-settings', kind),
    onChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => {
        listener(snapshot)
      }
      ipcRenderer.on('desktop:computer-changed', handler)
      return () => ipcRenderer.removeListener('desktop:computer-changed', handler)
    },
  },
  automations: {
    list: () => ipcRenderer.invoke('desktop:automations:list'),
    listRuns: input => ipcRenderer.invoke('desktop:automations:list-runs', input),
    create: input => ipcRenderer.invoke('desktop:automations:create', input),
    setState: input => ipcRenderer.invoke('desktop:automations:set-state', input),
    delete: input => ipcRenderer.invoke('desktop:automations:delete', input),
    queueRun: input => ipcRenderer.invoke('desktop:automations:queue-run', input),
    cancelRun: input => ipcRenderer.invoke('desktop:automations:cancel-run', input),
    openSession: input => ipcRenderer.invoke('desktop:automations:open-session', input),
    onChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, notice: Parameters<typeof listener>[0]): void => {
        listener(notice)
      }
      ipcRenderer.on('desktop:automations-changed', handler)
      return () => ipcRenderer.removeListener('desktop:automations-changed', handler)
    },
  },
  connections: {
    list: () => ipcRenderer.invoke('desktop:connections:list'),
    connectApiKey: input => ipcRenderer.invoke('desktop:connections:connect-api-key', input),
    disconnect: input => ipcRenderer.invoke('desktop:connections:disconnect', input),
    beginOAuth: input => ipcRenderer.invoke('desktop:connections:begin-oauth', input),
    cancelOAuth: input => ipcRenderer.invoke('desktop:connections:cancel-oauth', input),
    onChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]): void => {
        listener(snapshot)
      }
      ipcRenderer.on('desktop:connections-changed', handler)
      return () => ipcRenderer.removeListener('desktop:connections-changed', handler)
    },
    onOAuthResult(listener) {
      const handler = (_event: Electron.IpcRendererEvent, result: Parameters<typeof listener>[0]): void => {
        listener(result)
      }
      ipcRenderer.on('desktop:oauth-result', handler)
      return () => ipcRenderer.removeListener('desktop:oauth-result', handler)
    },
  },
}

contextBridge.exposeInMainWorld('dshDesktop', bridge)
