import { BrowserWindow } from 'electron'

export interface SolvePayload {
  spokenContext: string
  codeContext?: string
  history?: Array<{ role: 'user' | 'model'; parts: string }>
  authToken?: string
}

export interface ApiClientConfig {
  apiUrl: string
  authToken: string
}

let activeAbortController: AbortController | null = null

const defaultConfig: ApiClientConfig = {
  apiUrl: 'http://127.0.0.1:3000',
  authToken: 'super_secret_interview_copilot_token_2026'
}

let clientConfig: ApiClientConfig = { ...defaultConfig }

/**
 * Configure API URL and token
 */
export function setApiConfig(config: Partial<ApiClientConfig>): ApiClientConfig {
  clientConfig = { ...clientConfig, ...config }
  // Strip trailing slashes
  clientConfig.apiUrl = clientConfig.apiUrl.replace(/\/+$/, '')
  return clientConfig
}

export function getApiConfig(): ApiClientConfig {
  return { ...clientConfig }
}

/**
 * Check if the Proxy API server is reachable
 */
export async function checkApiHealth(customUrl?: string, customToken?: string): Promise<{ ok: boolean; latencyMs: number; status: string }> {
  const targetUrl = (customUrl || clientConfig.apiUrl).replace(/\/+$/, '')
  const token = customToken || clientConfig.authToken
  const startTime = Date.now()

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)

    const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`
    const response = await fetch(`${targetUrl}/health`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'x-copilot-token': token
      },
      signal: controller.signal
    })
    clearTimeout(timeout)
    const latencyMs = Date.now() - startTime

    if (response.ok) {
      return { ok: true, latencyMs, status: 'Connected' }
    } else {
      return { ok: false, latencyMs, status: `HTTP ${response.status}` }
    }
  } catch (err: any) {
    const latencyMs = Date.now() - startTime
    return { ok: false, latencyMs, status: err.name === 'AbortError' ? 'Timeout' : 'Offline' }
  }
}

/**
 * Stream a solve request from the Proxy API via SSE
 */
export async function streamSolveRequest(
  mainWindow: BrowserWindow,
  payload: SolvePayload
): Promise<void> {
  // Cancel any prior in-flight request
  if (activeAbortController) {
    activeAbortController.abort()
    activeAbortController = null
  }

  activeAbortController = new AbortController()
  const signal = activeAbortController.signal

  mainWindow.webContents.send('copilot:stream-start')

  const endpoint = `${clientConfig.apiUrl}/api/v1/solve`
  console.log(`[ApiProxyClient] Posting solve request to: ${endpoint}`)

  try {
    const activeToken = payload.authToken || clientConfig.authToken
    const authHeader = activeToken.startsWith('Bearer ') ? activeToken : `Bearer ${activeToken}`

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'x-copilot-token': activeToken,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        spokenContext: payload.spokenContext || '',
        codeContext: payload.codeContext || '',
        history: payload.history || []
      }),
      signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Proxy API returned status ${response.status}: ${errorText}`)
    }

    if (!response.body) {
      throw new Error('Response body is empty or streaming is not supported by endpoint.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // Retain incomplete trailing line in the buffer
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) {
          // Empty line or SSE comment/keep-alive
          continue
        }

        if (trimmed.startsWith('data:')) {
          const dataContent = trimmed.slice(5).trim()

          if (dataContent === '[DONE]') {
            mainWindow.webContents.send('copilot:stream-end')
            activeAbortController = null
            return
          }

          try {
            const parsed = JSON.parse(dataContent)
            if (parsed.text) {
              mainWindow.webContents.send('copilot:stream-chunk', parsed.text)
            } else if (parsed.content) {
              mainWindow.webContents.send('copilot:stream-chunk', parsed.content)
            } else if (parsed.delta) {
              mainWindow.webContents.send('copilot:stream-chunk', parsed.delta)
            } else if (parsed.error) {
              mainWindow.webContents.send('copilot:stream-error', parsed.error)
            }
          } catch {
            // Raw text line fallback
            mainWindow.webContents.send('copilot:stream-chunk', dataContent)
          }
        }
      }
    }

    mainWindow.webContents.send('copilot:stream-end')
    activeAbortController = null
  } catch (err: any) {
    if (signal.aborted) {
      console.log('[ApiProxyClient] Request aborted by user.')
      return
    }

    console.error('[ApiProxyClient] Stream error:', err)
    mainWindow.webContents.send('copilot:stream-error', err.message || 'Failed to stream response from Proxy API')
    activeAbortController = null
  }
}

/**
 * Cancel any ongoing streaming request
 */
export function abortActiveStream(): void {
  if (activeAbortController) {
    activeAbortController.abort()
    activeAbortController = null
  }
}
