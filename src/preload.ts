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
  computer: {
    getState: () => ipcRenderer.invoke('desktop:computer:get-state'),
    refresh: () => ipcRenderer.invoke('desktop:computer:refresh'),
    selectTarget: input => ipcRenderer.invoke('desktop:computer:select-target', input),
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
