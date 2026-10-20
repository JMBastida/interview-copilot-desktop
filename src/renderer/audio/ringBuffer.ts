/**
 * Circular Audio Ring Buffer for 16kHz PCM Float32 audio samples.
 * Maintains rolling interviewer speech buffer (up to 60s) with RMS-based Voice Activity Detection.
 */
export class AudioRingBuffer {
  private readonly sampleRate: number
  private readonly maxSeconds: number
  private readonly buffer: Float32Array
  private writePointer: number = 0
  private totalSamplesWritten: number = 0
  private currentRms: number = 0
  private isSpeakingActive: boolean = false
  private readonly vadThreshold: number = 0.015 // RMS threshold for voice detection

  constructor(sampleRate: number = 16000, maxSeconds: number = 60) {
    this.sampleRate = sampleRate
    this.maxSeconds = maxSeconds
    this.buffer = new Float32Array(sampleRate * maxSeconds)
  }

  /**
   * Push newly received 16kHz audio samples into circular buffer
   */
  public write(samples: Float32Array): void {
    const len = samples.length
    const capacity = this.buffer.length

    // Update RMS energy for VAD & VU meter
    let sumSquares = 0
    for (let i = 0; i < len; i++) {
      sumSquares += samples[i] * samples[i]
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, len))
    // Smooth RMS with fast attack, gentle decay
    this.currentRms = rms > this.currentRms ? rms : this.currentRms * 0.85 + rms * 0.15
    this.isSpeakingActive = this.currentRms > this.vadThreshold

    // Circular write
    for (let i = 0; i < len; i++) {
      this.buffer[this.writePointer] = samples[i]
      this.writePointer = (this.writePointer + 1) % capacity
    }
    this.totalSamplesWritten += len
  }

  /**
   * Extract the last `seconds` of audio in contiguous chronological order
   */
  public getRecentWindow(seconds: number): Float32Array {
    const requestedSamples = Math.min(
      Math.round(seconds * this.sampleRate),
      this.buffer.length,
      this.totalSamplesWritten
    )

    if (requestedSamples <= 0) {
      return new Float32Array(0)
    }

    const output = new Float32Array(requestedSamples)
    const capacity = this.buffer.length

    // Calculate start index in circular buffer
    let readPointer = (this.writePointer - requestedSamples + capacity) % capacity

    for (let i = 0; i < requestedSamples; i++) {
      output[i] = this.buffer[readPointer]
      readPointer = (readPointer + 1) % capacity
    }

    return output
  }

  /**
   * Get current RMS audio level normalized roughly [0.0, 1.0]
   */
  public getEnergy(): number {
    return Math.min(1.0, this.currentRms * 8.0)
  }

  /**
   * Returns true if voice activity is detected
   */
  public isSpeaking(): boolean {
    return this.isSpeakingActive
  }

  /**
   * Total recorded seconds currently stored
   */
  public getStoredDurationSeconds(): number {
    const samples = Math.min(this.totalSamplesWritten, this.buffer.length)
    return samples / this.sampleRate
  }

  /**
   * Clear buffer contents
   */
  public clear(): void {
    this.buffer.fill(0)
    this.writePointer = 0
    this.totalSamplesWritten = 0
    this.currentRms = 0
    this.isSpeakingActive = false
  }
}
