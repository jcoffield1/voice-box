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

function makeRecording(overrides?: Partial<Recording>): Recording {
  return {
    id: 'rec-1',
    title: 'Test Recording',
    createdAt: Date.now() - 5000,
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
    update: vi.fn((id: string, patch: Partial<Recording>) => ({ ...recording, ...patch })),
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
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(null)
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
    vi.mocked(deps.audio.getState).mockReturnValueOnce('error')
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

  // ── recording:export ─────────────────────────────────────────────────────

  it('export throws when recording does not exist', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(null)
    await expect(
      handlers[IPC.recording.export](evt, { recordingId: 'bad', format: 'txt' })
    ).rejects.toThrow('Recording not found')
  })

  it('export txt contains title header and formatted timestamps', async () => {
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'txt' })
    const { content, filename } = result as { content: string; filename: string }
    expect(filename).toMatch(/\.txt$/)
    expect(content).toContain('Test Recording')
    // Segment at 62.5s → [01:02]
    expect(content).toContain('[01:02]')
    expect(content).toContain('Alice')
    expect(content).toContain('Hello world')
  })

  it('export md contains markdown headers and bold timestamps', async () => {
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'md' })
    const { content, filename } = result as { content: string; filename: string }
    expect(filename).toMatch(/\.md$/)
    expect(content).toContain('# Test Recording')
    expect(content).toContain('**[01:02] Alice:**')
  })

  it('export srt produces numbered cue blocks with SRT timestamps', async () => {
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'srt' })
    const { content, filename } = result as { content: string; filename: string }
    expect(filename).toMatch(/\.srt$/)
    // Should start with cue number 1
    expect(content.trimStart()).toMatch(/^1\n/)
    // SRT timestamp format hh:mm:ss,mmm --> hh:mm:ss,mmm
    expect(content).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/)
    expect(content).toContain('Alice:')
  })

  it('export md includes summary section when recording has a summary', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(
      makeRecording({ summary: 'Key points here' })
    )
    const result = await handlers[IPC.recording.export](evt, { recordingId: 'rec-1', format: 'md' })
    const { content } = result as { content: string }
    expect(content).toContain('## Summary')
    expect(content).toContain('Key points here')
  })
})
