/**
 * VoiceInputService — captures microphone audio and sends it through
 * the Whisper Python bridge for push-to-talk voice commands.
 *
 * Usage:
 *   voiceInput.start()   // begin capturing
 *   voiceInput.stop()    // stop capture and transcribe → emits 'done'
 *
 * Events:
 *   done(transcript: string)   — final transcription text
 *   error(Error)
 */
import { EventEmitter } from 'events'
import { AudioCaptureService } from './AudioCaptureService'
import type { AudioChunk } from './AudioCaptureService'
import type { WhisperService } from '../transcription/WhisperService'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export class VoiceInputService extends EventEmitter {
  private isCapturing = false
  private chunks: Buffer[] = []
  private sampleRate = 16000
  private channels = 1
  private captureService: AudioCaptureService
  private whisper: WhisperService
  private stopCapture: (() => void) | null = null

  constructor(whisper: WhisperService) {
    super()
    this.whisper = whisper
    this.captureService = new AudioCaptureService()
  }

  isActive(): boolean {
    return this.isCapturing
  }

  start(): void {
    if (this.isCapturing) return
    this.chunks = []
    this.isCapturing = true

    const onChunk = (chunk: AudioChunk) => {
      this.chunks.push(chunk.data)
      this.sampleRate = chunk.sampleRate
      this.channels = chunk.channels
    }

    this.captureService.on('chunk', onChunk)

    this.captureService.start({
      inputDeviceId: null,
      systemAudioEnabled: false,
      sampleRate: this.sampleRate,
      channels: this.channels
    })

    this.stopCapture = () => {
      this.captureService.off('chunk', onChunk)
      this.captureService.stop()
    }
  }

  async stop(): Promise<string> {
    if (!this.isCapturing) return ''
    this.isCapturing = false

    if (this.stopCapture) {
      this.stopCapture()
      this.stopCapture = null
    }

    if (this.chunks.length === 0) return ''

    // Write PCM to a temp file
    const pcmPath = join(tmpdir(), `voice-input-${Date.now()}.pcm`)
    try {
      const pcm = Buffer.concat(this.chunks)
      writeFileSync(pcmPath, pcm)

      const segments = await this.whisper.transcribeFile(pcmPath, this.sampleRate)
      const transcript = segments.map((s) => s.text).join(' ').trim()

      this.emit('done', transcript)
      return transcript
    } catch (err) {
      this.emit('error', err)
      return ''
    } finally {
      if (existsSync(pcmPath)) unlinkSync(pcmPath)
      this.chunks = []
    }
  }
}
