/**
 * ai.ipc.ts handler tests — summarize and buildTranscriptContext
 *
 * Only the summarize handler is unit-tested here.  The chat handler has many
 * branches (intent classification, RAG, streaming) that are better covered by
 * integration / E2E tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import { registerAiIpc } from '@main/ipc/ai.ipc'
import type { IpcMainInvokeEvent } from 'electron'
import type { Recording, TranscriptSegment } from '@shared/types'

const evt = {} as IpcMainInvokeEvent

function captureHandlers() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers[channel as string] = handler as (...args: unknown[]) => unknown
    return ipcMain
  })
  return handlers
}

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'rec-1',
    title: 'Standup Notes',
    createdAt: Date.now() - 300_000,
    status: 'complete',
    duration: 300,
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

function makeSegments(): TranscriptSegment[] {
  return [
    {
      id: 'seg-1',
      recordingId: 'rec-1',
      text: 'Good morning everyone.',
      speakerId: 'spk-1',
      speakerName: 'Alice',
      speakerConfidence: null,
      timestampStart: 0,
      timestampEnd: 3,
      whisperConfidence: null,
      isEdited: false,
      createdAt: Date.now()
    },
    {
      id: 'seg-2',
      recordingId: 'rec-1',
      text: 'Shipping today.',
      speakerId: 'spk-2',
      speakerName: 'Bob',
      speakerConfidence: null,
      timestampStart: 65,
      timestampEnd: 68,
      whisperConfidence: null,
      isEdited: false,
      createdAt: Date.now()
    }
  ]
}

function makeDeps() {
  const llm = {
    complete: vi.fn(async () => ({
      text: '## Summary\n\n- Key point one\n- Key point two',
      model: 'gpt-4o-mini',
      provider: 'openai'
    }))
  }
  const conversationRepo = {
    findThreadById: vi.fn(() => ({ id: 'thread-1', title: null, createdAt: Date.now(), updatedAt: Date.now() })),
    addMessage: vi.fn((threadId: string, role: string, content: string) => ({
      id: 'msg-1',
      threadId,
      role,
      content,
      createdAt: Date.now()
    })),
    updateTitle: vi.fn()
  }
  const recordingRepo = {
    findById: vi.fn(() => makeRecording()),
    update: vi.fn((id: string, patch: Partial<Recording>) => ({ ...makeRecording(), ...patch }))
  }
  const transcriptRepo = {
    findByRecordingId: vi.fn(() => makeSegments()),
    findAllWithContext: vi.fn(() => []),
    assignSpeakerByRawId: vi.fn(() => 0)
  }
  const speakerRepo = {
    findByName: vi.fn(() => null),
    create: vi.fn(() => ({ id: 'spk-new', name: 'Test', notes: null, createdAt: Date.now() }))
  }
  const searchService = {
    query: vi.fn(async () => [])
  }
  const getWebContents = vi.fn(() => null)

  return {
    llm,
    conversationRepo,
    recordingRepo,
    transcriptRepo,
    speakerRepo,
    searchService,
    getWebContents
  } as unknown as Parameters<typeof registerAiIpc>[0] & {
    llm: typeof llm
    conversationRepo: typeof conversationRepo
    recordingRepo: typeof recordingRepo
    transcriptRepo: typeof transcriptRepo
  }
}

describe('registerAiIpc — ai:summarize', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
    handlers = captureHandlers()
    deps = makeDeps()
    registerAiIpc(deps)
  })

  it('throws when the recording does not exist', async () => {
    vi.mocked(deps.recordingRepo.findById).mockReturnValueOnce(null)
    await expect(
      handlers[IPC.ai.summarize](evt, { recordingId: 'missing' })
    ).rejects.toThrow('Recording not found')
  })

  it('calls LLM with a system prompt and the transcript context', async () => {
    await handlers[IPC.ai.summarize](evt, { recordingId: 'rec-1' })
    expect(deps.llm.complete).toHaveBeenCalledOnce()
    const [feature, req] = vi.mocked(deps.llm.complete).mock.calls[0]
    expect(feature).toBe('summarization')
    expect(req.systemPrompt).toContain('Summarize')
    // The user message should contain the recording title and formatted transcript
    expect(req.messages[0].content).toContain('Standup Notes')
    // Segment at 65s → [1:05]
    expect(req.messages[0].content).toContain('[1:05]')
    expect(req.messages[0].content).toContain('Bob')
  })

  it('builds transcript context with [MM:SS] Speaker: text format', async () => {
    await handlers[IPC.ai.summarize](evt, { recordingId: 'rec-1' })
    const [, req] = vi.mocked(deps.llm.complete).mock.calls[0]
    expect(req.messages[0].content).toContain('[0:00] Alice: Good morning everyone.')
    expect(req.messages[0].content).toContain('[1:05] Bob: Shipping today.')
  })

  it('persists the summary in the recording after LLM response', async () => {
    await handlers[IPC.ai.summarize](evt, { recordingId: 'rec-1' })
    expect(deps.recordingRepo.update).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        summary: expect.stringContaining('## Summary'),
        summaryModel: 'gpt-4o-mini',
        summaryAt: expect.any(Number)
      })
    )
  })

  it('returns summary text, model and provider', async () => {
    const result = await handlers[IPC.ai.summarize](evt, { recordingId: 'rec-1' })
    const r = result as { summary: string; model: string; provider: string }
    expect(r.summary).toContain('Key point one')
    expect(r.model).toBe('gpt-4o-mini')
    expect(r.provider).toBe('openai')
  })

  it('segments with unknown speaker are labelled "Unknown"', async () => {
    vi.mocked(deps.transcriptRepo.findByRecordingId).mockReturnValueOnce([
      {
        id: 'seg-x',
        recordingId: 'rec-1',
        text: 'Anonymous text',
        speakerId: null,
        speakerName: null,
        speakerConfidence: null,
        timestampStart: 10,
        timestampEnd: 12,
        whisperConfidence: null,
        isEdited: false,
        createdAt: Date.now()
      }
    ])
    await handlers[IPC.ai.summarize](evt, { recordingId: 'rec-1' })
    const [, req] = vi.mocked(deps.llm.complete).mock.calls[0]
    expect(req.messages[0].content).toContain('Unknown: Anonymous text')
  })
})
