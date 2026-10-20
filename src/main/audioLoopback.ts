import { session, desktopCapturer, ipcMain, BrowserWindow } from 'electron'

/**
 * Configures native Chromium display media request handler for OS audio loopback.
 * Captures system/speaker output audio (interviewer voice) without capturing user mic.
 * - On Windows: Uses WASAPI Loopback on active playback endpoint.
 * - On macOS (13.2+): Uses ScreenCaptureKit system audio loopback.
 */
export function setupAudioLoopback(mainWindow: BrowserWindow): void {
  // Intercept navigator.mediaDevices.getDisplayMedia requests from renderer
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          console.warn('[AudioLoopback] No screen sources found for loopback capture.')
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
      })
  })

  // IPC handler to query loopback audio status
  ipcMain.handle('audio:get-loopback-status', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      return {
        supported: true,
        platform: process.platform,
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
