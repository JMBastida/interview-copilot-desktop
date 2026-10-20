import { globalShortcut, clipboard, BrowserWindow } from 'electron'
import { toggleWindowVisibility, toggleClickThrough, snapWindow } from './stealthWindow'

/**
 * Heuristic detector for snippet programming language
 */
function detectLanguage(code: string): string {
  const trimmed = code.trim()
  if (trimmed.includes('public class') || trimmed.includes('public static void main') || trimmed.includes('System.out.println') || trimmed.includes('import java.')) {
    return 'java'
  }
  if (trimmed.includes('def ') || trimmed.includes('class ') && trimmed.includes(':') || trimmed.includes('import numpy') || trimmed.includes('__init__')) {
    return 'python'
  }
  if (trimmed.includes('#include <') || trimmed.includes('std::') || trimmed.includes('cout <<')) {
    return 'cpp'
  }
  if (trimmed.includes('SELECT ') || trimmed.includes('FROM ') || trimmed.includes('WHERE ') || trimmed.includes('GROUP BY ')) {
    return 'sql'
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}') || trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // not json
    }
  }
  if (trimmed.includes('interface ') || trimmed.includes('function ') || trimmed.includes('const ') || trimmed.includes('import React')) {
    return 'typescript'
  }
  return 'plaintext'
}

/**
 * Register global shortcuts for stealth operation without stealing window focus
 */
export function registerShortcuts(mainWindow: BrowserWindow): void {
  // 1. Silent Clipboard Capture: Command/Control + Shift + C
  const clipRegistered = globalShortcut.register('CommandOrControl+Shift+C', () => {
    const text = clipboard.readText()
    if (!text || text.trim().length === 0) {
      console.log('[Shortcuts] Clipboard is empty or contains non-text content.')
      return
    }

    const detectedLang = detectLanguage(text)
    console.log(`[Shortcuts] Captured clipboard text (${text.length} chars, detected: ${detectedLang})`)

    mainWindow.webContents.send('copilot:clipboard-captured', {
      text,
      language: detectedLang,
      timestamp: Date.now(),
      charCount: text.length
    })
  })

  if (!clipRegistered) {
    console.warn('[Shortcuts] Failed to register CommandOrControl+Shift+C')
  }

  // 2. Trigger Solve: Command/Control + Shift + Enter
  globalShortcut.register('CommandOrControl+Shift+Enter', () => {
    console.log('[Shortcuts] Trigger Solve hotkey fired.')
    mainWindow.webContents.send('copilot:trigger-solve')
  })

  // Also support CommandOrControl+Shift+S as an alternative Solve hotkey
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    console.log('[Shortcuts] Trigger Solve hotkey (Shift+S) fired.')
    mainWindow.webContents.send('copilot:trigger-solve')
  })

  // 3. Clear Context & Answer: Command/Control + Shift + X
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    console.log('[Shortcuts] Clear context hotkey fired.')
    mainWindow.webContents.send('copilot:trigger-clear')
  })

  // 4. Instant Stealth Toggle (Hide/Show): Command/Control + Shift + H
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleWindowVisibility()
  })

  // 5. Toggle Mouse Pass-Through (Click-Through): Command/Control + Shift + M
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    toggleClickThrough()
  })

  // 6. Snap Window to Screen Corners
  globalShortcut.register('CommandOrControl+Shift+Right', () => {
    snapWindow('top-right')
  })
  globalShortcut.register('CommandOrControl+Shift+Left', () => {
    snapWindow('top-left')
  })
  globalShortcut.register('CommandOrControl+Shift+Down', () => {
    snapWindow('bottom-right')
  })
  globalShortcut.register('CommandOrControl+Shift+Up', () => {
    snapWindow('center')
  })
}

/**
 * Unregister all global shortcuts upon app exit
 */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
