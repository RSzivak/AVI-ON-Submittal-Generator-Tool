import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// ── Filesystem helpers ───────────────────────────────────────────────────────

const getDefaultSaveDir = () =>
  join(app.getPath('documents'), 'AVI-ON Projects')

const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.avion.submittal')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ── Filesystem IPC handlers ──────────────────────────────────────────────

  // Return the default save directory path
  ipcMain.handle('fs:defaultDir', () => getDefaultSaveDir())

  // Open a native folder picker and return the chosen path
  ipcMain.handle('fs:pickFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Project Save Location',
      defaultPath: getDefaultSaveDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Save a project JSON file to the chosen directory
  ipcMain.handle('fs:saveProject', (event, saveDir, id, data) => {
    const dir = saveDir || getDefaultSaveDir()
    ensureDir(dir)
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(data), 'utf8')
    return true
  })

  // Load a project JSON file
  ipcMain.handle('fs:loadProject', (event, saveDir, id) => {
    const dir = saveDir || getDefaultSaveDir()
    const filePath = join(dir, `${id}.json`)
    if (!existsSync(filePath)) throw new Error(`Project file not found: ${filePath}`)
    return JSON.parse(readFileSync(filePath, 'utf8'))
  })

  // Delete a project JSON file
  ipcMain.handle('fs:deleteProject', (event, saveDir, id) => {
    const dir = saveDir || getDefaultSaveDir()
    const filePath = join(dir, `${id}.json`)
    if (existsSync(filePath)) unlinkSync(filePath)
    return true
  })

  // Read a single spec sheet PDF from the configured spec sheet directory.
  // basename() strips any path components from the requested name so a crafted
  // filename can't escape the chosen directory.
  ipcMain.handle('fs:readSpecSheet', (event, specDir, name) => {
    if (!specDir) throw new Error('No spec sheet directory provided')
    const filePath = join(specDir, basename(name))
    if (!existsSync(filePath)) throw new Error(`Spec sheet not found: ${filePath}`)
    return readFileSync(filePath)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})