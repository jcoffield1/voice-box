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
    })),
    stream: vi.fn(async function* () { yield 'Mock response chunk.' })
  }
  const conversationRepo = {
    findThreadById: vi.fn(() => ({ id: 'thread-1', title: null, createdAt: Date.now(), updatedAt: Date.now() })),
    findMessagesByThread: vi.fn(() => []),
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

// ─── buildRagContext / chat templateId scoping ────────────────────────────────

describe('registerAiIpc — ai:chat template scoping', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
    handlers = captureHandlers()
    deps = makeDeps()
    registerAiIpc(deps)
  })

  it('passes templateId to searchService.query when provided', async () => {
    // searchService.query returns empty → falls back to general-knowledge reply via LLM
    vi.mocked(deps.searchService.query).mockResolvedValueOnce([])

    await handlers[IPC.ai.chat](evt, {
      threadId: 'thread-1',
      message: 'What did we discuss?',
      recordingId: null,
      model: 'gpt-4o',
      provider: 'openai',
      templateId: 'tpl-sales'
    })

    expect(deps.searchService.query).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-sales' })
    )
  })

  it('passes templateId: null to searchService.query for default-template scope', async () => {
    vi.mocked(deps.searchService.query).mockResolvedValueOnce([])

    await handlers[IPC.ai.chat](evt, {
      threadId: 'thread-1',
      message: 'Summary please',
      recordingId: null,
      model: 'gpt-4o',
      provider: 'openai',
      templateId: null
    })

    expect(deps.searchService.query).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: null })
    )
  })

  it('injects templateName into the system prompt when search returns results', async () => {
    vi.mocked(deps.searchService.query).mockResolvedValueOnce([
      {
        segmentId: 'seg-1',
        recordingId: 'rec-1',
        recordingTitle: 'Q1 Sales Call',
        recordingNotes: null,
        recordingTags: [],
        text: 'Pipeline looks strong this quarter.',
        speakerName: 'Alice',
        timestampStart: 10,
        timestampEnd: 14,
        templateId: 'tpl-sales',
        score: 0.9,
        matchType: 'keyword',
        snippet: 'Pipeline looks strong this quarter.'
      }
    ])

    await handlers[IPC.ai.chat](evt, {
      threadId: 'thread-1',
      message: 'How is the pipeline?',
      recordingId: null,
      model: 'gpt-4o',
      provider: 'openai',
      templateId: 'tpl-sales',
      templateName: 'Sales Calls'
    })

    const [, req] = vi.mocked(deps.llm.stream).mock.calls[0]
    expect(req.systemPrompt).toContain('Sales Calls')
    // Should NOT draw on general knowledge
    expect(req.systemPrompt).toMatch(/ONLY|only/)
  })

  it('does not pass templateId to searchService.query when no scoping is requested', async () => {
    vi.mocked(deps.searchService.query).mockResolvedValueOnce([])

    await handlers[IPC.ai.chat](evt, {
      threadId: 'thread-1',
      message: 'Tell me about the meetings',
      recordingId: null,
      model: 'gpt-4o',
      provider: 'openai'
      // no templateId
    })

    const callArg = vi.mocked(deps.searchService.query).mock.calls[0]?.[0]
    expect(callArg).not.toHaveProperty('templateId')
  })
})
