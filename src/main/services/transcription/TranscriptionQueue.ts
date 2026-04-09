import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { WhisperService, TranscriptionResult } from './WhisperService'
import type { AudioCaptureService, AudioChunk } from '../audio/AudioCaptureService'
import type { TranscriptRepository, CreateSegmentInput } from '../storage/repositories/TranscriptRepository'
import type { RecordingRepository } from '../storage/repositories/RecordingRepository'
import type { TranscriptSegment } from '@shared/types'

/**
 * TranscriptionQueue — orchestrates audio capture → Whisper → DB persistence.
 *
 * Events:
 *   segment(TranscriptSegment)   — a new segment was transcribed and saved
 *   error(Error)                 — transcription error
 *   complete(recordingId)        — recording finalized
 */
export class TranscriptionQueue extends EventEmitter {
  private activeRecordingId: string | null = null
  private segmentOffset = 0 // Running timestamp offset in seconds

  constructor(
    private readonly whisper: WhisperService,
    private readonly audio: AudioCaptureService,
    private readonly transcriptRepo: TranscriptRepository,
    private readonly recordingRepo: RecordingRepository
  ) {
    super()
    this.audio.on('chunk', this.onAudioChunk)
  }

  start(recordingId: string): void {
    this.activeRecordingId = recordingId
    this.segmentOffset = 0
  }

  async stop(): Promise<void> {
    if (!this.activeRecordingId) return
    const recordingId = this.activeRecordingId

    // Flush any remaining buffered audio
    await this.whisper.flush(recordingId, (result) => this.handleResult(result))

    this.activeRecordingId = null
    this.whisper.reset()
    this.emit('complete', recordingId)
  }

  private onAudioChunk = async (chunk: AudioChunk): Promise<void> => {
    if (!this.activeRecordingId) return
    try {
      await this.whisper.pushChunk(chunk, this.activeRecordingId, (result) =>
        this.handleResult(result)
      )
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  private handleResult(result: TranscriptionResult): void {
    for (const seg of result.segments) {
      const input: CreateSegmentInput = {
        recordingId: result.recordingId,
        text: seg.text,
        timestampStart: this.segmentOffset + seg.start,
        timestampEnd: this.segmentOffset + seg.end,
        whisperConfidence: seg.confidence
      }

      const saved = this.transcriptRepo.create(input)
      this.emit('segment', saved)

      // Advance offset so next chunk's timestamps continue correctly
      if (seg.end > 0) {
        this.segmentOffset = Math.max(this.segmentOffset, this.segmentOffset + seg.end)
      }
    }
  }

  destroy(): void {
    this.audio.off('chunk', this.onAudioChunk)
    this.removeAllListeners()
  }
}
