import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

// Filesystem bridge — exposes safe IPC calls to the React app as window.electronFS
const electronFS = {
  defaultDir:    ()               => ipcRenderer.invoke('fs:defaultDir'),
  pickFolder:    ()               => ipcRenderer.invoke('fs:pickFolder'),
  saveProject:   (dir, id, data)  => ipcRenderer.invoke('fs:saveProject', dir, id, data),
  loadProject:   (dir, id)        => ipcRenderer.invoke('fs:loadProject', dir, id),
  deleteProject: (dir, id)        => ipcRenderer.invoke('fs:deleteProject', dir, id),
  readSpecSheet: (dir, name)      => ipcRenderer.invoke('fs:readSpecSheet', dir, name),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('electronFS', electronFS)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
  window.electronFS = electronFS
}
