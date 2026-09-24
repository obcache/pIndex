import { contextBridge, ipcRenderer } from 'electron'
import type { AudioFileDescriptor, SaveIndexPayload, SaveIndexResult } from '../shared/types'

const api = {
  openAudioFiles: (): Promise<AudioFileDescriptor[]> => ipcRenderer.invoke('audio:open-files'),
  openAudioFolder: (): Promise<AudioFileDescriptor[]> => ipcRenderer.invoke('audio:open-folder'),
  readAudioFile: (filePath: string): Promise<ArrayBuffer> => ipcRenderer.invoke('audio:read-file', filePath),
  revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke('audio:reveal-file', filePath),
  openExternal: (filePath: string): Promise<string> => ipcRenderer.invoke('audio:open-external', filePath),
  saveIndex: (payload: SaveIndexPayload): Promise<SaveIndexResult> => ipcRenderer.invoke('index:save', payload)
}

contextBridge.exposeInMainWorld('pindex', api)

export type PIndexApi = typeof api
