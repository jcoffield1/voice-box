import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  SummarizeArgs,
  SummarizeResult,
  ChatArgs,
  ChatResult,
  GetThreadArgs,
  GetThreadResult,
  GetThreadsResult,
  CreateThreadArgs,
  CreateThreadResult,
  DeleteThreadArgs,
  UpdateThreadTitleArgs,
  GetModelsArgs,
  GetModelsResult,
  TestProviderArgs,
  TestProviderResult
} from '@shared/ipc-types'
import type { LLMService } from '../services/llm/LLMService'
import type { ConversationRepository } from '../services/storage/repositories/ConversationRepository'
import type { RecordingRepository } from '../services/storage/repositories/RecordingRepository'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { SpeakerRepository } from '../services/storage/repositories/SpeakerRepository'
import type { SearchService } from '../services/search/SearchService'
import type { WebContents } from 'electron'
import type { TranscriptSegment } from '@shared/types'
import { estimateTokens } from '../services/llm/providers/LLMProvider'
import { classifyIntent, refToSpeakerLabel } from '../services/ai/IntentClassifier'

const MAX_CONTEXT_TOKENS = 100_000

function buildTranscriptContext(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const ts = `${Math.floor(s.timestampStart / 60)}:${String(Math.floor(s.timestampStart % 60)).padStart(2, '0')}`
      const speaker = s.speakerName ?? 'Unknown'
      return `[${ts}] ${speaker}: ${s.text}`
    })
    .join('\n')
}

const RAG_CONTEXT_RESULTS = 8 // max segments to inject for cross-recording chat

async function buildRagContext(query: string, search: SearchService): Promise<string> {
  try {
    const results = await search.query({ query, limit: RAG_CONTEXT_RESULTS })
    if (results.length === 0) return ''
    const lines = results.map((r) => {
      const ts = `${Math.floor(r.timestampStart / 60)}:${String(Math.floor(r.timestampStart % 60)).padStart(2, '0')}`
      const speaker = r.speakerName ? `${r.speakerName}: ` : ''
      return `[${r.recordingTitle} @ ${ts}] ${speaker}${r.text}`
    })
    return `RELEVANT TRANSCRIPT EXCERPTS (from ${new Set(results.map((r) => r.recordingId)).size} recording(s)):
${lines.join('\n')}`
  } catch {
    return ''
  }
}

interface AiIpcDeps {
  llm: LLMService
  conversationRepo: ConversationRepository
  recordingRepo: RecordingRepository
  transcriptRepo: TranscriptRepository
  speakerRepo: SpeakerRepository
  searchService: SearchService
  getWebContents: () => WebContents | null
}

export function registerAiIpc(deps: AiIpcDeps): void {
  const { llm, conversationRepo, recordingRepo, transcriptRepo, speakerRepo, searchService, getWebContents } = deps

  ipcMain.handle(IPC.ai.summarize, async (_event, args: SummarizeArgs): Promise<SummarizeResult> => {
    const recording = recordingRepo.findById(args.recordingId)
    if (!recording) throw new Error(`Recording not found: ${args.recordingId}`)

    const segments = transcriptRepo.findByRecordingId(args.recordingId)
    const transcript = buildTranscriptContext(segments)

    const systemPrompt = `You are a helpful assistant. Summarize the following call transcript.
Structure your response with:
1. Key Points (bullet list)
2. Decisions Made
3. Action Items
4. Participants and their roles`

    const response = await llm.complete('summarization', {
      systemPrompt,
      messages: [
        { role: 'user', content: `Please summarize this call titled "${recording.title}":\n\n${transcript}` }
      ]
    })

    // Persist summary
    recordingRepo.update(args.recordingId, {
      summary: response.text,
      summaryModel: response.model,
      summaryAt: Date.now()
    })

    return {
      summary: response.text,
      model: response.model,
      provider: response.provider
    }
  })

  ipcMain.handle(IPC.ai.chat, async (_event, args: ChatArgs): Promise<ChatResult> => {
    const thread = conversationRepo.findThreadById(args.threadId)
    if (!thread) throw new Error(`Thread not found: ${args.threadId}`)

    // ── Intent classification ─────────────────────────────────────────────
    // Detect labeling commands like "Speaker 1 is Jon Smith" and execute them
    // directly without invoking the LLM (with a confirmation message back).
    if (args.recordingId) {
      const intent = classifyIntent(args.message)
      if (intent?.type === 'label_speaker') {
        const rawLabel = refToSpeakerLabel(intent.speakerRef)
        // Find or create the speaker profile
        let speaker = speakerRepo.findByName(intent.name)
        if (!speaker) speaker = speakerRepo.create(intent.name)
        // Update all segments in this recording that had the raw speaker label
        const updated = transcriptRepo.assignSpeakerByRawId(
          args.recordingId,
          rawLabel,
          speaker.id,
          intent.name
        )
        const confirmText = updated > 0
          ? `Done! I've labeled ${updated} segment${updated !== 1 ? 's' : ''} as **${intent.name}** (was ${rawLabel}).`
          : `No segments with label ${rawLabel} were found in this recording. The speaker profile for **${intent.name}** was created — it will be applied when new segments arrive.`
        conversationRepo.addMessage(thread.id, 'user', args.message)
        const savedMessage = conversationRepo.addMessage(thread.id, 'assistant', confirmText)
        const wc = getWebContents()
        wc?.send(IPC.ai.chatChunk, { threadId: thread.id, chunk: confirmText })
        wc?.send(IPC.ai.chatDone, { threadId: thread.id })
        return { message: savedMessage }
      }
    }

    // Save user message
    conversationRepo.addMessage(thread.id, 'user', args.message)

    // Auto-title the thread from the first user message (if no title yet)
    if (!thread.title) {
      const autoTitle = args.message.trim().slice(0, 60).replace(/\s+/g, ' ')
      conversationRepo.updateTitle(thread.id, autoTitle)
    }

    // Build context
    let transcriptContext = ''
    let recording = null
    let systemPrompt: string

    if (args.recordingId) {
      recording = recordingRepo.findById(args.recordingId)
      const segments = transcriptRepo.findByRecordingId(args.recordingId)
      transcriptContext = buildTranscriptContext(segments)
      systemPrompt = `You are an intelligent assistant helping the user understand a recorded conversation.

RECORDING DETAILS:
Title: ${recording?.title ?? 'Unknown'}
Date: ${recording ? new Date(recording.createdAt).toLocaleDateString() : 'Unknown'}
Duration: ${recording?.duration ? `${Math.floor(recording.duration / 60)} minutes` : 'unknown'}

FULL TRANSCRIPT:
${transcriptContext}

When referencing specific moments, include the speaker name and timestamp. Be concise and accurate.`
    } else {
      // Cross-recording mode: use RAG to inject relevant context from all recordings
      const ragContext = await buildRagContext(args.message, searchService)
      systemPrompt = ragContext
        ? `You are an intelligent assistant with access to the user's recorded conversations.
Answer questions by drawing on the provided transcript excerpts. Always cite the recording title and timestamp when referencing content.
If the provided context doesn't contain the answer, say so clearly.

${ragContext}`
        : `You are a helpful AI assistant for a call transcription application. The user hasn't recorded anything yet, or no relevant content was found for this query.`
    }

    const history = conversationRepo.findMessagesByThread(thread.id)
    const messages = history
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // Check context window — if over limit, the RAG already limits scope; for single-recording
    // full-transcript injection, truncate from the beginning (keep recent segments).
    let effectiveSystemPrompt = systemPrompt
    if (estimateTokens(systemPrompt + messages.map((m) => m.content).join('')) > MAX_CONTEXT_TOKENS) {
      const truncated = transcriptContext.slice(-200_000)
      effectiveSystemPrompt = systemPrompt.replace(transcriptContext, truncated)
    }

    // Stream response to renderer
    let fullResponse = ''
    const wc = getWebContents()

    for await (const chunk of llm.stream('conversation', { systemPrompt: effectiveSystemPrompt, messages })) {
      fullResponse += chunk
      wc?.send(IPC.ai.chatChunk, { threadId: thread.id, chunk })
    }

    wc?.send(IPC.ai.chatDone, { threadId: thread.id })

    // Save assistant response
    const savedMessage = conversationRepo.addMessage(thread.id, 'assistant', fullResponse, {
      provider: args.provider,
      model: args.model
    })

    return { message: savedMessage }
  })

  ipcMain.handle(IPC.ai.getThread, async (_event, args: GetThreadArgs): Promise<GetThreadResult> => {
    const thread = conversationRepo.findThreadById(args.threadId)
    const messages = thread ? conversationRepo.findMessagesByThread(args.threadId) : []
    return { thread, messages }
  })

  ipcMain.handle(IPC.ai.createThread, async (_event, args: CreateThreadArgs): Promise<CreateThreadResult> => {
    const thread = conversationRepo.createThread(args.recordingId ?? null, args.title)
    return { thread }
  })

  ipcMain.handle(IPC.ai.getThreads, async (): Promise<GetThreadsResult> => {
    const threads = conversationRepo.findAllThreads()
    return { threads }
  })

  ipcMain.handle(IPC.ai.deleteThread, async (_event, args: DeleteThreadArgs): Promise<void> => {
    conversationRepo.deleteThread(args.threadId)
  })

  ipcMain.handle(IPC.ai.updateThreadTitle, async (_event, args: UpdateThreadTitleArgs): Promise<void> => {
    conversationRepo.updateTitle(args.threadId, args.title)
  })

  ipcMain.handle(IPC.ai.getModels, async (_event, args: GetModelsArgs): Promise<GetModelsResult> => {
    const available = await llm.isAvailable(args.provider)
    if (!available) return { models: [], available: false }
    const models = await llm.listModels(args.provider)
    return { models, available: true }
  })

  ipcMain.handle(IPC.ai.testProvider, async (_event, args: TestProviderArgs): Promise<TestProviderResult> => {
    if (args.apiKey) llm.setApiKey(args.provider, args.apiKey)
    try {
      const available = await llm.isAvailable(args.provider)
      return { available }
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
