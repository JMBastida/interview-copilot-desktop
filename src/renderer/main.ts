import { marked } from 'marked'
import hljs from 'highlight.js'
import { AudioRingBuffer } from './audio/ringBuffer'
import {
  initializeAuthBridge,
  getValidAuthToken,
  onAuthStatusChanged,
  logoutUser,
  auth
} from './auth'
import { signInWithCustomToken } from 'firebase/auth'

// --- State Variables ---
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
const ringBuffer = new AudioRingBuffer(16000, 60)
let sttWorker: Worker | null = null
let activeSttLabel = 'STT: Ready'
let isAudioActive = false
let isSolving = false
let streamedResponseText = ''
let currentClipboardText = ''
let currentClipboardLanguage = 'Java'
let currentSpokenTranscript = ''
let isPassThrough = false

// --- Multi-Turn Interview State ---
export interface CompletedTurn {
  turnNumber: number
  spokenPrompt: string
  codeContext: string
  language: string
  solutionMarkdown: string
  timestamp: number
}

let completedTurns: CompletedTurn[] = []
let activeTurnNumber = 1
let viewingTurnNumber = 1
let inFlightTurnPrompt = ''
let inFlightTurnCode = ''
let inFlightTurnLanguage = 'Java'

// --- DOM Element References ---
const btnPassthrough = document.getElementById('btn-passthrough') as HTMLButtonElement
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement
const btnMinimize = document.getElementById('btn-minimize') as HTMLButtonElement
const btnClose = document.getElementById('btn-close') as HTMLButtonElement

const chipAudio = document.getElementById('chip-audio') as HTMLDivElement
const labelAudio = document.getElementById('label-audio') as HTMLSpanElement
const vuMeter = document.getElementById('vu-meter') as HTMLDivElement

const chipStt = document.getElementById('chip-stt') as HTMLDivElement
const labelStt = document.getElementById('label-stt') as HTMLSpanElement

const chipProxy = document.getElementById('chip-proxy') as HTMLDivElement
const labelProxy = document.getElementById('label-proxy') as HTMLSpanElement

const chipAuth = document.getElementById('chip-auth') as HTMLDivElement
const labelAuth = document.getElementById('label-auth') as HTMLSpanElement

const btnStartAudio = document.getElementById('btn-start-audio') as HTMLButtonElement
const btnClearTranscript = document.getElementById('btn-clear-transcript') as HTMLButtonElement
const transcriptBox = document.getElementById('transcript-box') as HTMLDivElement

const btnCaptureClipboard = document.getElementById('btn-capture-clipboard') as HTMLButtonElement
const btnClearCode = document.getElementById('btn-clear-code') as HTMLButtonElement
const codeBox = document.getElementById('code-box') as HTMLElement
const codeLangBadge = document.getElementById('code-lang-badge') as HTMLSpanElement

const btnDevTools = document.getElementById('btn-devtools') as HTMLButtonElement
const btnToggleLogs = document.getElementById('btn-toggle-logs') as HTMLButtonElement
const btnCopyLogs = document.getElementById('btn-copy-logs') as HTMLButtonElement
const debugLogBox = document.getElementById('debug-log-box') as HTMLDivElement
const debugLogEntries = document.getElementById('debug-log-entries') as HTMLDivElement

const debugLogs: string[] = []

function addDebugLog(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  const time = new Date().toLocaleTimeString()
  const formatted = `[${time}] ${msg}`
  debugLogs.push(formatted)
  if (debugLogs.length > 50) debugLogs.shift()

  // Forward to terminal via Electron IPC
  try {
    window.electronAPI.log(msg)
  } catch {}

  // Render on HUD UI
  if (debugLogEntries) {
    const item = document.createElement('div')
    item.className = `debug-log-item ${level}`
    item.textContent = formatted
    debugLogEntries.appendChild(item)
    while (debugLogEntries.children.length > 50) {
      debugLogEntries.removeChild(debugLogEntries.firstChild!)
    }
    debugLogEntries.scrollTop = debugLogEntries.scrollHeight
  }
}

/**
 * Normalizes Float32Array audio amplitude so Whisper receives clear spectrogram features
 * even when the source (Spotify/video) is playing at low or moderate system volume.
 */
function normalizeAudio(samples: Float32Array): Float32Array {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i])
    if (abs > max) max = abs
  }

  // Noise gate: if peak is below 0.005, do not amplify ambient digital noise/hiss
  if (max < 0.005) {
    return samples
  }

  if (max < 0.7) {
    const scale = 0.8 / max
    const normalized = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      normalized[i] = samples[i] * scale
    }
    return normalized
  }

  return samples
}

const solutionContainer = document.getElementById('solution-container') as HTMLDivElement
const solutionStatus = document.getElementById('solution-status') as HTMLSpanElement
const btnCopySolution = document.getElementById('btn-copy-solution') as HTMLButtonElement
const btnSolve = document.getElementById('btn-solve') as HTMLButtonElement
const btnClearAll = document.getElementById('btn-clear-all') as HTMLButtonElement
const turnBadge = document.getElementById('turn-badge') as HTMLSpanElement
const solutionTurnsNav = document.getElementById('solution-turns-nav') as HTMLDivElement
const btnNewTopic = document.getElementById('btn-new-topic') as HTMLButtonElement

// Settings Modal DOM
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement
const btnCloseSettings = document.getElementById('btn-close-settings') as HTMLButtonElement
const inputApiUrl = document.getElementById('input-api-url') as HTMLInputElement
const inputApiToken = document.getElementById('input-api-token') as HTMLInputElement
const inputCustomToken = document.getElementById('input-custom-token') as HTMLInputElement
const btnApplyToken = document.getElementById('btn-apply-token') as HTMLButtonElement
const authUserInfo = document.getElementById('auth-user-info') as HTMLDivElement
const selectWhisperModel = document.getElementById('select-whisper-model') as HTMLSelectElement
const checkAutoDownloadModel = document.getElementById('check-auto-download-model') as HTMLInputElement | null
const inputOpacity = document.getElementById('input-opacity') as HTMLInputElement
const opacityVal = document.getElementById('opacity-val') as HTMLSpanElement
const btnSaveSettings = document.getElementById('btn-save-settings') as HTMLButtonElement

// --- LocalStorage Keys & Helpers for STT Preferences ---
const STORAGE_KEY_WHISPER_MODEL = 'copilot_whisper_model'
const STORAGE_KEY_AUTO_DOWNLOAD = 'copilot_whisper_autodownload'

function getSavedWhisperModel(): string {
  return localStorage.getItem(STORAGE_KEY_WHISPER_MODEL) || 'onnx-community/whisper-tiny.en'
}

function getIsAutoDownloadEnabled(): boolean {
  const val = localStorage.getItem(STORAGE_KEY_AUTO_DOWNLOAD)
  return val === null ? true : val === 'true'
}

// --- Audio Loopback & Ring Buffer Capture ---
async function startAudioCapture(): Promise<void> {
  if (isAudioActive) {
    stopAudioCapture()
    return
  }

  try {
    btnStartAudio.textContent = 'Connecting...'
    // Intercepted by Electron's setDisplayMediaRequestHandler in main process
    // which grants OS audio loopback (WASAPI / ScreenCaptureKit)
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    })

    // Immediately stop video tracks to save 100% video processing
    mediaStream.getVideoTracks().forEach((track) => track.stop())

    const audioTrack = mediaStream.getAudioTracks()[0]
    if (!audioTrack) {
      throw new Error('No system audio track provided by loopback handler.')
    }

    audioContext = new AudioContext({ sampleRate: 16000 })
    const sourceNode = audioContext.createMediaStreamSource(new MediaStream([audioTrack]))

    // Use ScriptProcessorNode to tap 16kHz PCM Float32 audio samples
    const processor = audioContext.createScriptProcessor(4096, 1, 1)

    processor.onaudioprocess = (e) => {
      const channelData = e.inputBuffer.getChannelData(0)
      ringBuffer.write(channelData)
    }

    const gainNode = audioContext.createGain()
    gainNode.gain.value = 0 // Mute monitor output to prevent loopback feedback
    sourceNode.connect(processor)
    processor.connect(gainNode)
    gainNode.connect(audioContext.destination)

    isAudioActive = true
    btnStartAudio.textContent = 'Stop Audio'
    chipAudio.className = 'chip active'
    labelAudio.textContent = 'Audio: Capturing Loopback'

    startVuMeterLoop()
    startSttPollingLoop()

    // Ensure STT model is loaded on demand if auto-download on launch was disabled
    if (sttWorker) {
      const savedModel = getSavedWhisperModel()
      const targetModel = savedModel === 'auto' ? undefined : savedModel
      sttWorker.postMessage({ type: 'init', model: targetModel })
    }

    audioTrack.onended = () => {
      stopAudioCapture()
    }
  } catch (err: any) {
    console.error('Audio capture error:', err)
    btnStartAudio.textContent = 'Capture Output Audio'
    chipAudio.className = 'chip error'
    labelAudio.textContent = 'Audio: Failed/Denied'

    try {
      const status = await window.electronAPI.getLoopbackStatus()
      if (status?.platform === 'darwin' && status?.screenAccess !== 'granted') {
        alert(
          'macOS Screen & Audio Permission Required:\n\n' +
            '1. Open System Settings → Privacy & Security → Screen & System Audio Recording (or Screen Recording).\n' +
            '2. Find "Electron" in the list and turn its toggle ON.\n' +
            '3. Click "Quit & Reopen" when prompted (or restart "npm run dev").\n\n' +
            '(Note: In dev mode, the app runs under the "Electron" binary. Once packaged into an installer, it will show as your application name).'
        )
        return
      }
    } catch {
      // ignore status probe fallback
    }

    alert(`System audio capture could not start: ${err.message || 'Permission denied'}`)
  }
}

function stopAudioCapture(): void {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  isAudioActive = false
  isTranscribing = false
  btnStartAudio.textContent = 'Capture Output Audio'
  chipAudio.className = 'chip'
  labelAudio.textContent = 'Audio: Inactive'
  vuMeter.style.width = '0%'
}

// VU Meter animation loop
function startVuMeterLoop(): void {
  if (!isAudioActive) return

  const energy = ringBuffer.getEnergy()
  const percent = Math.min(100, Math.round(energy * 100))
  vuMeter.style.width = `${percent}%`

  if (ringBuffer.isSpeaking()) {
    chipAudio.className = 'chip speaking'
  } else if (isAudioActive) {
    chipAudio.className = 'chip active'
  }

  requestAnimationFrame(startVuMeterLoop)
}

// Periodic STT trigger loop (checks every 500ms; triggers if >= 3s elapsed, worker not busy, and speech detected)
let lastTranscribeTime = 0
let lastAudioStateLog = 0
let isTranscribing = false

function startSttPollingLoop(): void {
  if (!isAudioActive) return

  const now = Date.now()
  if (now - lastAudioStateLog >= 4000) {
    lastAudioStateLog = now
    const energy = ringBuffer.getEnergy()
    addDebugLog(`[Audio State] Energy: ${(energy * 100).toFixed(0)}%, isSpeaking: ${ringBuffer.isSpeaking()}`, 'info')
  }

  if (now - lastTranscribeTime >= 3000 && !isTranscribing && ringBuffer.isSpeaking()) {
    const rawAudio = ringBuffer.getRecentWindow(6) // 6-second rolling window
    if (sttWorker && rawAudio.length > 0) {
      const recentAudio = normalizeAudio(rawAudio)
      isTranscribing = true
      lastTranscribeTime = now
      chipStt.className = 'chip active'
      labelStt.textContent = 'STT: Transcribing...'
      addDebugLog(`[STT] Sending ${recentAudio.length} samples (${(recentAudio.length / 16000).toFixed(1)}s) to Whisper...`, 'info')
      sttWorker.postMessage({
        type: 'transcribe',
        audio: recentAudio,
        id: `chunk_${now}`
      })
    }
  }

  setTimeout(startSttPollingLoop, 500)
}

// --- STT Web Worker Initialization ---
function initSttWorker(): void {
  try {
    addDebugLog('[STT] Initializing Whisper Web Worker...', 'info')
    sttWorker = new Worker(new URL('./audio/stt.worker.ts', import.meta.url), {
      type: 'module'
    })

    sttWorker.onmessage = (event) => {
      const { type, status, model, percent, file, message, text, durationMs, error } = event.data

      if (type === 'log') {
        addDebugLog(message || '', 'info')
      }

      if (type === 'status') {
        if (status === 'idle') {
          if (!activeSttLabel || activeSttLabel === 'STT: Ready') {
            chipStt.className = 'chip'
            labelStt.textContent = 'STT: Standby'
          }
        } else if (status === 'loading') {
          chipStt.className = 'chip active'
          labelStt.textContent = percent ? `STT: Loading (${percent}%)` : 'STT: Downloading Model...'
          addDebugLog(`[STT Model] Loading (${percent || 0}%)${file ? ' - ' + file : ''}`, 'info')
        } else if (status === 'ready') {
          chipStt.className = 'chip ready'
          const shortModel = (model || '').split('/')[1] || model
          const devTag = event.data.device ? ` [${event.data.device.toUpperCase()}]` : ''
          activeSttLabel = `STT: ${shortModel}${devTag}`
          labelStt.textContent = activeSttLabel
          addDebugLog(`[STT Model] ${shortModel} is READY on ${event.data.device ? event.data.device.toUpperCase() : 'GPU'}`, 'success')
        } else if (status === 'error') {
          isTranscribing = false
          chipStt.className = 'chip error'
          labelStt.textContent = 'STT: Model Error'
          addDebugLog(`[STT Model Error] ${error}`, 'error')
          console.warn('[STT] Worker reported error:', error)
        }
      }

      if (type === 'transcription') {
        isTranscribing = false
        chipStt.className = 'chip ready'
        labelStt.textContent = activeSttLabel
        if (text && text.trim().length > 0) {
          addDebugLog(`[STT Result] "${text}" (${durationMs}ms)`, 'success')
          appendSpokenTranscript(text.trim())
        } else {
          addDebugLog(`[STT Result] (no speech detected in chunk, ${durationMs}ms)`, 'warn')
        }
      }
    }

    // Auto-load default model on launch if user enabled it
    if (getIsAutoDownloadEnabled()) {
      const savedModel = getSavedWhisperModel()
      const targetModel = savedModel === 'auto' ? undefined : savedModel
      addDebugLog(`[STT] Auto-downloading launch default model: ${savedModel}`, 'info')
      sttWorker.postMessage({ type: 'init', model: targetModel })
    } else {
      addDebugLog('[STT] Auto-download is disabled. Model will load when audio capture starts.', 'info')
    }
  } catch (err: any) {
    isTranscribing = false
    addDebugLog(`[STT Init Error] ${err.message || err}`, 'error')
    console.error('Failed to instantiate STT worker:', err)
    chipStt.className = 'chip error'
    labelStt.textContent = 'STT: Worker Unavailable'
  }
}

/**
 * Intelligent transcript merger that detects and removes overlapping phrase tails
 * between rolling audio windows to eliminate stutter and duplicated sentences.
 */
function mergeTranscript(existing: string, incoming: string): string {
  const ex = existing.trim()
  const inc = incoming.trim()
  if (!ex) return inc
  if (!inc) return ex

  // If already at end or contained, avoid repeating
  if (ex.endsWith(inc)) return ex

  const exWords = ex.split(/\s+/)
  const incWords = inc.split(/\s+/)

  // Look for overlapping words (up to 12 words)
  const maxOverlap = Math.min(exWords.length, incWords.length, 12)
  for (let n = maxOverlap; n >= 1; n--) {
    const exTail = exWords.slice(-n).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).join(' ')
    const incHead = incWords.slice(0, n).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).join(' ')
    if (exTail && exTail === incHead) {
      const remainder = incWords.slice(n).join(' ')
      return remainder ? `${ex} ${remainder}` : ex
    }
  }

  return `${ex} ${inc}`
}

function appendSpokenTranscript(text: string): void {
  currentSpokenTranscript = mergeTranscript(currentSpokenTranscript, text)
  renderTranscriptUI()
}

function renderTranscriptUI(): void {
  if (!currentSpokenTranscript.trim()) {
    if (activeTurnNumber === 1) {
      transcriptBox.innerHTML = '<span class="transcript-empty">Waiting for interviewer audio...</span>'
    } else {
      transcriptBox.innerHTML = `<span class="transcript-empty">Waiting for Part ${activeTurnNumber} follow-up speech...</span>`
    }
  } else {
    transcriptBox.textContent = currentSpokenTranscript
    transcriptBox.scrollTop = transcriptBox.scrollHeight
  }
}

// --- Dynamic Multi-Turn Interview UI Navigation ---
function renderTurnUI(): void {
  if (turnBadge) {
    if (activeTurnNumber === 1) {
      turnBadge.className = 'turn-badge'
      turnBadge.textContent = 'Turn 1 (Initial)'
    } else {
      turnBadge.className = 'turn-badge follow-up'
      turnBadge.textContent = `Turn ${activeTurnNumber} (Follow-Up #${activeTurnNumber - 1})`
    }
  }

  if (solutionTurnsNav) {
    solutionTurnsNav.innerHTML = ''
    if (completedTurns.length === 0 && !isSolving) {
      solutionTurnsNav.style.display = 'none'
      return
    }
    solutionTurnsNav.style.display = 'flex'

    // Completed turn tabs
    completedTurns.forEach((turn) => {
      const pill = document.createElement('button')
      const isSelected = viewingTurnNumber === turn.turnNumber
      pill.className = `turn-pill completed ${isSelected ? 'active' : ''}`
      pill.textContent = `Part ${turn.turnNumber} ✓`
      pill.title = `Review solution for Part ${turn.turnNumber}:\n"${turn.spokenPrompt.slice(0, 60)}..."`
      pill.onclick = (e) => {
        e.stopPropagation()
        showTurnSolution(turn.turnNumber)
      }
      solutionTurnsNav.appendChild(pill)
    })

    // Active or upcoming turn tab
    const activePill = document.createElement('button')
    const isActiveViewing = viewingTurnNumber === activeTurnNumber
    activePill.className = `turn-pill ${isActiveViewing ? 'active' : ''}`
    activePill.textContent = isSolving ? `Part ${activeTurnNumber} ⟳` : `Part ${activeTurnNumber} (Next)`
    activePill.title = `Part ${activeTurnNumber} (Current In-Progress Turn)`
    activePill.onclick = (e) => {
      e.stopPropagation()
      showTurnSolution(activeTurnNumber)
    }
    solutionTurnsNav.appendChild(activePill)
  }
}

function showTurnSolution(turnNum: number): void {
  viewingTurnNumber = turnNum
  renderTurnUI()

  const turn = completedTurns.find((t) => t.turnNumber === turnNum)
  if (turn) {
    renderMarkdownContent(turn.solutionMarkdown)
    solutionStatus.style.display = 'inline-block'
    solutionStatus.textContent = `PART ${turnNum} SAVED`
    solutionStatus.style.borderColor = 'var(--accent-emerald)'
    solutionStatus.style.color = 'var(--accent-emerald)'
  } else if (turnNum === activeTurnNumber) {
    if (isSolving) {
      renderMarkdownContent(streamedResponseText + '<span class="streaming-cursor"></span>')
      solutionStatus.style.display = 'inline-block'
      solutionStatus.textContent = `STREAMING PART ${activeTurnNumber}...`
      solutionStatus.style.borderColor = 'var(--accent-cyan)'
      solutionStatus.style.color = 'var(--accent-cyan)'
    } else {
      solutionContainer.innerHTML = `
        <div class="solution-empty">
          <div class="empty-icon">💡</div>
          <p>Ready for <strong>Part ${activeTurnNumber} (Follow-Up)</strong>.</p>
          <p style="font-size: 11px; color: var(--text-muted); max-width: 340px; text-align: center;">
            Interviewer follow-up speech is captured above. Prior ${completedTurns.length} part(s) are stored in conversational context. Press <strong>⌘⇧⏎</strong> to solve.
          </p>
        </div>`
      solutionStatus.style.display = 'none'
    }
  }
}

function renderMarkdownContent(mdText: string): void {
  const rawHtml = marked.parse(mdText) as string
  solutionContainer.innerHTML = rawHtml

  // Highlight all code blocks and inject copy buttons
  solutionContainer.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block as HTMLElement)
    const pre = block.parentElement
    if (pre && !pre.querySelector('.copy-code-btn')) {
      const copyBtn = document.createElement('button')
      copyBtn.className = 'copy-code-btn'
      copyBtn.textContent = 'Copy Code'
      copyBtn.onclick = (e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(block.textContent || '')
        copyBtn.textContent = 'Copied!'
        setTimeout(() => (copyBtn.textContent = 'Copy Code'), 1500)
      }
      pre.appendChild(copyBtn)
    }
  })

  solutionContainer.scrollTop = solutionContainer.scrollHeight
}

// --- Clipboard Context Management ---
function updateClipboardContext(text: string, language: string = 'java'): void {
  currentClipboardText = text
  currentClipboardLanguage = language || 'java'
  if (!text || text.trim().length === 0) {
    codeBox.innerHTML = '<span class="transcript-empty">Copy code in your IDE and press ⌘⇧C...</span>'
    codeLangBadge.style.display = 'none'
    return
  }

  codeLangBadge.textContent = language.toUpperCase()
  codeLangBadge.style.display = 'inline-block'

  // Syntax highlight code snippet
  codeBox.textContent = text
  hljs.highlightElement(codeBox)
}

// --- Copilot Solving & Markdown Streaming ---
async function triggerSolve(): Promise<void> {
  if (isSolving) return

  const spoken = currentSpokenTranscript.trim()
  const code = currentClipboardText.trim()

  if (!spoken && !code) {
    alert('Please capture interviewer speech or copy code to clipboard (⌘⇧C) before solving.')
    return
  }

  isSolving = true
  inFlightTurnPrompt = spoken || 'Analyze the provided code context and follow-up on the previous solution.'
  inFlightTurnCode = code
  inFlightTurnLanguage = currentClipboardLanguage || 'Java'
  viewingTurnNumber = activeTurnNumber
  streamedResponseText = ''

  solutionStatus.style.display = 'inline-block'
  solutionStatus.textContent = activeTurnNumber > 1 ? `STREAMING PART ${activeTurnNumber}...` : 'STREAMING...'
  solutionStatus.style.borderColor = 'var(--accent-cyan)'
  solutionStatus.style.color = 'var(--accent-cyan)'
  btnSolve.innerHTML = '<span class="streaming-cursor"></span> Solving...'

  solutionContainer.innerHTML = '<div class="streaming-cursor"></div>'
  renderTurnUI()

  // Retrieve fresh Firebase ID Token if authenticated
  const idToken = await getValidAuthToken()

  // Construct multi-turn conversation history for prior interview turns
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const prevTurn of completedTurns) {
    const userTurnParts: string[] = []
    if (prevTurn.codeContext && prevTurn.codeContext.trim()) {
      userTurnParts.push(
        `### Written Code Context (from Editor / Clipboard):\n\`\`\`${(prevTurn.language || 'java').toLowerCase()}\n${prevTurn.codeContext.trim()}\n\`\`\``
      )
    }
    userTurnParts.push(`### Interviewer Spoken Question / Instruction:\n"${prevTurn.spokenPrompt.trim()}"`)

    history.push({
      role: 'user',
      content: userTurnParts.join('\n\n')
    })
    history.push({
      role: 'assistant',
      content: prevTurn.solutionMarkdown
    })
  }

  addDebugLog(
    `[Solve] Triggering Part ${activeTurnNumber} with ${completedTurns.length} prior turn(s) in conversational history`,
    'info'
  )

  // Invoke Main process SSE proxy client with aligned keys and history
  window.electronAPI.solve({
    spokenPrompt: inFlightTurnPrompt,
    codeContext: inFlightTurnCode,
    language: inFlightTurnLanguage,
    history,
    authToken: idToken || undefined
  })
}

function renderMarkdownStream(chunk: string): void {
  streamedResponseText += chunk
  renderMarkdownContent(streamedResponseText + '<span class="streaming-cursor"></span>')
}

function finalizeSolution(): void {
  isSolving = false

  // Save the solved turn into completedTurns
  if (streamedResponseText.trim().length > 0) {
    completedTurns.push({
      turnNumber: activeTurnNumber,
      spokenPrompt: inFlightTurnPrompt,
      codeContext: inFlightTurnCode,
      language: inFlightTurnLanguage,
      solutionMarkdown: streamedResponseText,
      timestamp: Date.now()
    })
    addDebugLog(
      `[Solve] Part ${activeTurnNumber} saved to conversation history (Total turns: ${completedTurns.length})`,
      'success'
    )

    // Advance active turn number for subsequent follow-up questions
    activeTurnNumber = completedTurns.length + 1
    viewingTurnNumber = completedTurns.length // Focus on the just-solved turn
  }

  // Clear current audio ring buffer & speech box so interviewer's follow-up question starts clean
  ringBuffer.clear()
  currentSpokenTranscript = ''
  renderTranscriptUI()
  renderTurnUI()

  solutionStatus.textContent = `PART ${viewingTurnNumber} COMPLETE`
  solutionStatus.style.borderColor = 'var(--accent-emerald)'
  solutionStatus.style.color = 'var(--accent-emerald)'
  btnSolve.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>Solve Question</span><span class="kbd-badge">⌘⇧⏎</span>`

  // Remove streaming cursor
  const cursor = solutionContainer.querySelector('.streaming-cursor')
  if (cursor) cursor.remove()
}



// --- Clear Context / Reset Topic ---
function clearAllContext(): void {
  completedTurns = []
  activeTurnNumber = 1
  viewingTurnNumber = 1
  inFlightTurnPrompt = ''
  inFlightTurnCode = ''
  ringBuffer.clear()
  currentSpokenTranscript = ''
  currentClipboardText = ''
  streamedResponseText = ''
  isTranscribing = false
  renderTurnUI()
  renderTranscriptUI()
  updateClipboardContext('')
  solutionContainer.innerHTML = `
    <div class="solution-empty">
      <div class="empty-icon">💡</div>
      <p>Ready. Press <strong>⌘⇧⏎</strong> or click "Solve Question" below to stream live Java/coding solutions.</p>
    </div>`
  solutionStatus.style.display = 'none'
  window.electronAPI.abortSolve()
}

// --- Periodic Proxy API Health Check ---
async function pollProxyHealth(): Promise<void> {
  try {
    const res = await window.electronAPI.checkApiHealth()
    if (res.ok) {
      chipProxy.className = 'chip ready'
      labelProxy.textContent = `Proxy: ${res.latencyMs}ms`
    } else {
      const isStarting = res.status.includes('Starting') || res.status.includes('Cold Boot')
      chipProxy.className = isStarting ? 'chip active' : 'chip error'
      labelProxy.textContent = isStarting ? 'Proxy: Waking up...' : `Proxy: ${res.status}`
    }
  } catch {
    chipProxy.className = 'chip error'
    labelProxy.textContent = 'Proxy: Offline'
  }
}

// --- Wire Up Event Listeners & IPC Handlers ---
function setupEventListeners(): void {
  // Audio controls
  btnStartAudio.addEventListener('click', startAudioCapture)

  btnClearTranscript.addEventListener('click', () => {
    currentSpokenTranscript = ''
    renderTranscriptUI()
  })

  // Clipboard controls
  btnCaptureClipboard.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText()
      updateClipboardContext(text, 'java')
    } catch (err: any) {
      addDebugLog(`[Clipboard] Failed to read clipboard: ${err.message || err}`, 'warn')
    }
  })

  btnClearCode.addEventListener('click', () => {
    updateClipboardContext('')
  })

  // Solution controls
  btnSolve.addEventListener('click', triggerSolve)
  btnClearAll.addEventListener('click', clearAllContext)

  if (btnNewTopic) {
    btnNewTopic.addEventListener('click', () => {
      clearAllContext()
    })
  }

  btnCopySolution.addEventListener('click', () => {
    const turn = completedTurns.find((t) => t.turnNumber === viewingTurnNumber)
    const textToCopy = turn ? turn.solutionMarkdown : streamedResponseText
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy)
      btnCopySolution.textContent = 'Copied!'
      setTimeout(() => (btnCopySolution.textContent = 'Copy All'), 1500)
    }
  })

  // Window Controls
  btnMinimize.addEventListener('click', () => window.electronAPI.minimizeWindow())
  btnClose.addEventListener('click', () => window.electronAPI.closeWindow())

  btnPassthrough.addEventListener('click', () => {
    isPassThrough = !isPassThrough
    window.electronAPI.toggleClickThrough(isPassThrough)
    btnPassthrough.classList.toggle('active', isPassThrough)
  })

  // Open detached Chromium DevTools
  if (btnDevTools) {
    btnDevTools.addEventListener('click', () => {
      window.electronAPI.openDevTools()
      addDebugLog('[DevTools] Opened detached DevTools window', 'info')
    })
  }

  // Toggle Diagnostic Log Drawer
  if (btnToggleLogs && debugLogBox) {
    btnToggleLogs.addEventListener('click', () => {
      const isHidden = debugLogBox.style.display === 'none'
      debugLogBox.style.display = isHidden ? 'block' : 'none'
      btnToggleLogs.classList.toggle('active', isHidden)
    })
  }

  // Copy Logs to Clipboard
  if (btnCopyLogs) {
    btnCopyLogs.addEventListener('click', () => {
      navigator.clipboard.writeText(debugLogs.join('\n'))
      btnCopyLogs.textContent = 'Copied!'
      setTimeout(() => {
        btnCopyLogs.textContent = 'Copy Logs'
      }, 1500)
    })
  }

  // Settings Modal Controls
  btnSettings.addEventListener('click', async () => {
    const config = await window.electronAPI.getApiConfig()
    inputApiUrl.value = config.apiUrl
    inputApiToken.value = config.authToken
    if (selectWhisperModel) {
      selectWhisperModel.value = getSavedWhisperModel()
    }
    if (checkAutoDownloadModel) {
      checkAutoDownloadModel.checked = getIsAutoDownloadEnabled()
    }
    settingsModal.classList.add('open')
  })

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.remove('open')
  })

  inputOpacity.addEventListener('input', () => {
    const val = parseInt(inputOpacity.value, 10)
    opacityVal.textContent = `${val}%`
    window.electronAPI.setWindowOpacity(val / 100)
  })

  // Auth Status Watcher (Updates HUD chip and settings UI)
  onAuthStatusChanged((user) => {
    if (user) {
      chipAuth.classList.add('online')
      chipAuth.classList.remove('offline')
      labelAuth.textContent = `Auth: ${user.email || user.uid.slice(0, 6)}`
      authUserInfo.innerHTML = `<span style="color: var(--accent-emerald);">● Logged In</span> (<code>${user.email || user.uid}</code>) <button id="btn-logout" class="small-btn" style="margin-left: 8px;">Logout</button>`
      const btnLogout = document.getElementById('btn-logout')
      if (btnLogout) {
        btnLogout.onclick = async () => {
          await logoutUser()
        }
      }
    } else {
      chipAuth.classList.remove('online')
      chipAuth.classList.add('offline')
      labelAuth.textContent = 'Auth: Guest'
      authUserInfo.textContent = 'Status: Not signed in. Use copilot:// URL or paste token below.'
    }
  })

  // Manual token apply button in settings
  btnApplyToken.addEventListener('click', async () => {
    let val = inputCustomToken.value.trim()
    if (!val) return
    if (val.startsWith('copilot://')) {
      try {
        const parsed = new URL(val)
        val = parsed.searchParams.get('token') || parsed.searchParams.get('customToken') || val
      } catch {}
    }
    try {
      btnApplyToken.textContent = '...'
      await signInWithCustomToken(auth, val)
      inputCustomToken.value = ''
      btnApplyToken.textContent = 'OK!'
      setTimeout(() => { btnApplyToken.textContent = 'Login' }, 2000)
    } catch (err: any) {
      alert('Error signing in with custom token: ' + (err.message || err))
      btnApplyToken.textContent = 'Login'
    }
  })

  btnSaveSettings.addEventListener('click', async () => {
    const apiUrl = inputApiUrl.value.trim()
    const authToken = inputApiToken.value.trim()
    await window.electronAPI.setApiConfig({ apiUrl, authToken })

    // Save STT preferences to localStorage
    const chosenModel = selectWhisperModel.value
    localStorage.setItem(STORAGE_KEY_WHISPER_MODEL, chosenModel)
    if (checkAutoDownloadModel) {
      localStorage.setItem(STORAGE_KEY_AUTO_DOWNLOAD, String(checkAutoDownloadModel.checked))
    }

    if (sttWorker) {
      const selectedModel = chosenModel === 'auto' ? undefined : chosenModel
      addDebugLog(`[Settings] Switching STT model to: ${chosenModel}`, 'info')
      sttWorker.postMessage({ type: 'init', model: selectedModel })
    }

    const health = await window.electronAPI.checkApiHealth(apiUrl, authToken)
    alert(`Settings saved!\nDefault STT Model: ${chosenModel}\nProxy Status: ${health.status} (${health.latencyMs}ms)`)
    settingsModal.classList.remove('open')
    pollProxyHealth()
  })

  // IPC Event Subscriptions from Main Process
  window.electronAPI.onClipboardCaptured((data) => {
    console.log('[Renderer] Received clipboard captured IPC:', data)
    updateClipboardContext(data.text, data.language)
  })

  window.electronAPI.onTriggerSolve(() => {
    console.log('[Renderer] Trigger Solve hotkey received.')
    triggerSolve()
  })

  window.electronAPI.onTriggerClear(() => {
    console.log('[Renderer] Trigger Clear hotkey received.')
    clearAllContext()
  })

  window.electronAPI.onPassThroughChanged((enabled) => {
    isPassThrough = enabled
    btnPassthrough.classList.toggle('active', enabled)
  })

  window.electronAPI.onStreamStart(() => {
    console.log('[Renderer] SSE Stream started.')
  })

  window.electronAPI.onStreamChunk((chunk) => {
    renderMarkdownStream(chunk)
  })

  window.electronAPI.onStreamEnd(() => {
    console.log('[Renderer] SSE Stream complete.')
    finalizeSolution()
  })

  window.electronAPI.onStreamError((errorMsg) => {
    console.warn('[Renderer] SSE Stream error:', errorMsg)
    isSolving = false
    solutionStatus.textContent = 'ERROR'
    solutionStatus.style.borderColor = 'var(--accent-rose)'
    solutionStatus.style.color = 'var(--accent-rose)'
    btnSolve.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>Retry Solve</span><span class="kbd-badge">⌘⇧⏎</span>`

    const isNoCredits =
      errorMsg.includes('402') ||
      errorMsg.includes('Insufficient credits') ||
      errorMsg.includes('INSUFFICIENT_CREDITS') ||
      errorMsg.includes('No dispones de créditos')

    const isStarting =
      errorMsg.includes('Starting') ||
      errorMsg.includes('Timeout') ||
      errorMsg.includes('Cold Boot') ||
      errorMsg.includes('Failed to fetch') ||
      errorMsg.includes('502') ||
      errorMsg.includes('503') ||
      errorMsg.includes('504')

    if (isNoCredits) {
      solutionContainer.innerHTML = `
        <div style="padding: 14px; border: 1px solid rgba(245, 158, 11, 0.35); background: rgba(245, 158, 11, 0.08); border-radius: var(--radius-sm); margin-top: 4px;">
          <div style="color: var(--accent-amber); font-weight: 600; font-size: 12.5px; margin-bottom: 6px;">
            💳 Sin Consultas Disponibles (Pase Requerido)
          </div>
          <p style="font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 12px;">
            Has agotado tus consultas disponibles. Para desbloquear el asistente en vivo adquiere un pase de entrevista de pago único en tu panel web.
          </p>
          <a href="https://interview-copilot-web.onrender.com/dashboard#planes" target="_blank" rel="noreferrer" class="small-btn" style="display: inline-block; text-decoration: none; padding: 6px 12px; font-size: 11px; color: #07090e; background: var(--accent-emerald); font-weight: 700; border-radius: 4px;">
            ⚡ Adquirir Pase en la Web
          </a>
        </div>`
      return
    }

    solutionContainer.innerHTML = `
      <div style="padding: 14px; border: 1px solid rgba(244, 63, 94, 0.3); background: rgba(244, 63, 94, 0.08); border-radius: var(--radius-sm); margin-top: 4px;">
        <div style="color: var(--accent-rose); font-weight: 600; font-size: 12.5px; margin-bottom: 6px;">
          ⚠️ Backend Connection Error
        </div>
        <p style="font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;">
          ${isStarting ? 'The Render backend is waking up from idle sleep (free tier takes ~30s on cold start). Please wait a few seconds and click Retry.' : `Proxy API returned: <em>${errorMsg}</em>`}
        </p>
        <button id="btn-retry-solve" class="small-btn" style="padding: 4px 10px; font-size: 11px; color: var(--text-primary); border-color: rgba(255,255,255,0.2);">
          Retry Solve (⌘⇧⏎)
        </button>
      </div>`

    const retryBtn = document.getElementById('btn-retry-solve')
    if (retryBtn) {
      retryBtn.onclick = () => triggerSolve()
    }
  })
}

// --- Initialization ---
function bootstrap(): void {
  // Restore persisted STT preferences to settings UI
  if (selectWhisperModel) {
    selectWhisperModel.value = getSavedWhisperModel()
  }
  if (checkAutoDownloadModel) {
    checkAutoDownloadModel.checked = getIsAutoDownloadEnabled()
  }

  initializeAuthBridge()
  setupEventListeners()
  renderTurnUI()
  initSttWorker()
  pollProxyHealth()
  setInterval(pollProxyHealth, 15000)
}

document.addEventListener('DOMContentLoaded', bootstrap)
