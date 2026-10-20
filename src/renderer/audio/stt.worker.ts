import { pipeline, env } from '@xenova/transformers'

// Configure transformers.js for client/worker operation
env.allowLocalModels = false
env.useBrowserCache = true

let transcriber: any = null
let currentModel = 'Xenova/whisper-base.en'
let isInitializing = false

async function initPipeline(modelName: string = 'Xenova/whisper-base.en') {
  if (transcriber && currentModel === modelName) {
    self.postMessage({ type: 'status', status: 'ready', model: currentModel })
    return
  }

  isInitializing = true
  currentModel = modelName
  self.postMessage({ type: 'status', status: 'loading', model: currentModel, percent: 0 })

  try {
    transcriber = await pipeline('automatic-speech-recognition', modelName, {
      progress_callback: (p: any) => {
        if (p.status === 'progress') {
          self.postMessage({
            type: 'status',
            status: 'loading',
            model: currentModel,
            percent: Math.round(p.progress || 0),
            file: p.file
          })
        }
      }
    })

    isInitializing = false
    self.postMessage({ type: 'status', status: 'ready', model: currentModel })
  } catch (err: any) {
    isInitializing = false
    console.error('[STT Worker] Failed to load Whisper pipeline:', err)
    self.postMessage({
      type: 'status',
      status: 'error',
      model: currentModel,
      error: err.message || 'Failed to download or initialize Whisper model'
    })
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { type, model, audio, id } = event.data

  if (type === 'init') {
    await initPipeline(model || 'Xenova/whisper-base.en')
    return
  }

  if (type === 'transcribe') {
    if (!transcriber) {
      if (!isInitializing) {
        await initPipeline(currentModel)
      } else {
        self.postMessage({ type: 'transcription', id, text: '', error: 'Model still initializing' })
        return
      }
    }

    if (!audio || audio.length === 0) {
      self.postMessage({ type: 'transcription', id, text: '' })
      return
    }

    try {
      const startTime = performance.now()
      const output = await transcriber(audio, {
        language: 'english',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5
      })

      const durationMs = Math.round(performance.now() - startTime)
      const text = (output?.text || '').trim()

      self.postMessage({
        type: 'transcription',
        id,
        text,
        durationMs
      })
    } catch (err: any) {
      console.error('[STT Worker] Transcription error:', err)
      self.postMessage({
        type: 'transcription',
        id,
        text: '',
        error: err.message || 'Inference error'
      })
    }
  }
}

// Auto-initiate loading of whisper-base.en on worker spawn
initPipeline('Xenova/whisper-base.en')
