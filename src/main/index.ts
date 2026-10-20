import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import {
  createStealthWindow,
  getStealthWindow,
  toggleWindowVisibility,
  toggleClickThrough,
  setWindowOpacity
} from './stealthWindow'
import { setupAudioLoopback } from './audioLoopback'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import {
  streamSolveRequest,
  abortActiveStream,
  setApiConfig,
  getApiConfig,
  checkApiHealth,
  SolvePayload,
  ApiClientConfig
} from './apiProxyClient'

// Ensure single application instance
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function setupIpcHandlers(): void {
  // Window management IPC
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('window:hide', () => {
    mainWindow?.hide()
  })

  ipcMain.on('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.on('window:toggle-visibility', () => {
    toggleWindowVisibility()
  })

  ipcMain.on('window:set-opacity', (_event, opacity: number) => {
    setWindowOpacity(opacity)
  })

  ipcMain.on('window:toggle-click-through', (_event, forceState?: boolean) => {
    toggleClickThrough(forceState)
  })

  // Copilot Solve and SSE Stream
  ipcMain.on('copilot:solve', async (_event, payload: SolvePayload) => {
    if (!mainWindow) return
    await streamSolveRequest(mainWindow, payload)
  })

  ipcMain.on('copilot:abort', () => {
    abortActiveStream()
  })

  // API Configuration & Health
  ipcMain.handle('api:get-config', () => {
    return getApiConfig()
  })

  ipcMain.handle('api:set-config', (_event, config: Partial<ApiClientConfig>) => {
    return setApiConfig(config)
  })

  ipcMain.handle('api:check-health', async (_event, customUrl?: string, customToken?: string) => {
    return await checkApiHealth(customUrl, customToken)
  })

  // System Diagnostics
  ipcMain.handle('system:get-info', () => {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      stealthActive: true, // setContentProtection is active
      isClickThrough: false
    }
  })
}

async function initializeApp(): Promise<void> {
  // Create the transparent, screen-capture-protected stealth window
  mainWindow = createStealthWindow()

  // Setup OS audio loopback capture handler
  setupAudioLoopback(mainWindow)

  // Register global hotkeys (Cmd+Shift+C, Cmd+Shift+Enter, etc.)
  registerShortcuts(mainWindow)

  // Register IPC communications
  setupIpcHandlers()

  // Load renderer view
  if (process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(initializeApp)

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.on('will-quit', () => {
  unregisterShortcuts()
  abortActiveStream()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
