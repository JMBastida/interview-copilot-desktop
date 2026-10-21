import { session, desktopCapturer, ipcMain, BrowserWindow, systemPreferences } from 'electron'

/**
 * Configures native Chromium display media request handler for OS audio loopback.
 * Captures system/speaker output audio (interviewer voice) without capturing user mic.
 * - On Windows: Uses WASAPI Loopback on active playback endpoint.
 * - On macOS (13.2+): Uses ScreenCaptureKit system audio loopback.
 */
export function setupAudioLoopback(mainWindow: BrowserWindow): void {
  // Allow display-capture and media permissions for the session
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'display-capture' || permission === 'media') {
      callback(true)
      return
    }
    callback(true)
  })

  session.defaultSession.setPermissionCheckHandler(() => {
    return true
  })

  // Intercept navigator.mediaDevices.getDisplayMedia requests from renderer
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          console.warn('[AudioLoopback] No screen sources found for loopback capture. Screen recording permission might be missing.')
          // Pass null to cleanly cancel the display media request without TypeError
          ;(callback as any)(null)
          return
        }

        const primarySource = sources[0]
        console.log(`[AudioLoopback] Binding loopback audio capture to screen: ${primarySource.name} (${primarySource.id})`)

        // Requesting audio: 'loopback' gives native system output audio only.
        // User's microphone is completely omitted.
        callback({
          video: primarySource,
          audio: 'loopback'
        })
      })
      .catch((err) => {
        console.error('[AudioLoopback] Error obtaining screen sources:', err)
        ;(callback as any)(null)
      })
  })

  // IPC handler to query loopback audio status
  ipcMain.handle('audio:get-loopback-status', async () => {
    try {
      const screenAccess = process.platform === 'darwin'
        ? (systemPreferences.getMediaAccessStatus ? systemPreferences.getMediaAccessStatus('screen') : 'unknown')
        : 'granted'
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      return {
        supported: true,
        platform: process.platform,
        screenAccess,
        screensFound: sources.length,
        primaryScreen: sources[0]?.name ?? 'Unknown',
        timestamp: Date.now()
      }
    } catch (err: any) {
      return {
        supported: false,
        platform: process.platform,
        error: err.message
      }
    }
  })
}
