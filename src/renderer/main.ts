import { marked } from 'marked'
import hljs from 'highlight.js'
import { AudioRingBuffer } from './audio/ringBuffer'

// --- State Variables ---
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
const ringBuffer = new AudioRingBuffer(16000, 60)
let sttWorker: Worker | null = null
let isAudioActive = false
let isSolving = false
let streamedResponseText = ''
let currentClipboardText = ''
let currentSpokenTranscript = ''
let isPassThrough = false

// Sample interview questions for instant demo/testing
const sampleQuestions = [
  'Can you implement a thread-safe, high-concurrency LRU Cache in Java with O(1) get and put operations, without holding a global lock on reads?',
  'How would you refactor this interface to use Java 21 Virtual Threads and a Semaphore for backpressure under high throughput?',
  'What are the memory consistency guarantees of the Double-Checked Locking pattern, and why is the volatile keyword mandatory here?',
  'Design an in-memory rate limiter supporting 10,000 RPS per tenant using token bucket algorithm with atomic primitives.'
]
let sampleQuestionIdx = 0

// Sample Java code for quick context demo
const sampleCodeSnippet = `public interface ConcurrentCache<K, V> {
    V get(K key);
    void put(K key, V value);
    int size();
    void evictOldest();
}`

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

const btnStartAudio = document.getElementById('btn-start-audio') as HTMLButtonElement
const btnSimSpeech = document.getElementById('btn-sim-speech') as HTMLButtonElement
const btnClearTranscript = document.getElementById('btn-clear-transcript') as HTMLButtonElement
const transcriptBox = document.getElementById('transcript-box') as HTMLDivElement

const btnCaptureClipboard = document.getElementById('btn-capture-clipboard') as HTMLButtonElement
const btnClearCode = document.getElementById('btn-clear-code') as HTMLButtonElement
const codeBox = document.getElementById('code-box') as HTMLElement
const codeLangBadge = document.getElementById('code-lang-badge') as HTMLSpanElement

const solutionContainer = document.getElementById('solution-container') as HTMLDivElement
const solutionStatus = document.getElementById('solution-status') as HTMLSpanElement
const btnCopySolution = document.getElementById('btn-copy-solution') as HTMLButtonElement
const btnSolve = document.getElementById('btn-solve') as HTMLButtonElement
const btnClearAll = document.getElementById('btn-clear-all') as HTMLButtonElement

// Settings Modal DOM
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement
const btnCloseSettings = document.getElementById('btn-close-settings') as HTMLButtonElement
const inputApiUrl = document.getElementById('input-api-url') as HTMLInputElement
const inputApiToken = document.getElementById('input-api-token') as HTMLInputElement
const selectWhisperModel = document.getElementById('select-whisper-model') as HTMLSelectElement
const inputOpacity = document.getElementById('input-opacity') as HTMLInputElement
const opacityVal = document.getElementById('opacity-val') as HTMLSpanElement
const btnSaveSettings = document.getElementById('btn-save-settings') as HTMLButtonElement

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

    sourceNode.connect(processor)
    processor.connect(audioContext.destination)

    isAudioActive = true
    btnStartAudio.textContent = 'Stop Audio'
    chipAudio.className = 'chip active'
    labelAudio.textContent = 'Audio: Capturing Loopback'

    startVuMeterLoop()
    startSttPollingLoop()

    audioTrack.onended = () => {
      stopAudioCapture()
    }
  } catch (err: any) {
    console.error('Audio capture error:', err)
    btnStartAudio.textContent = 'Capture Output Audio'
    chipAudio.className = 'chip error'
    labelAudio.textContent = 'Audio: Failed/Denied'
    alert(`System audio capture could not start: ${err.message}`)
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

// Periodic STT trigger loop (every 4 seconds if voice activity detected)
let lastTranscribeTime = 0
function startSttPollingLoop(): void {
  if (!isAudioActive) return

  const now = Date.now()
  if (now - lastTranscribeTime > 4000 && ringBuffer.isSpeaking()) {
    lastTranscribeTime = now
    const recentAudio = ringBuffer.getRecentWindow(10) // last 10 seconds of speech
    if (sttWorker && recentAudio.length > 0) {
      sttWorker.postMessage({
        type: 'transcribe',
        audio: recentAudio,
        id: `chunk_${now}`
      })
    }
  }

  setTimeout(startSttPollingLoop, 1000)
}

// --- STT Web Worker Initialization ---
function initSttWorker(): void {
  try {
    sttWorker = new Worker(new URL('./audio/stt.worker.ts', import.meta.url), {
      type: 'module'
    })

    sttWorker.onmessage = (event) => {
      const { type, status, model, percent, text, durationMs, error } = event.data

      if (type === 'status') {
        if (status === 'loading') {
          chipStt.className = 'chip active'
          labelStt.textContent = percent ? `STT: Loading (${percent}%)` : 'STT: Downloading Model...'
        } else if (status === 'ready') {
          chipStt.className = 'chip ready'
          const shortModel = model.split('/')[1] || model
          labelStt.textContent = `STT: ${shortModel} Ready`
        } else if (status === 'error') {
          chipStt.className = 'chip error'
          labelStt.textContent = 'STT: Model Error'
          console.warn('[STT] Worker reported error:', error)
        }
      }

      if (type === 'transcription') {
        if (text && text.trim().length > 0) {
          appendSpokenTranscript(text.trim())
          console.log(`[STT] Transcribed in ${durationMs}ms: "${text}"`)
        }
      }
    }
  } catch (err) {
    console.error('Failed to instantiate STT worker:', err)
    chipStt.className = 'chip error'
    labelStt.textContent = 'STT: Worker Unavailable'
  }
}

function appendSpokenTranscript(text: string): void {
  if (!currentSpokenTranscript) {
    currentSpokenTranscript = text
  } else {
    // Avoid immediate duplicate sentence appending
    if (!currentSpokenTranscript.endsWith(text)) {
      currentSpokenTranscript += ` ${text}`
    }
  }
  renderTranscriptUI()
}

function renderTranscriptUI(): void {
  if (!currentSpokenTranscript.trim()) {
    transcriptBox.innerHTML = '<span class="transcript-empty">Waiting for interviewer audio or press "Sample Q" to test...</span>'
  } else {
    transcriptBox.textContent = currentSpokenTranscript
    transcriptBox.scrollTop = transcriptBox.scrollHeight
  }
}

// --- Clipboard Context Management ---
function updateClipboardContext(text: string, language: string = 'java'): void {
  currentClipboardText = text
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
function triggerSolve(): void {
  if (isSolving) return

  const spoken = currentSpokenTranscript.trim()
  const code = currentClipboardText.trim()

  if (!spoken && !code) {
    alert('Please capture interviewer speech or copy code to clipboard (⌘⇧C) before solving.')
    return
  }

  isSolving = true
  streamedResponseText = ''
  solutionStatus.style.display = 'inline-block'
  solutionStatus.textContent = 'STREAMING...'
  solutionStatus.style.borderColor = 'var(--accent-cyan)'
  solutionStatus.style.color = 'var(--accent-cyan)'
  btnSolve.innerHTML = '<span class="streaming-cursor"></span> Solving...'

  solutionContainer.innerHTML = '<div class="streaming-cursor"></div>'

  // Invoke Main process SSE proxy client
  window.electronAPI.solve({
    spokenContext: spoken,
    codeContext: code
  })
}

function renderMarkdownStream(chunk: string): void {
  streamedResponseText += chunk
  const rawHtml = marked.parse(streamedResponseText) as string
  solutionContainer.innerHTML = rawHtml + '<span class="streaming-cursor"></span>'

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

function finalizeSolution(): void {
  isSolving = false
  solutionStatus.textContent = 'COMPLETE'
  solutionStatus.style.borderColor = 'var(--accent-emerald)'
  solutionStatus.style.color = 'var(--accent-emerald)'
  btnSolve.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>Solve Question</span><span class="kbd-badge">⌘⇧⏎</span>`

  // Remove streaming cursor
  const cursor = solutionContainer.querySelector('.streaming-cursor')
  if (cursor) cursor.remove()
}

// Intelligent fallback simulation if Proxy API backend isn't currently running
function simulateLocalSolution(): void {
  const simulatedMarkdown = `### 💡 High-Concurrency LRU Cache Solution (Java 21)

#### 1. Core Architecture & Concurrency Strategy
To achieve **O(1)** \`get\` and \`put\` operations without a global lock on reads:
- Use **\`ConcurrentHashMap<K, Node<K, V>>\`** for lock-free \`O(1)\` key lookups.
- Maintain a **concurrent doubly-linked list** with fine-grained \`ReentrantLock\` or a segmented queue to manage LRU eviction ordering.
- Use **atomic timestamps** (\`AtomicLong\`) or a read-drain ring buffer (similar to Guava Cache / Caffeine) to record read access without blocking concurrent readers.

\`\`\`java
package com.interview.cache;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

public class ConcurrentLRUCache<K, V> implements ConcurrentCache<K, V> {
    private static class Node<K, V> {
        final K key;
        volatile V value;
        Node<K, V> prev;
        Node<K, V> next;

        Node(K key, V value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final ConcurrentHashMap<K, Node<K, V>> map;
    private final Node<K, V> head;
    private final Node<K, V> tail;
    private final ReentrantLock listLock = new ReentrantLock();
    private final AtomicInteger currentSize = new AtomicInteger(0);

    public ConcurrentLRUCache(int capacity) {
        if (capacity <= 0) throw new IllegalArgumentException("Capacity must be > 0");
        this.capacity = capacity;
        this.map = new ConcurrentHashMap<>(capacity);
        this.head = new Node<>(null, null);
        this.tail = new Node<>(null, null);
        head.next = tail;
        tail.prev = head;
    }

    @Override
    public V get(K key) {
        Node<K, V> node = map.get(key);
        if (node == null) return null;

        // Try to record read access; drop if lock is contended to avoid slowing reads
        if (listLock.tryLock()) {
            try {
                moveToHead(node);
            } finally {
                listLock.unlock();
            }
        }
        return node.value;
    }

    @Override
    public void put(K key, V value) {
        Node<K, V> existing = map.get(key);
        if (existing != null) {
            existing.value = value;
            listLock.lock();
            try {
                moveToHead(existing);
            } finally {
                listLock.unlock();
            }
            return;
        }

        Node<K, V> newNode = new Node<>(key, value);
        if (map.putIfAbsent(key, newNode) == null) {
            listLock.lock();
            try {
                addHead(newNode);
                if (currentSize.incrementAndGet() > capacity) {
                    evictOldestInternal();
                }
            } finally {
                listLock.unlock();
            }
        }
    }

    private void moveToHead(Node<K, V> node) {
        removeNode(node);
        addHead(node);
    }

    private void addHead(Node<K, V> node) {
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
    }

    private void removeNode(Node<K, V> node) {
        if (node.prev != null) node.prev.next = node.next;
        if (node.next != null) node.next.prev = node.prev;
    }

    private void evictOldestInternal() {
        Node<K, V> oldest = tail.prev;
        if (oldest != head && oldest != null) {
            removeNode(oldest);
            map.remove(oldest.key);
            currentSize.decrementAndGet();
        }
    }

    @Override
    public int size() {
        return currentSize.get();
    }

    @Override
    public void evictOldest() {
        listLock.lock();
        try {
            evictOldestInternal();
        } finally {
            listLock.unlock();
        }
    }
}
\`\`\`

#### 2. Complexity Analysis
- **Time Complexity**:
  - \`get(key)\`: **O(1)** average lookup. \`tryLock()\` ensures reads never block under contention.
  - \`put(key, val)\`: **O(1)** amortized with synchronized list mutation.
- **Space Complexity**: **O(N)** where $N \\le \\text{capacity}$.
`

  // Stream simulated tokens smoothly
  let charIdx = 0
  const streamInterval = setInterval(() => {
    if (charIdx >= simulatedMarkdown.length) {
      clearInterval(streamInterval)
      finalizeSolution()
      return
    }
    const nextChunk = simulatedMarkdown.slice(charIdx, charIdx + 20)
    charIdx += 20
    renderMarkdownStream(nextChunk)
  }, 16)
}

// --- Clear Context ---
function clearAllContext(): void {
  ringBuffer.clear()
  currentSpokenTranscript = ''
  currentClipboardText = ''
  streamedResponseText = ''
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
      chipProxy.className = 'chip error'
      labelProxy.textContent = `Proxy: ${res.status}`
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

  btnSimSpeech.addEventListener('click', () => {
    const sample = sampleQuestions[sampleQuestionIdx % sampleQuestions.length]
    sampleQuestionIdx++
    appendSpokenTranscript(sample)
  })

  btnClearTranscript.addEventListener('click', () => {
    currentSpokenTranscript = ''
    renderTranscriptUI()
  })

  // Clipboard controls
  btnCaptureClipboard.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText()
      updateClipboardContext(text, 'java')
    } catch {
      updateClipboardContext(sampleCodeSnippet, 'java')
    }
  })

  btnClearCode.addEventListener('click', () => {
    updateClipboardContext('')
  })

  // Solution controls
  btnSolve.addEventListener('click', triggerSolve)
  btnClearAll.addEventListener('click', clearAllContext)

  btnCopySolution.addEventListener('click', () => {
    if (streamedResponseText) {
      navigator.clipboard.writeText(streamedResponseText)
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

  // Settings Modal Controls
  btnSettings.addEventListener('click', async () => {
    const config = await window.electronAPI.getApiConfig()
    inputApiUrl.value = config.apiUrl
    inputApiToken.value = config.authToken
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

  btnSaveSettings.addEventListener('click', async () => {
    const apiUrl = inputApiUrl.value.trim()
    const authToken = inputApiToken.value.trim()
    await window.electronAPI.setApiConfig({ apiUrl, authToken })

    if (sttWorker) {
      sttWorker.postMessage({ type: 'init', model: selectWhisperModel.value })
    }

    const health = await window.electronAPI.checkApiHealth(apiUrl, authToken)
    alert(`Settings saved!\nProxy Status: ${health.status} (${health.latencyMs}ms)`)
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
    // If backend is not available, offer smooth simulation
    solutionContainer.innerHTML = `
      <div style="color: var(--accent-amber); font-size: 12px; margin-bottom: 8px;">
        ⚠️ Proxy API returned: <em>${errorMsg}</em>
      </div>
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">
        Running in offline fallback mode...
      </div>`
    simulateLocalSolution()
  })
}

// --- Initialization ---
function bootstrap(): void {
  setupEventListeners()
  initSttWorker()
  pollProxyHealth()
  setInterval(pollProxyHealth, 15000)

  // Seed sample code snippet initially for instant exploration
  updateClipboardContext(sampleCodeSnippet, 'java')
}

document.addEventListener('DOMContentLoaded', bootstrap)
