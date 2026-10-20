import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'

export interface StealthWindowOptions {
  width?: number
  height?: number
  opacity?: number
}

let stealthWindow: BrowserWindow | null = null
let isClickThrough = false

/**
 * Creates and configures the stealth HUD overlay window.
 * Configured with:
 * - setContentProtection(true): completely hidden from Zoom, Teams, Meet, Slack, OBS screen captures.
 * - alwaysOnTop: floats above full-screen IDEs and browser windows.
 * - transparent & frameless: clean glassmorphism overlay.
 * - skipTaskbar: excluded from OS taskbar and Dock.
 */
export function createStealthWindow(options: StealthWindowOptions = {}): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  const initialWidth = options.width ?? 480
  const initialHeight = options.height ?? 700

  // Position on the top-right by default
  const initialX = screenWidth - initialWidth - 24
  const initialY = 48

  stealthWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: initialX,
    y: initialY,
    minWidth: 380,
    minHeight: 450,
    maxWidth: 800,
    maxHeight: 1200,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false // Keep STT and audio processing active even when window is not focused
    }
  })

  // 1. Enable Screen Capture Protection (Stealth core requirement)
  // On Windows (WDA_EXCLUDEFROMCAPTURE) and macOS (NSWindowSharingNone),
  // this prevents the window from being recorded or shared in video meetings.
  stealthWindow.setContentProtection(true)

  // 2. Float above all apps (including full screen IDEs/keynotes)
  stealthWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  stealthWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // 3. Graceful reveal when ready
  stealthWindow.once('ready-to-show', () => {
    if (stealthWindow) {
      stealthWindow.show()
    }
  })

  stealthWindow.on('closed', () => {
    stealthWindow = null
  })

  return stealthWindow
}

/**
 * Returns the active stealth window instance
 */
export function getStealthWindow(): BrowserWindow | null {
  return stealthWindow
}

/**
 * Toggle visibility (Show / Hide)
 */
export function toggleWindowVisibility(): boolean {
  if (!stealthWindow) return false

  if (stealthWindow.isVisible()) {
    stealthWindow.hide()
    return false
  } else {
    stealthWindow.show()
    stealthWindow.focus()
    return true
  }
}

/**
 * Toggle click-through mode (ignore mouse events so user can click underlying IDE)
 */
export function toggleClickThrough(forceState?: boolean): boolean {
  if (!stealthWindow) return false

  isClickThrough = forceState !== undefined ? forceState : !isClickThrough
  stealthWindow.setIgnoreMouseEvents(isClickThrough, { forward: true })
  stealthWindow.webContents.send('copilot:passthrough-changed', isClickThrough)
  return isClickThrough
}

/**
 * Set window opacity
 */
export function setWindowOpacity(opacity: number): void {
  if (!stealthWindow) return
  const clamped = Math.max(0.15, Math.min(1.0, opacity))
  stealthWindow.setOpacity(clamped)
}

/**
 * Snap window to corners of the active screen
 */
export function snapWindow(position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center'): void {
  if (!stealthWindow) return

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight, x: screenX, y: screenY } = primaryDisplay.workArea
  const [w, h] = stealthWindow.getSize()

  const margin = 24
  let targetX = screenX + screenWidth - w - margin
  let targetY = screenY + margin

  switch (position) {
    case 'top-left':
      targetX = screenX + margin
      targetY = screenY + margin
      break
    case 'top-right':
      targetX = screenX + screenWidth - w - margin
      targetY = screenY + margin
      break
    case 'bottom-left':
      targetX = screenX + margin
      targetY = screenY + screenHeight - h - margin
      break
    case 'bottom-right':
      targetX = screenX + screenWidth - w - margin
      targetY = screenY + screenHeight - h - margin
      break
    case 'center':
      targetX = screenX + Math.round((screenWidth - w) / 2)
      targetY = screenY + Math.round((screenHeight - h) / 2)
      break
  }

  stealthWindow.setPosition(targetX, targetY, true)
}
