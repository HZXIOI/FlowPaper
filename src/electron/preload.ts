import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  selectVideo: () => Promise<string | null>
  selectWallpaperFolder: () => Promise<string | null>
  getDefaultFolder: () => Promise<string>
  ensureFolder: (folderPath: string) => Promise<{ success: boolean; folderPath?: string; message?: string }>
  getVideosFromFolder: (folderPath: string) => Promise<VideoItem[]>
  importVideo: (options: { sourcePath: string; folderPath?: string }) => Promise<{ success: boolean; item?: VideoItem; message?: string }>
  applyWallpaper: (options: ApplyOptions) => Promise<{ success: boolean; message: string }>
  restoreDefault: () => Promise<{ success: boolean; message: string }>
  openFolder: (folderPath: string) => Promise<void>
  onProgress: (callback: (message: string) => void) => () => void
}

export interface VideoItem {
  name: string
  path: string
  size: number
  modified: number
}

export interface ApplyOptions {
  videoPath: string
  opacity: number
  traPath?: string
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

const api: ElectronAPI = {
  selectVideo: () => ipcRenderer.invoke('select-video'),
  selectWallpaperFolder: () => ipcRenderer.invoke('select-wallpaper-folder'),
  getDefaultFolder: () => ipcRenderer.invoke('get-default-folder'),
  ensureFolder: (folderPath: string) => ipcRenderer.invoke('ensure-folder', folderPath),
  getVideosFromFolder: (folderPath: string) => ipcRenderer.invoke('get-videos-from-folder', folderPath),
  importVideo: (options: { sourcePath: string; folderPath?: string }) => ipcRenderer.invoke('import-video', options),
  applyWallpaper: (options: ApplyOptions) => ipcRenderer.invoke('apply-wallpaper', options),
  restoreDefault: () => ipcRenderer.invoke('restore-default'),
  openFolder: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),
  onProgress: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('progress', handler)
    return () => ipcRenderer.removeListener('progress', handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
