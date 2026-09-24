import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AudioFileDescriptor, SaveIndexPayload, SaveIndexResult } from '../shared/types'

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.aif',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.webm'
])

const createAudioDescriptor = async (filePath: string): Promise<AudioFileDescriptor> => {
  const info = await stat(filePath)
  const extension = extname(filePath).toLowerCase()

  return {
    id: `${filePath}:${info.mtimeMs}:${info.size}`,
    path: filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    name: basename(filePath),
    extension,
    size: info.size,
    lastModified: info.mtimeMs
  }
}

const collectAudioFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        return collectAudioFiles(fullPath)
      }
      return AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? [fullPath] : []
    })
  )

  return nested.flat()
}

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: '#101318',
    title: 'pIndex',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('audio:open-files', async (): Promise<AudioFileDescriptor[]> => {
  const result = await dialog.showOpenDialog({
    title: 'Add audio files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Audio files',
        extensions: [...AUDIO_EXTENSIONS].map((extension) => extension.slice(1))
      }
    ]
  })

  if (result.canceled) return []
  return Promise.all(result.filePaths.map(createAudioDescriptor))
})

ipcMain.handle('audio:open-folder', async (): Promise<AudioFileDescriptor[]> => {
  const result = await dialog.showOpenDialog({
    title: 'Add audio folder',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) return []
  const files = await collectAudioFiles(result.filePaths[0])
  return Promise.all(files.map(createAudioDescriptor))
})

ipcMain.handle('audio:read-file', async (_event, filePath: string): Promise<ArrayBuffer> => {
  const audioFile = await readFile(filePath)
  return audioFile.buffer.slice(audioFile.byteOffset, audioFile.byteOffset + audioFile.byteLength)
})

ipcMain.handle('audio:reveal-file', async (_event, filePath: string): Promise<void> => {
  shell.showItemInFolder(filePath)
})

ipcMain.handle('audio:open-external', async (_event, filePath: string): Promise<string> => {
  return shell.openPath(filePath)
})

ipcMain.handle('index:save', async (_event, payload: SaveIndexPayload): Promise<SaveIndexResult> => {
  const result = await dialog.showSaveDialog({
    title: 'Save pIndex segment index',
    defaultPath: payload.defaultPath,
    filters: [{ name: 'pIndex JSON', extensions: ['json'] }]
  })

  if (result.canceled || !result.filePath) return { canceled: true }

  await writeFile(result.filePath, `${JSON.stringify(payload.contents, null, 2)}\n`, 'utf8')
  return { canceled: false, filePath: result.filePath }
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
