/**
 * recording.ipc.ts handler tests
 *
 * Strategy: capture ipcMain.handle calls via the test-setup mock, then invoke
 * the captured handlers directly — no real Electron process needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain, app } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/ipc-types'
import { registerRecordingIpc } from '@main/ipc/recording.ipc'
import type { Recording } from '@shared/types'
import type { IpcMainInvokeEvent } from 'electron'

// ─── helpers ─────────────────────────────────────────────────────────────────

const evt = {} as IpcMainInvokeEvent

// Fixed timestamp so makeRecording() always returns the same value regardless
// of when it is called, preventing 1ms flakiness in toEqual assertions.
const FIXED_CREATED_AT = 1_700_000_000_000

function makeRecording(overrides?: Partial<Recording>): Recording {
  return {
    id: 'rec-1',
    title: 'Test Recording',
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
    status: 'complete',
    duration: 5,
    audioPath: null,
    summary: null,
    summaryModel: null,
    summaryAt: null,
    debrief: null,
    debriefAt: null,
    notes: null,
    tags: [],
    ...overrides
  }
}

function makeSegment(overrides = {}) {
  return {
    id: 'seg-1',
    recordingId: 'rec-1',
    text: 'Hello world',
    speakerId: null,
    speakerName: 'Alice',
    speakerConfidence: null,
    timestampStart: 62.5,
    timestampEnd: 65.0,
    whisperConfidence: null,
    isEdited: false,
    createdAt: Date.now(),
    ...overrides
  }
}

function captureHandlers() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers[channel as string] = handler as (...args: unknown[]) => unknown
    return ipcMain
  })
  return handlers
}

function makeDeps() {
  const recording = makeRecording()
  const recordingRepo = {
    create: vi.fn(() => recording),
    findById: vi.fn(() => recording),
    findAll: vi.fn(() => [recording]),
    update: vi.fn((_id: string, patch: Partial<Recording>) => ({ ...recording, ...patch })),
    delete: vi.fn()
  }
  const transcriptRepo = {
    findByRecordingId: vi.fn(() => [makeSegment()])
  }
  const audio = {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => 'idle' as const),
    saveAudio: vi.fn()
  }
  const queue = {
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => {})
  }
  const getWebContents = vi.fn(() => null)

  return { recordingRepo, transcriptRepo, audio, queue, getWebContents } as unknown as Parameters<
    typeof registerRecordingIpc
  >[0] & {
    recordingRepo: typeof recordingRepo
    transcriptRepo: typeof transcriptRepo
    audio: typeof audio
    queue: typeof queue
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('registerRecordingIpc', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
    handlers = captureHandlers()
    deps = makeDeps()
    registerRecordingIpc(deps)
  })

  // ── recording:getAll ────────────────────────────────────────────────────

  it('getAll returns all recordings', async () => {
    const result = await handlers[IPC.recording.getAll](evt)
    expect(result).toEqual({ recordings: [makeRecording()] })
    expect(deps.recordingRepo.findAll).toHaveBeenCalledOnce()
  })

  // ── recording:get ───────────────────────────────────────────────────────

  it('get returns the recording by id', async () => {
    const result = await handlers[IPC.recording.get](evt, { recordingId: 'rec-1' })
    expect(result).toEqual({ recording: makeRecording() })
    expect(deps.recordingRepo.findById).toHaveBeenCalledWith('rec-1')
  })

  it('get returns null for unknown id', async () => {
    vi.mocked(deps.recordingRepo.findById).mockImplementationOnce(() => null as unknown as Recording)
    const result = await handlers[IPC.recording.get](evt, { recordingId: 'bad' })
    expect(result).toEqual({ recording: null })
  })

  // ── recording:update ────────────────────────────────────────────────────

  it('update persists title, notes and tags', async () => {
    const patch = { recordingId: 'rec-1', title: 'New Title', notes: 'My notes', tags: ['work'] }
    await handlers[IPC.recording.update](evt, patch)
    expect(deps.recordingRepo.update).toHaveBeenCalledWith('rec-1', {
      title: 'New Title',
      notes: 'My notes',
      tags: ['work']
    })
  })

  it('update returns updated recording', async () => {
    vi.mocked(deps.recordingRepo.update).mockReturnValueOnce(makeRecording({ title: 'Renamed' }))
    const result = await handlers[IPC.recording.update](evt, { recordingId: 'rec-1', title: 'Renamed' })
    expect((result as { recording: Recording }).recording.title).toBe('Renamed')
  })

  // ── recording:delete ────────────────────────────────────────────────────

  it('delete calls repo.delete with id', async () => {
    await handlers[IPC.recording.delete](evt, { recordingId: 'rec-1' })
    expect(deps.recordingRepo.delete).toHaveBeenCalledWith('rec-1')
  })

  // ── recording:start ─────────────────────────────────────────────────────

  it('start creates a recording and starts queue', async () => {
    const result = await handlers[IPC.recording.start](evt, {
      title: 'New Recording',
      config: { deviceId: null, sampleRate: 16000, channelCount: 1 }
    })
    expect(deps.recordingRepo.create).toHaveBeenCalledWith('New Recording')
    expect(deps.audio.start).toHaveBeenCalled()
    expect(deps.queue.start).toHaveBeenCalledWith('rec-1')
    expect(result).toEqual({ recordingId: 'rec-1' })
  })

  it('start throws and marks recording as error if audio fails to open', async () => {
    vi.mocked(deps.audio.getState).mockImplementationOnce(() => 'error' as unknown as ReturnType<typeof deps.audio.getState>)
    await expect(
      handlers[IPC.recording.start](evt, {
        title: 'Fail',
        config: { deviceId: null, sampleRate: 16000, channelCount: 1 }
      })
    ).rejects.toThrow('Failed to open audio device')
    expect(deps.recordingRepo.update).toHaveBeenCalledWith('rec-1', { status: 'error' })
    // Queue should NOT have been started
    expect(deps.queue.start).not.toHaveBeenCalled()
  })

  // ── recording:stop ──────────────────────────────────────────────────────

  it('stop saves audio, calculates duration and marks recording complete', async () => {
    const result = await handlers[IPC.recording.stop](evt, { recordingId: 'rec-1' })
    expect(deps.audio.stop).toHaveBeenCalled()
    expect(deps.queue.stop).toHaveBeenCalled()
    expect(deps.audio.saveAudio).toHaveBeenCalledWith(
      join(app.getPath('userData'), 'recordings', 'rec-1.wav')
    )
    expect(deps.recordingRepo.update).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({ status: 'complete', audioPath: expect.stringContaining('rec-1.wav') })
    )
    expect((result as { recordingId: string }).recordingId).toBe('rec-1')
  })

  // ── recording:export (transcript) ───────────────────────────────────────

  it('export throws when recording does not exist', async () => {
    vi.mocked(deps.recordingRepo.findById).mockImplementationOnce(() => null as unknown as Recording)
    await expect(
      handlers[IPC.recording.export](evt, { recordingId: 'bad', format: 'txt' })
    ).rejects.toThrow('Recording not found')
  })

  it('export txt returns content with title, timestamp and speaker', async () => {
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'txt' })
    const { content, filename } = result as { content: string; filename: string }
    expect(filename).toBe('Test Recording.txt')
    expect(content).toContain('Test Recording')
    expect(content).toContain('[01:02]')
    expect(content).toContain('Alice')
    expect(content).toContain('Hello world')
  })

  it('export md returns markdown with header and bold timestamp', async () => {
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'md' })
    const { content, filename } = result as { content: string; filename: string }
    expect(filename).toBe('Test Recording.md')
    expect(content).toContain('# Test Recording')
    expect(content).toContain('**[01:02] Alice:**')
    expect(content).toContain('Hello world')
  })

  it('export srt returns numbered cue with hh:mm:ss,mmm timestamps', async () => {
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'srt' })
    const { content, filename } = result as { content: string; filename: string }
    expect(filename).toBe('Test Recording.srt')
    expect(content).toContain('1\n')
    // 62.5s start → 00:01:02,500   65.0s end → 00:01:05,000
    expect(content).toContain('00:01:02,500 --> 00:01:05,000')
    expect(content).toContain('Alice:')
    expect(content).toContain('Hello world')
  })

  // ── recording:exportSummary ───────────────────────────────────────────────

  it('exportSummary throws when recording does not exist', async () => {
    vi.mocked(deps.recordingRepo.findById).mockImplementationOnce(() => null as unknown as Recording)
    await expect(
      handlers[IPC.recording.exportSummary](evt, { recordingId: 'bad', format: 'txt' })
    ).rejects.toThrow('Recording not found')
  })

  it('exportSummary returns null savedTo when user cancels', async () => {
    const { dialog } = await import('electron')
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ filePath: undefined as unknown as string, canceled: true })
    const result = await handlers[IPC.recording.exportSummary](evt, { recordingId: 'rec-1', format: 'txt' })
    expect((result as { savedTo: string | null }).savedTo).toBeNull()
  })

  it('exportSummary txt writes summary content to file', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      makeRecording({ debrief: 'Key points here' })
    )
    const { promises: fsPromises } = await import('fs')
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockResolvedValue()
    const result = await handlers[IPC.recording.exportSummary](evt, { recordingId: 'rec-1', format: 'txt' })
    expect((result as { savedTo: string }).savedTo).toBe('/tmp/test-export-output')
    expect(writeSpy).toHaveBeenCalledOnce()
    const written = writeSpy.mock.calls[0][1] as string
    expect(written).toContain('Test Recording')
    expect(written).toContain('Key points here')
    writeSpy.mockRestore()
  })

  it('exportSummary md writes markdown with summary heading', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      makeRecording({ debrief: 'Key points here' })
    )
    const { promises: fsPromises } = await import('fs')
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockResolvedValue()
    await handlers[IPC.recording.exportSummary](evt, { recordingId: 'rec-1', format: 'md' })
    const written = writeSpy.mock.calls[0][1] as string
    expect(written).toContain('# Test Recording')
    expect(written).toContain('## Summary')
    expect(written).toContain('Key points here')
    // Must NOT contain Transcript section
    expect(written).not.toContain('## Transcript')
    writeSpy.mockRestore()
  })
})
