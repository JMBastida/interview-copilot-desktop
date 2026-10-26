import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
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

// Enable unthrottled WebGPU hardware acceleration in Chromium
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')

// 1. Register custom protocol 'copilot://'
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('copilot', process.execPath, [resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('copilot')
}

// Ensure single application instance
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let pendingCustomToken: string | null = null

function handleDeepLink(urlStr: string): void {
  try {
    console.log(`[Main] Deep link received: ${urlStr}`)
    const parsedUrl = new URL(urlStr)
    const token = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('customToken')
    if (token) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:custom-token', token)
      } else {
        pendingCustomToken = token
      }
    }
  } catch (err) {
    console.error('[Main] Failed to parse deep link URL:', err)
  }
}

// 2. macOS: Capture 'open-url' event without stealing focus
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

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

  // Auth token synchronization from Firebase in Renderer
  ipcMain.on('auth:sync-token', (_event, token: string) => {
    if (token) {
      setApiConfig({ authToken: token })
    }
  })

  // Log forwarding from Renderer to Terminal
  ipcMain.on('app:log', (_event, message: string) => {
    console.log(`[Renderer] ${message}`)
  })

  // Open detached DevTools
  ipcMain.on('app:open-devtools', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' })
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

  // Dispatch any pending auth deep link token once renderer is loaded
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingCustomToken && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:custom-token', pendingCustomToken)
      pendingCustomToken = null
    }
  })

  // Check if initial process argv contains a copilot:// deep link on cold launch (Windows/Linux)
  const initialDeepLink = process.argv.find((arg) => arg.startsWith('copilot://'))
  if (initialDeepLink) {
    handleDeepLink(initialDeepLink)
  }

  // Load renderer view
  if (process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Start background keep-alive heartbeat to maintain API warm
  startKeepAliveHeartbeat()
}

// Background keep-alive: pings backend /health every 10 min (Render sleeps at 15m)
let keepAliveTimer: NodeJS.Timeout | null = null

function startKeepAliveHeartbeat(): void {
  setTimeout(() => {
    checkApiHealth().catch(() => {})
  }, 3000)

  keepAliveTimer = setInterval(() => {
    console.log('[Main Keep-Alive] Pinging backend /health to keep instance warm...')
    checkApiHealth().catch((err) => {
      console.warn('[Main Keep-Alive] Ping failed:', err)
    })
  }, 10 * 60 * 1000)
}

app.whenReady().then(initializeApp)

// 3. Windows/Linux: Second instance handling (Stealth: DO NOT steal focus if it's a deep link)
app.on('second-instance', (_event, commandLine) => {
  const deepLink = commandLine.find((arg) => arg.startsWith('copilot://'))
  if (deepLink) {
    // Process deep link silently without altering active window focus
    handleDeepLink(deepLink)
    return
  }

  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.on('will-quit', () => {
  if (keepAliveTimer) clearInterval(keepAliveTimer)
  unregisterShortcuts()
  abortActiveStream()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
