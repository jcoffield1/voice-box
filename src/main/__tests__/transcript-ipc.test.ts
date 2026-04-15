/**
 * transcript.ipc.ts handler tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import { registerTranscriptIpc } from '@main/ipc/transcript.ipc'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { TranscriptSegment, SpeakerProfile } from '@shared/types'
import type { SpeakerCandidate } from '@main/services/ai/SpeakerIdentificationService'

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
    voiceEmbedding: null,
    recordingCount: 0,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
    ...overrides
  } as SpeakerProfile
}

function makeDeps() {
  const transcriptRepo = {
    findByRecordingId: vi.fn(() => [makeSegment()]),
    updateText: vi.fn(() => makeSegment()),
    assignSpeakerByRawId: vi.fn(() => 2),
    assignSpeakerByRawIdWithConfidence: vi.fn(() => 0),
    updateSpeakerForSegment: vi.fn(),
    findTimeRangesForProfile: vi.fn(() => [] as Array<{ timestampStart: number; timestampEnd: number }>),
    findUnresolvedSpeakerClusters: vi.fn(() => [] as Array<{ rawLabel: string; segments: Array<{ timestampStart: number; timestampEnd: number }> }>),
    findNullSpeakerSegments: vi.fn(() => [] as Array<{ id: string; timestampStart: number; timestampEnd: number }>),
    findManuallyConfirmedSpeakers: vi.fn(() => [] as Array<{ speakerId: string; timeRanges: Array<{ start: number; end: number }> }>),
    assignSpeakerToSegmentWithConfidence: vi.fn(),
    // kept for back-compat with any existing callers
    assignSpeakerToNullSegments: vi.fn(() => 3)
  }
  const speakerRepo = {
    findByName: vi.fn(() => null as SpeakerProfile | null),
    findById: vi.fn(() => null as SpeakerProfile | null),
    create: vi.fn(() => makeSpeakerProfile()),
    incrementRecordingCount: vi.fn(),
    findAll: vi.fn(() => [] as SpeakerProfile[])
  }
  const recordingRepo = {
    // Return a recording with no audioPath so fire-and-forget learning is skipped
    findById: vi.fn(() => ({ id: 'rec-1', audioPath: null } as unknown as import('@shared/types').Recording))
  }
  const speakerIdService = {
    learnSpeaker: vi.fn(async () => {}),
    identifyBatch: vi.fn(async () => new Map<string, SpeakerCandidate[]>()),
    identifyFromAudio: vi.fn(async () => [] as SpeakerCandidate[])
  }
  const getWebContents = vi.fn(() => null as WebContents | null)
  return { transcriptRepo, speakerRepo, recordingRepo, speakerIdService, getWebContents } as unknown as Parameters<typeof registerTranscriptIpc>[0] & {
    transcriptRepo: typeof transcriptRepo
    speakerRepo: typeof speakerRepo
    recordingRepo: typeof recordingRepo
    speakerIdService: typeof speakerIdService
    getWebContents: typeof getWebContents
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

  it('assignSpeaker without speakerId calls updateSpeakerForSegment', async () => {
    vi.mocked(deps.speakerRepo.findByName).mockReturnValueOnce(null)
    vi.mocked(deps.speakerRepo.create).mockReturnValueOnce(makeSpeakerProfile())

    const result = await handlers[IPC.transcript.assignSpeaker](evt, {
      recordingId: 'rec-1',
      segmentId: 'seg-1',
      speakerId: null,
      speakerName: 'Alice'
    })

    expect(deps.transcriptRepo.updateSpeakerForSegment).toHaveBeenCalledWith(
      'seg-1',
      'spk-1',
      'Alice'
    )
    expect(deps.transcriptRepo.assignSpeakerByRawId).not.toHaveBeenCalled()
    expect((result as { updatedSegments: number }).updatedSegments).toBe(1)
  })

  it('assignSpeaker with empty string speakerId falls back to updateSpeakerForSegment', async () => {
    vi.mocked(deps.speakerRepo.findByName).mockReturnValueOnce(null)
    vi.mocked(deps.speakerRepo.create).mockReturnValueOnce(makeSpeakerProfile())

    await handlers[IPC.transcript.assignSpeaker](evt, {
      recordingId: 'rec-1',
      segmentId: 'seg-1',
      speakerId: '',
      speakerName: 'Alice'
    })

    // Empty string is falsy — should route to single-segment update path
    expect(deps.transcriptRepo.updateSpeakerForSegment).toHaveBeenCalledWith('seg-1', 'spk-1', 'Alice')
    expect(deps.transcriptRepo.assignSpeakerByRawId).not.toHaveBeenCalled()
  })

  // ── transcript:sweepSpeakers ─────────────────────────────────────────────

  it('sweepSpeakers returns updatedCount:0 when recording has no audioPath', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: null } as unknown as import('@shared/types').Recording
    )
    const result = await handlers[IPC.transcript.sweepSpeakers](evt, { recordingId: 'rec-1' })
    expect((result as { updatedCount: number }).updatedCount).toBe(0)
  })

  it('sweepSpeakers returns updatedCount:0 when no unresolved clusters or null segments', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    vi.mocked(deps.transcriptRepo.findUnresolvedSpeakerClusters).mockReturnValueOnce([])
    vi.mocked(deps.transcriptRepo.findNullSpeakerSegments).mockReturnValueOnce([])

    const result = await handlers[IPC.transcript.sweepSpeakers](evt, { recordingId: 'rec-1' })
    expect((result as { updatedCount: number }).updatedCount).toBe(0)
    expect(deps.speakerIdService.identifyBatch).not.toHaveBeenCalled()
  })

  it('sweepSpeakers auto-assigns null segments above confidence threshold', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    vi.mocked(deps.transcriptRepo.findUnresolvedSpeakerClusters).mockReturnValueOnce([])
    vi.mocked(deps.transcriptRepo.findNullSpeakerSegments).mockReturnValueOnce([
      { id: 'seg-null-1', timestampStart: 0, timestampEnd: 2 }
    ])
    vi.mocked(deps.speakerIdService.identifyBatch).mockResolvedValueOnce(
      new Map([['seg-null-1', [{ speakerId: 'spk-1', speakerName: 'Alice', confidence: 0.93 }]]])
    )

    const result = await handlers[IPC.transcript.sweepSpeakers](evt, { recordingId: 'rec-1' })
    expect((result as { updatedCount: number }).updatedCount).toBe(1)
    expect(deps.transcriptRepo.assignSpeakerToSegmentWithConfidence).toHaveBeenCalledWith(
      'seg-null-1', 'spk-1', 'Alice', 0.93
    )
  })

  it('sweepSpeakers does not assign null segments below confidence threshold', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    vi.mocked(deps.transcriptRepo.findUnresolvedSpeakerClusters).mockReturnValueOnce([])
    vi.mocked(deps.transcriptRepo.findNullSpeakerSegments).mockReturnValueOnce([
      { id: 'seg-null-1', timestampStart: 0, timestampEnd: 2 }
    ])
    vi.mocked(deps.speakerIdService.identifyBatch).mockResolvedValueOnce(
      new Map([['seg-null-1', [{ speakerId: 'spk-1', speakerName: 'Alice', confidence: 0.72 }]]])
    )

    const result = await handlers[IPC.transcript.sweepSpeakers](evt, { recordingId: 'rec-1' })
    expect((result as { updatedCount: number }).updatedCount).toBe(0)
    expect(deps.transcriptRepo.assignSpeakerToSegmentWithConfidence).not.toHaveBeenCalled()
  })

  it('sweepSpeakers sends speakersSwept event via getWebContents when count > 0', async () => {
    const sendMock = vi.fn()
    vi.mocked(deps.getWebContents).mockReturnValueOnce({ send: sendMock } as unknown as import('electron').WebContents)
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    vi.mocked(deps.transcriptRepo.findUnresolvedSpeakerClusters).mockReturnValueOnce([])
    vi.mocked(deps.transcriptRepo.findNullSpeakerSegments).mockReturnValueOnce([
      { id: 'seg-null-1', timestampStart: 0, timestampEnd: 2 }
    ])
    vi.mocked(deps.speakerIdService.identifyBatch).mockResolvedValueOnce(
      new Map([['seg-null-1', [{ speakerId: 'spk-1', speakerName: 'Alice', confidence: 0.91 }]]])
    )
    vi.mocked(deps.transcriptRepo.findByRecordingId).mockReturnValueOnce([
      makeSegment({ speakerId: 'spk-1', speakerName: 'Alice' })
    ])

    await handlers[IPC.transcript.sweepSpeakers](evt, { recordingId: 'rec-1' })
    expect(sendMock).toHaveBeenCalledWith(
      IPC.transcript.speakersSwept,
      expect.objectContaining({ recordingId: 'rec-1' })
    )
  })

  it('sweepSpeakers does not send event when updatedCount is 0', async () => {
    const sendMock = vi.fn()
    vi.mocked(deps.getWebContents).mockReturnValueOnce({ send: sendMock } as unknown as import('electron').WebContents)
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    vi.mocked(deps.transcriptRepo.findUnresolvedSpeakerClusters).mockReturnValueOnce([])
    vi.mocked(deps.transcriptRepo.findNullSpeakerSegments).mockReturnValueOnce([])

    await handlers[IPC.transcript.sweepSpeakers](evt, { recordingId: 'rec-1' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  // ── transcript:rankSpeakers ──────────────────────────────────────────────

  it('rankSpeakers returns empty candidates when recording has no audioPath', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: null } as unknown as import('@shared/types').Recording
    )
    const result = await handlers[IPC.transcript.rankSpeakers](evt, {
      recordingId: 'rec-1',
      segmentId: 'seg-1'
    })
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(0)
  })

  it('rankSpeakers returns empty candidates when segment not found in recording', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    vi.mocked(deps.transcriptRepo.findByRecordingId).mockReturnValueOnce([])

    const result = await handlers[IPC.transcript.rankSpeakers](evt, {
      recordingId: 'rec-1',
      segmentId: 'no-such-segment'
    })
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(0)
  })

  it('rankSpeakers merges confirmed-in-recording speakers not in voice results', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    // findByRecordingId is called twice in rankSpeakers — once for segment lookup, once for confirmed set
    const twoSegments = [
      makeSegment({ id: 'seg-1', speakerId: 'SPEAKER_00', speakerName: 'SPEAKER_00' }),
      makeSegment({ id: 'seg-2', speakerId: 'spk-jason', speakerName: 'Jason' })
    ]
    vi.mocked(deps.transcriptRepo.findByRecordingId)
      .mockReturnValueOnce(twoSegments)
      .mockReturnValueOnce(twoSegments)
    // Voice matching returns nothing (no embedding yet for Jason)
    vi.mocked(deps.speakerIdService.identifyFromAudio).mockResolvedValueOnce([])

    const result = await handlers[IPC.transcript.rankSpeakers](evt, {
      recordingId: 'rec-1',
      segmentId: 'seg-1'
    })
    const candidates = (result as { candidates: Array<{ speakerId: string; isVoiceMatch: boolean; confidence: number }> }).candidates
    const jasonEntry = candidates.find((c) => c.speakerId === 'spk-jason')
    expect(jasonEntry).toBeDefined()
    expect(jasonEntry!.isVoiceMatch).toBe(false)
    expect(jasonEntry!.confidence).toBe(0)
  })

  it('rankSpeakers does not duplicate a confirmed speaker already in voice results', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      { id: 'rec-1', audioPath: '/tmp/test.wav' } as unknown as import('@shared/types').Recording
    )
    const twoSegments = [
      makeSegment({ id: 'seg-1', speakerId: 'SPEAKER_00', speakerName: 'SPEAKER_00' }),
      makeSegment({ id: 'seg-2', speakerId: 'spk-alice', speakerName: 'Alice' })
    ]
    vi.mocked(deps.transcriptRepo.findByRecordingId)
      .mockReturnValueOnce(twoSegments)
      .mockReturnValueOnce(twoSegments)
    // Voice matching returns Alice with an embedding match
    vi.mocked(deps.speakerIdService.identifyFromAudio).mockResolvedValueOnce([
      { speakerId: 'spk-alice', speakerName: 'Alice', confidence: 0.88 }
    ])

    const result = await handlers[IPC.transcript.rankSpeakers](evt, {
      recordingId: 'rec-1',
      segmentId: 'seg-1'
    })
    const candidates = (result as { candidates: Array<{ speakerId: string }> }).candidates
    const aliceEntries = candidates.filter((c) => c.speakerId === 'spk-alice')
    expect(aliceEntries).toHaveLength(1)
  })
})
