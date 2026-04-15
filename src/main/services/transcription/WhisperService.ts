import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { tmpdir } from 'os'
import type { PythonBridge } from '../../python/PythonBridge'
import type { AudioChunk } from '../audio/AudioCaptureService'
import type { WhisperSegment } from '@shared/types'

interface TranscribeResponse {
  segments: WhisperSegment[]
  language: string
}

export interface TranscriptionResult {
  segments: WhisperSegment[]
  language: string
  recordingId: string
  /** Actual duration of the audio chunk in seconds (computed from PCM byte count).
   *  Used by TranscriptionQueue to advance segmentOffset by the true chunk duration
   *  rather than Whisper's last seg.end, which can be shorter than the chunk when
   *  speech ends before the buffer boundary. */
  chunkDurationSeconds: number
}

const CHUNK_DURATION_MS = 5000 // 5 second windows
const SAMPLE_RATE = 16000
const CHANNELS = 1
const BYTES_PER_SAMPLE = 2 // 16-bit PCM

/**
 * Accumulates raw PCM chunks, writes them to temp WAV files,
 * and sends to the Whisper Python subprocess for transcription.
 */
export class WhisperService {
  private buffer: Buffer[] = []
  private bufferDurationMs = 0
  private modelSize = 'base'
  private language: string | null = null

  constructor(private readonly bridge: PythonBridge) {}

  configure(modelSize: string, language?: string): void {
    this.modelSize = modelSize
    this.language = language ?? null
  }

  /**
   * Push a raw PCM audio chunk into the buffer.
   * When the buffer reaches CHUNK_DURATION_MS, it flushes automatically.
   */
  async pushChunk(
    chunk: AudioChunk,
    recordingId: string,
    onResult: (result: TranscriptionResult) => void
  ): Promise<void> {
    this.buffer.push(chunk.data)
    this.bufferDurationMs += (chunk.data.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000

    if (this.bufferDurationMs >= CHUNK_DURATION_MS) {
      await this.flush(recordingId, onResult)
    }
  }

  /** Flush remaining buffered audio and transcribe it */
  async flush(
    recordingId: string,
    onResult: (result: TranscriptionResult) => void
  ): Promise<void> {
    if (this.buffer.length === 0) return

    const combined = Buffer.concat(this.buffer)
    // Capture the true duration from the PCM byte count BEFORE resetting the buffer.
    // Whisper's seg.end timestamps often end slightly before the chunk boundary (when
    // speech ends before the tail of the buffer), so using them to advance segmentOffset
    // causes cumulative drift. The byte-count duration is always accurate.
    const chunkDurationSeconds = (combined.length / BYTES_PER_SAMPLE) / SAMPLE_RATE
    this.buffer = []
    this.bufferDurationMs = 0

    const wavPath = this.writeWavTmp(combined)
    try {
      const response = await this.bridge.send<TranscribeResponse>('transcribe', 'transcribe', {
        audio_path: wavPath,
        model_size: this.modelSize,
        language: this.language ?? 'auto'
      })

      onResult({
        segments: response.segments,
        language: response.language,
        recordingId,
        chunkDurationSeconds
      })
    } finally {
      this.cleanupTmp(wavPath)
    }
  }

  reset(): void {
    this.buffer = []
    this.bufferDurationMs = 0
  }

  /**
   * Transcribe a pre-existing WAV or PCM file directly.
   * Used by VoiceInputService for push-to-talk commands.
   */
  async transcribeFile(filePath: string, sampleRate = SAMPLE_RATE): Promise<WhisperSegment[]> {
    // If it's raw PCM (not .wav), wrap it in a WAV header first
    let wavPath = filePath
    let tmpCreated = false

    if (!filePath.endsWith('.wav')) {
      const { readFileSync } = await import('fs')
      const pcm = readFileSync(filePath)
      const wavBuffer = this.buildWav(pcm, sampleRate, CHANNELS, BYTES_PER_SAMPLE * 8)
      const tmpDir = join(tmpdir(), 'call-transcriber')
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
      wavPath = join(tmpDir, `voice-input-${Date.now()}.wav`)
      const { writeFileSync } = await import('fs')
      writeFileSync(wavPath, wavBuffer)
      tmpCreated = true
    }

    try {
      const response = await this.bridge.send<TranscribeResponse>('transcribe', 'transcribe', {
        audio_path: wavPath,
        model_size: this.modelSize,
        language: this.language ?? 'auto'
      })
      return response.segments
    } finally {
      if (tmpCreated) this.cleanupTmp(wavPath)
    }
  }

  /**
   * Write raw PCM buffer to a temp WAV file with a proper RIFF header.
   * Whisper requires a 16kHz mono 16-bit PCM WAV.
   */
  private writeWavTmp(pcmData: Buffer): string {
    const tmpDir = join(tmpdir(), 'call-transcriber')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

    const filePath = join(tmpDir, `chunk_${Date.now()}.wav`)
    const wavBuffer = this.buildWav(pcmData, SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE * 8)
    writeFileSync(filePath, wavBuffer)
    return filePath
  }

  private cleanupTmp(filePath: string): void {
    try {
      unlinkSync(filePath)
    } catch {
      // Ignore
    }
  }

  private buildWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8
    const blockAlign = (channels * bitsPerSample) / 8
    const dataSize = pcm.length
    const header = Buffer.alloc(44)

    header.write('RIFF', 0)
    header.writeUInt32LE(36 + dataSize, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16) // PCM chunk size
    header.writeUInt16LE(1, 20)  // PCM format
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataSize, 40)

    return Buffer.concat([header, pcm])
  }
}
