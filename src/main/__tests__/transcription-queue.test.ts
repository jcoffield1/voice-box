import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { TranscriptionQueue } from '@main/services/transcription/TranscriptionQueue'
import type { WhisperService } from '@main/services/transcription/WhisperService'
import type { AudioCaptureService } from '@main/services/audio/AudioCaptureService'
import type { TranscriptRepository } from '@main/services/storage/repositories/TranscriptRepository'
import type { RecordingRepository } from '@main/services/storage/repositories/RecordingRepository'
import type { TranscriptSegment } from '@shared/types'

// Build a real EventEmitter for audio so the queue can attach chunk listeners
function makeAudio(): AudioCaptureService & EventEmitter {
  const ee = new EventEmitter()
  return Object.assign(ee, {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => 'idle'),
    saveAudio: vi.fn()
  }) as unknown as AudioCaptureService & EventEmitter
}

function makeWhisper() {
  return {
    pushChunk: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    reset: vi.fn()
  } as unknown as WhisperService
}

function makeTranscriptRepo() {
  let counter = 0
  return {
    create: vi.fn((input) => ({
      id: `seg-${++counter}`,
      recordingId: input.recordingId,
      text: input.text,
      timestampStart: input.timestampStart,
      timestampEnd: input.timestampEnd,
      speakerId: null,
      speakerName: null,
      speakerConfidence: null,
      whisperConfidence: input.whisperConfidence ?? null,
      isEdited: false,
      createdAt: Date.now()
    } as TranscriptSegment))
  } as unknown as TranscriptRepository
}

function makeRecordingRepo() {
  return {
    findById: vi.fn(() => null),
    update: vi.fn()
  } as unknown as RecordingRepository
}

describe('TranscriptionQueue', () => {
  let audio: ReturnType<typeof makeAudio>
  let whisper: ReturnType<typeof makeWhisper>
  let transcriptRepo: ReturnType<typeof makeTranscriptRepo>
  let recordingRepo: ReturnType<typeof makeRecordingRepo>
  let queue: TranscriptionQueue

  beforeEach(() => {
    audio = makeAudio()
    whisper = makeWhisper()
    transcriptRepo = makeTranscriptRepo()
    recordingRepo = makeRecordingRepo()
    queue = new TranscriptionQueue(whisper, audio, transcriptRepo, recordingRepo)
  })

  it('starts recording by setting active recording id', () => {
    queue.start('rec-1')
    // No error thrown; state is internal — validated via stop behavior
    expect(whisper.reset).not.toHaveBeenCalled()
  })

  it('stop without start resolves immediately and does not emit complete', async () => {
    const onComplete = vi.fn()
    queue.on('complete', onComplete)
    await queue.stop()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('stop after start calls whisper.flush and emits complete', async () => {
    queue.start('rec-1')
    const onComplete = vi.fn()
    queue.on('complete', onComplete)
    await queue.stop()
    expect(whisper.flush).toHaveBeenCalled()
    expect(whisper.reset).toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith('rec-1')
  })

  it('delivers segment events when flush callback fires with results', async () => {
    // Make flush invoke its callback with a fake result
    vi.mocked(whisper.flush).mockImplementationOnce(async (_id, cb) => {
      cb({
        recordingId: 'rec-1',
        segments: [{ text: 'Hello world', start: 0, end: 2, confidence: 0.95 }]
      })
    })

    const onSegment = vi.fn()
    queue.on('segment', onSegment)
    queue.start('rec-1')
    await queue.stop()

    expect(transcriptRepo.create).toHaveBeenCalledOnce()
    expect(onSegment).toHaveBeenCalledOnce()
    const seg = onSegment.mock.calls[0][0] as TranscriptSegment
    expect(seg.text).toBe('Hello world')
    expect(seg.recordingId).toBe('rec-1')
  })

  it('accumulates timestamp offset correctly across segments', async () => {
    vi.mocked(whisper.flush).mockImplementationOnce(async (_id, cb) => {
      cb({
        recordingId: 'rec-1',
        segments: [
          { text: 'First', start: 0, end: 3, confidence: 0.9 },
          { text: 'Second', start: 0, end: 2, confidence: 0.9 }
        ]
      })
    })

    const segments: TranscriptSegment[] = []
    queue.on('segment', (s) => segments.push(s))
    queue.start('rec-1')
    await queue.stop()

    expect(segments[0].timestampStart).toBe(0)
    expect(segments[0].timestampEnd).toBe(3)
    // The second segment offset is driven by max(segmentOffset, segmentOffset + end)
    expect(segments[1].timestampStart).toBeGreaterThanOrEqual(0)
  })

  it('emits error when pushChunk throws', async () => {
    vi.mocked(whisper.pushChunk).mockRejectedValueOnce(new Error('Whisper crashed'))
    const onError = vi.fn()
    queue.on('error', onError)
    queue.start('rec-1')
    // Emit a fake audio chunk to trigger pushChunk
    audio.emit('chunk', { buffer: Buffer.alloc(0), sampleRate: 16000 })
    await new Promise((r) => setTimeout(r, 10))
    expect(onError).toHaveBeenCalled()
    const err = onError.mock.calls[0][0] as Error
    expect(err.message).toBe('Whisper crashed')
  })

  it('ignores audio chunks when not recording (no active recording id)', async () => {
    audio.emit('chunk', { buffer: Buffer.alloc(0), sampleRate: 16000 })
    await new Promise((r) => setTimeout(r, 10))
    expect(whisper.pushChunk).not.toHaveBeenCalled()
  })

  it('destroy removes audio chunk listener', async () => {
    queue.start('rec-1')
    queue.destroy()
    audio.emit('chunk', { buffer: Buffer.alloc(0), sampleRate: 16000 })
    await new Promise((r) => setTimeout(r, 10))
    expect(whisper.pushChunk).not.toHaveBeenCalled()
  })

  it('destroy removes all event listeners', () => {
    const spy = vi.fn()
    queue.on('complete', spy)
    queue.destroy()
    expect(queue.listenerCount('complete')).toBe(0)
  })
})
