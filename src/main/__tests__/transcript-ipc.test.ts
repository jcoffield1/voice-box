/**
 * transcript.ipc.ts handler tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import { registerTranscriptIpc } from '@main/ipc/transcript.ipc'
import type { IpcMainInvokeEvent } from 'electron'
import type { TranscriptSegment, SpeakerProfile } from '@shared/types'

const evt = {} as IpcMainInvokeEvent

function captureHandlers() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers[channel as string] = handler as (...args: unknown[]) => unknown
    return ipcMain
  })
  return handlers
}

function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    recordingId: 'rec-1',
    text: 'Hello',
    speakerId: null,
    speakerName: null,
    speakerConfidence: null,
    timestampStart: 0,
    timestampEnd: 1,
    whisperConfidence: null,
    isEdited: false,
    createdAt: Date.now(),
    ...overrides
  }
}

function makeSpeakerProfile(overrides: Partial<SpeakerProfile> = {}): SpeakerProfile {
  return {
    id: 'spk-1',
    name: 'Alice',
    notes: null,
    createdAt: Date.now(),
    ...overrides
  }
}

function makeDeps() {
  const transcriptRepo = {
    findByRecordingId: vi.fn(() => [makeSegment()]),
    updateText: vi.fn(() => makeSegment()),
    assignSpeakerByRawId: vi.fn(() => 2),
    assignSpeakerToNullSegments: vi.fn(() => 3)
  }
  const speakerRepo = {
    findByName: vi.fn(() => null as SpeakerProfile | null),
    create: vi.fn(() => makeSpeakerProfile())
  }
  return { transcriptRepo, speakerRepo } as unknown as Parameters<typeof registerTranscriptIpc>[0] & {
    transcriptRepo: typeof transcriptRepo
    speakerRepo: typeof speakerRepo
  }
}

describe('registerTranscriptIpc', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
    handlers = captureHandlers()
    deps = makeDeps()
    registerTranscriptIpc(deps)
  })

  // ── transcript:get ──────────────────────────────────────────────────────

  it('get returns all segments for a recording', async () => {
    const result = await handlers[IPC.transcript.get](evt, { recordingId: 'rec-1' })
    expect(deps.transcriptRepo.findByRecordingId).toHaveBeenCalledWith('rec-1')
    expect((result as { segments: TranscriptSegment[] }).segments).toHaveLength(1)
  })

  // ── transcript:updateSegment ────────────────────────────────────────────

  it('updateSegment calls repo.updateText with the new text', async () => {
    await handlers[IPC.transcript.updateSegment](evt, { segmentId: 'seg-1', text: 'Corrected' })
    expect(deps.transcriptRepo.updateText).toHaveBeenCalledWith('seg-1', 'Corrected')
  })

  // ── transcript:assignSpeaker with speakerId ─────────────────────────────

  it('assignSpeaker with speakerId calls assignSpeakerByRawId', async () => {
    vi.mocked(deps.speakerRepo.findByName).mockReturnValueOnce(null)
    vi.mocked(deps.speakerRepo.create).mockReturnValueOnce(makeSpeakerProfile())

    const result = await handlers[IPC.transcript.assignSpeaker](evt, {
      recordingId: 'rec-1',
      speakerId: 'SPEAKER_00',
      speakerName: 'Alice'
    })

    expect(deps.speakerRepo.create).toHaveBeenCalledWith('Alice')
    expect(deps.transcriptRepo.assignSpeakerByRawId).toHaveBeenCalledWith(
      'rec-1',
      'SPEAKER_00',
      'spk-1',
      'Alice'
    )
    expect((result as { updatedSegments: number }).updatedSegments).toBe(2)
  })

  it('assignSpeaker reuses an existing speaker profile instead of creating a duplicate', async () => {
    const existing = makeSpeakerProfile({ id: 'spk-existing', name: 'Alice' })
    vi.mocked(deps.speakerRepo.findByName).mockReturnValueOnce(existing)

    await handlers[IPC.transcript.assignSpeaker](evt, {
      recordingId: 'rec-1',
      speakerId: 'SPEAKER_00',
      speakerName: 'Alice'
    })

    // create should NOT be called — profile already existed
    expect(deps.speakerRepo.create).not.toHaveBeenCalled()
    expect(deps.transcriptRepo.assignSpeakerByRawId).toHaveBeenCalledWith(
      'rec-1',
      'SPEAKER_00',
      'spk-existing',
      'Alice'
    )
  })

  // ── transcript:assignSpeaker without speakerId (no diarization) ─────────

  it('assignSpeaker without speakerId calls assignSpeakerToNullSegments', async () => {
    vi.mocked(deps.speakerRepo.findByName).mockReturnValueOnce(null)
    vi.mocked(deps.speakerRepo.create).mockReturnValueOnce(makeSpeakerProfile())

    const result = await handlers[IPC.transcript.assignSpeaker](evt, {
      recordingId: 'rec-1',
      speakerId: null,
      speakerName: 'Alice'
    })

    expect(deps.transcriptRepo.assignSpeakerToNullSegments).toHaveBeenCalledWith(
      'rec-1',
      'spk-1',
      'Alice'
    )
    expect(deps.transcriptRepo.assignSpeakerByRawId).not.toHaveBeenCalled()
    expect((result as { updatedSegments: number }).updatedSegments).toBe(3)
  })

  it('assignSpeaker with empty string speakerId falls back to null path', async () => {
    vi.mocked(deps.speakerRepo.findByName).mockReturnValueOnce(null)
    vi.mocked(deps.speakerRepo.create).mockReturnValueOnce(makeSpeakerProfile())

    await handlers[IPC.transcript.assignSpeaker](evt, {
      recordingId: 'rec-1',
      speakerId: '',
      speakerName: 'Alice'
    })

    // Empty string is falsy — should route to null segments path
    expect(deps.transcriptRepo.assignSpeakerToNullSegments).toHaveBeenCalled()
  })
})
