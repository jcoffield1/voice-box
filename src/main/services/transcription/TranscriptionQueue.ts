import { EventEmitter } from 'events'
import type { WhisperService, TranscriptionResult } from './WhisperService'
import type { AudioCaptureService, AudioChunk } from '../audio/AudioCaptureService'
import type { TranscriptRepository, CreateSegmentInput } from '../storage/repositories/TranscriptRepository'
import type { RecordingRepository } from '../storage/repositories/RecordingRepository'

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
    _recordingRepo: RecordingRepository
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
    // Capture the offset once — all segments in this Whisper result share the
    // same chunk start, so their start/end values are relative to this offset.
    // Updating the offset INSIDE the loop would shift every subsequent segment
    // within the same chunk by an extra seg.end, corrupting timestamps.
    const chunkOffset = this.segmentOffset
    let maxEnd = 0

    for (const seg of result.segments) {
      // Skip garbage hallucinations. faster-whisper expresses confidence as
      // avg_logprob (0 = perfect, more negative = worse). Segments below -0.7
      // are almost always silence/noise artefacts ("U", short hex strings, etc.).
      // Also skip blank/whitespace-only text.
      if (!seg.text.trim()) continue
      if (seg.confidence < -0.7) continue

      const input: CreateSegmentInput = {
        recordingId: result.recordingId,
        text: seg.text,
        timestampStart: chunkOffset + seg.start,
        timestampEnd: chunkOffset + seg.end,
        whisperConfidence: seg.confidence
      }

      const saved = this.transcriptRepo.create(input)
      this.emit('segment', saved)

      if (seg.end > maxEnd) maxEnd = seg.end
    }

    // Advance the offset by the furthest end time in this chunk
    if (maxEnd > 0) {
      this.segmentOffset = chunkOffset + maxEnd
    }
  }

  destroy(): void {
    this.audio.off('chunk', this.onAudioChunk)
    this.removeAllListeners()
  }
}
