import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi } from '../shared/types'

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_e: unknown, payload: T) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: BridgeApi = {
  getState: invoke('getState'),
  getStatus: invoke('getStatus'),
  getLogs: invoke('getLogs'),
  importText: invoke('importText'),
  importClipboard: invoke('importClipboard'),
  removeServer: invoke('removeServer'),
  selectServer: invoke('selectServer'),
  setServerEngine: invoke('setServerEngine'),
  addWarpServer: invoke('addWarpServer'),
  setWarpMethod: invoke('setWarpMethod'),
  findWarpConfigs: invoke('findWarpConfigs'),
  testLatency: invoke('testLatency'),
  addSubscription: invoke('addSubscription'),
  updateSubscription: invoke('updateSubscription'),
  removeSubscription: invoke('removeSubscription'),
  updateSettings: invoke('updateSettings'),
  saveAppRule: invoke('saveAppRule'),
  removeAppRule: invoke('removeAppRule'),
  listProcesses: invoke('listProcesses'),
  pickExe: invoke('pickExe'),
  connect: invoke('connect'),
  disconnect: invoke('disconnect'),
  checkHealth: invoke('checkHealth'),
  isAdmin: invoke('isAdmin'),
  relaunchAsAdmin: invoke('relaunchAsAdmin'),
  onState: subscribe('state'),
  onStatus: subscribe('status'),
  onStats: subscribe('stats'),
  onLogs: subscribe('logs'),
  getUpdate: invoke('getUpdate'),
  checkUpdate: invoke('checkUpdate'),
  installUpdate: invoke('installUpdate'),
  openUpdatePage: invoke('openUpdatePage'),
  onUpdate: subscribe('update')
} as BridgeApi

contextBridge.exposeInMainWorld('bridge', api)
