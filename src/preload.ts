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
}

contextBridge.exposeInMainWorld('dshDesktop', bridge)
