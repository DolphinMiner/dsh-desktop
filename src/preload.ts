import { contextBridge, ipcRenderer } from 'electron'

import { DesktopBridge, HarnessState } from './types'

const bridge: DesktopBridge = {
  getHarnessState: () => ipcRenderer.invoke('desktop:get-harness-state'),
  retryHarness: () => ipcRenderer.invoke('desktop:retry-harness'),
  showHarnessLog: () => ipcRenderer.invoke('desktop:show-harness-log'),
  onHarnessState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: HarnessState): void => listener(state)
    ipcRenderer.on('desktop:harness-state', handler)
    return () => ipcRenderer.removeListener('desktop:harness-state', handler)
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
