import { EventEmitter } from 'events'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { AudioCaptureConfig, AudioDevice } from '@shared/types'

// Audio capture uses Node.js native addon (naudiodon) or Swift bridge.
// This service wraps the platform-specific implementation with a clean API.
// For macOS: uses CoreAudio via naudiodon or a native Swift/Objective-C addon.

export interface AudioChunk {
  data: Buffer
  sampleRate: number
  channels: number
  timestamp: number // ms since recording start
}

export type AudioCaptureState = 'idle' | 'recording' | 'paused' | 'error'

/**
 * AudioCaptureService — emits 'chunk' events with raw PCM audio buffers.
 *
 * Events:
 *   chunk(AudioChunk)          — new PCM buffer ready for transcription
 *   state(AudioCaptureState)   — state change
 *   error(Error)               — capture error
 *   level(number)              — RMS level 0.0–1.0 for VU meter
 */
export class AudioCaptureService extends EventEmitter {
  private state: AudioCaptureState = 'idle'
  private recordingStartTime = 0
  private levelInterval: ReturnType<typeof setInterval> | null = null
  private recordBuffer: Buffer[] = []
  private recordConfig: { sampleRate: number; channels: number } | null = null

  // Dynamically required so the app doesn't hard-fail if naudiodon isn't installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private portAudio: any = null

  private inputStream: NodeJS.ReadableStream | null = null

  constructor() {
    super()
    this.tryLoadPortAudio()
  }

  private tryLoadPortAudio(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.portAudio = require('naudiodon')
    } catch {
      console.warn('[AudioCapture] naudiodon not available — audio capture will be simulated')
    }
  }

  getState(): AudioCaptureState {
    return this.state
  }

  listDevices(): AudioDevice[] {
    if (!this.portAudio) return []
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const devices = this.portAudio.getDevices() as Array<{
        id: number
        name: string
        maxInputChannels: number
        maxOutputChannels: number
        defaultSampleRate: number
        hostAPIName: string
        defaultDevice: boolean
      }>
      return devices
        .filter((d) => d.maxInputChannels > 0 || d.maxOutputChannels > 0)
        .map((d) => ({
          id: String(d.id),
          name: d.name,
          type: d.maxInputChannels > 0 ? ('input' as const) : ('output' as const),
          isDefault: d.defaultDevice
        }))
    } catch {
      return []
    }
  }

  start(config: AudioCaptureConfig): void {
    if (this.state === 'recording') return

    this.recordingStartTime = Date.now()
    this.recordBuffer = []
    this.recordConfig = { sampleRate: config.sampleRate, channels: config.channels }

    if (!this.portAudio) {
      // Simulation mode for dev / testing without audio hardware
      this.setState('recording')
      this.startLevelSimulation()
      return
    }

    try {
      const deviceId = config.inputDeviceId
        ? parseInt(config.inputDeviceId, 10)
        : this.getDefaultInputDevice()

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      this.inputStream = new this.portAudio.AudioIO({
        inOptions: {
          channelCount: config.channels,
          sampleFormat: this.portAudio.SampleFormat16Bit,
          sampleRate: config.sampleRate,
          deviceId,
          closeOnError: false
        }
      })

      this.inputStream!.on('data', (chunk: Buffer) => {
        const audioChunk: AudioChunk = {
          data: chunk,
          sampleRate: config.sampleRate,
          channels: config.channels,
          timestamp: Date.now() - this.recordingStartTime
        }
        this.recordBuffer.push(chunk)
        this.emit('chunk', audioChunk)
        this.emitLevel(chunk)
      })

      this.inputStream!.on('error', (err: Error) => {
        this.setState('error')
        this.emit('error', err)
      })

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ;(this.inputStream as NodeJS.ReadableStream & { start(): void }).start()
      this.setState('recording')
    } catch (err) {
      this.setState('error')
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  stop(): void {
    if (this.state === 'idle') return

    if (this.levelInterval) {
      clearInterval(this.levelInterval)
      this.levelInterval = null
    }

    if (this.inputStream) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        ;(this.inputStream as NodeJS.ReadableStream & { quit(): void }).quit()
      } catch {
        // Ignore cleanup errors
      }
      this.inputStream = null
    }

    this.setState('idle')
  }

  private setState(state: AudioCaptureState): void {
    this.state = state
    this.emit('state', state)
  }

  private getDefaultInputDevice(): number {
    if (!this.portAudio) return -1
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return (this.portAudio.getDefaultInputDevice() as number) ?? -1
    } catch {
      return -1
    }
  }

  private emitLevel(buffer: Buffer): void {
    // Compute RMS from 16-bit PCM samples
    const samples = buffer.length / 2
    if (samples === 0) return
    let sum = 0
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / samples)
    this.emit('level', Math.min(rms * 5, 1)) // Scale for display
  }

  private startLevelSimulation(): void {
    // Emit simulated level pulses when in simulation mode
    this.levelInterval = setInterval(() => {
      const level = (Math.sin(Date.now() / 300) + 1) / 2 * 0.3
      this.emit('level', level)
    }, 100)
  }

  saveAudio(filePath: string): void {
    if (!this.recordConfig || this.recordBuffer.length === 0) return
    const { sampleRate, channels } = this.recordConfig
    const pcm = Buffer.concat(this.recordBuffer)
    const wav = buildWav(pcm, sampleRate, channels)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, wav)
  }
}

function buildWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2
  const blockAlign = channels * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)       // PCM chunk size
  header.writeUInt16LE(1, 20)        // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)       // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
