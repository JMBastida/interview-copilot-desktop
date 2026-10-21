import { contextBridge, ipcRenderer } from 'electron'

export interface ClipboardData {
  text: string
  language: string
  timestamp: number
  charCount: number
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'model'
  content: string
}

export interface SolvePayload {
  spokenPrompt?: string
  spokenContext?: string
  codeContext?: string
  language?: string
  history?: ConversationTurn[]
  authToken?: string
}

export interface ApiClientConfig {
  apiUrl: string
  authToken: string
}

export interface SystemInfo {
  platform: string
  arch: string
  nodeVersion: string
  electronVersion: string
  chromeVersion: string
  stealthActive: boolean
  isClickThrough: boolean
}

const api = {
  // Auth & Deep Linking
  onCustomToken: (callback: (token: string) => void): (() => void) => {
    const handler = (_event: any, token: string) => callback(token)
    ipcRenderer.on('auth:custom-token', handler)
    return () => ipcRenderer.removeListener('auth:custom-token', handler)
  },

  syncAuthToken: (token: string): void => {
    ipcRenderer.send('auth:sync-token', token)
  },

  // Hotkey & Event Listeners
  onClipboardCaptured: (callback: (data: ClipboardData) => void): (() => void) => {
    const handler = (_event: any, data: ClipboardData) => callback(data)
    ipcRenderer.on('copilot:clipboard-captured', handler)
    return () => ipcRenderer.removeListener('copilot:clipboard-captured', handler)
  },

  onTriggerSolve: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('copilot:trigger-solve', handler)
    return () => ipcRenderer.removeListener('copilot:trigger-solve', handler)
  },

  onTriggerClear: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('copilot:trigger-clear', handler)
    return () => ipcRenderer.removeListener('copilot:trigger-clear', handler)
  },

  onStreamStart: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('copilot:stream-start', handler)
    return () => ipcRenderer.removeListener('copilot:stream-start', handler)
  },

  onStreamChunk: (callback: (chunk: string) => void): (() => void) => {
    const handler = (_event: any, chunk: string) => callback(chunk)
    ipcRenderer.on('copilot:stream-chunk', handler)
    return () => ipcRenderer.removeListener('copilot:stream-chunk', handler)
  },

  onStreamEnd: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('copilot:stream-end', handler)
    return () => ipcRenderer.removeListener('copilot:stream-end', handler)
  },

  onStreamError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: any, error: string) => callback(error)
    ipcRenderer.on('copilot:stream-error', handler)
    return () => ipcRenderer.removeListener('copilot:stream-error', handler)
  },

  onPassThroughChanged: (callback: (isPassThrough: boolean) => void): (() => void) => {
    const handler = (_event: any, isPassThrough: boolean) => callback(isPassThrough)
    ipcRenderer.on('copilot:passthrough-changed', handler)
    return () => ipcRenderer.removeListener('copilot:passthrough-changed', handler)
  },

  // Actions
  solve: (payload: SolvePayload): void => {
    ipcRenderer.send('copilot:solve', payload)
  },

  abortSolve: (): void => {
    ipcRenderer.send('copilot:abort')
  },

  // Configuration
  getApiConfig: (): Promise<ApiClientConfig> => {
    return ipcRenderer.invoke('api:get-config')
  },

  setApiConfig: (config: Partial<ApiClientConfig>): Promise<ApiClientConfig> => {
    return ipcRenderer.invoke('api:set-config', config)
  },

  checkApiHealth: (customUrl?: string, customToken?: string): Promise<{ ok: boolean; latencyMs: number; status: string }> => {
    return ipcRenderer.invoke('api:check-health', customUrl, customToken)
  },

  // Window & System
  getSystemInfo: (): Promise<SystemInfo> => {
    return ipcRenderer.invoke('system:get-info')
  },

  getLoopbackStatus: (): Promise<any> => {
    return ipcRenderer.invoke('audio:get-loopback-status')
  },

  minimizeWindow: (): void => {
    ipcRenderer.send('window:minimize')
  },

  hideWindow: (): void => {
    ipcRenderer.send('window:hide')
  },

  closeWindow: (): void => {
    ipcRenderer.send('window:close')
  },

  setWindowOpacity: (opacity: number): void => {
    ipcRenderer.send('window:set-opacity', opacity)
  },

  toggleClickThrough: (forceState?: boolean): void => {
    ipcRenderer.send('window:toggle-click-through', forceState)
  },

  log: (message: string): void => {
    ipcRenderer.send('app:log', message)
  },

  openDevTools: (): void => {
    ipcRenderer.send('app:open-devtools')
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
