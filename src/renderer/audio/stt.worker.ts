import { pipeline, env } from '@huggingface/transformers'

// Configure transformers for browser/worker operation
env.allowLocalModels = false
env.useBrowserCache = true

interface DeviceConfig {
  device: 'webgpu' | 'wasm'
  model: string
  dtype?: any
}

async function detectDeviceAndModel(preferredModel?: string): Promise<DeviceConfig> {
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : null
  const hasWebGPU = nav && 'gpu' in nav && !!nav.gpu

  if (hasWebGPU) {
    try {
      const adapter = await nav.gpu.requestAdapter()
      if (adapter) {
        const targetModel = preferredModel || 'onnx-community/whisper-large-v3-turbo'
        const dtype = targetModel.includes('large-v3-turbo')
          ? {
              encoder_model: 'fp16',
              decoder_model_merged: 'q4'
            }
          : 'fp32'
        return {
          device: 'webgpu',
          model: targetModel,
          dtype
        }
      }
    } catch (e: any) {
      self.postMessage({
        type: 'log',
        message: `[STT Worker] WebGPU adapter request failed (${e.message}), falling back to WASM`
      })
    }
  }

  return {
    device: 'wasm',
    model: preferredModel || 'onnx-community/whisper-tiny.en',
    dtype: 'q8'
  }
}

let transcriber: any = null
let currentModel = ''
let currentDevice = 'wasm'
let isInitializing = false

async function initPipeline(preferredModel?: string) {
  isInitializing = true
  const config = await detectDeviceAndModel(preferredModel)
  currentModel = config.model
  currentDevice = config.device

  self.postMessage({
    type: 'log',
    message: `[STT Worker] Initializing model: ${currentModel} on device: ${currentDevice.toUpperCase()}`
  })
  self.postMessage({ type: 'status', status: 'loading', model: currentModel, percent: 0 })

  try {
    const pipelineOptions: any = {
      device: currentDevice,
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
    }

    if (config.dtype) {
      pipelineOptions.dtype = config.dtype
    }

    transcriber = await pipeline('automatic-speech-recognition', currentModel, pipelineOptions)

    isInitializing = false
    self.postMessage({
      type: 'log',
      message: `[STT Worker] ${currentModel} READY on ${currentDevice.toUpperCase()}`
    })
    self.postMessage({ type: 'status', status: 'ready', model: currentModel, device: currentDevice })
  } catch (err: any) {
    isInitializing = false
    console.error('[STT Worker] Failed to load pipeline:', err)
    self.postMessage({
      type: 'log',
      message: `[STT Worker Error] Failed to initialize: ${err.message || err}`
    })
    self.postMessage({
      type: 'status',
      status: 'error',
      model: currentModel,
      error: err.message || 'Failed to initialize Whisper model'
    })
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { type, model, audio, id } = event.data

  if (type === 'init') {
    await initPipeline(model)
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
      self.postMessage({
        type: 'log',
        message: `[STT Worker] Running Whisper inference on ${audio.length} samples (${(audio.length / 16000).toFixed(1)}s)...`
      })

      // For rolling short audio (<30s), do not specify chunk_length_s/stride_length_s as it causes Transformers.js to drop short slices
      const output = await transcriber(audio, {
        language: 'english',
        task: 'transcribe'
      })

      const durationMs = Math.round(performance.now() - startTime)
      const text = (output?.text || '').trim()

      self.postMessage({
        type: 'log',
        message: `[STT Worker] Finished in ${durationMs}ms. Text: "${text}"`
      })

      self.postMessage({
        type: 'transcription',
        id,
        text,
        durationMs
      })
    } catch (err: any) {
      console.error('[STT Worker] Transcription error:', err)
      self.postMessage({
        type: 'log',
        message: `[STT Worker Error] ${err.message || err}`
      })
      self.postMessage({
        type: 'transcription',
        id,
        text: '',
        error: err.message || 'Inference error'
      })
    }
  }
}

// Auto-initiate detection and loading on worker spawn
initPipeline()
