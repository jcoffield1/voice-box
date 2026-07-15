import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  SummarizeArgs,
  SummarizeResult,
  ChatArgs,
  ChatResult,
  GetThreadArgs,
  GetThreadResult,
  GetThreadsByRecordingArgs,
  GetThreadsResult,
  CreateThreadArgs,
  CreateThreadResult,
  DeleteThreadArgs,
  UpdateThreadTitleArgs,
  GetModelsArgs,
  GetModelsResult,
  TestProviderArgs,
  TestProviderResult,
  PullModelArgs
} from '@shared/ipc-types'
import type { LLMService } from '../services/llm/LLMService'
import type { ConversationRepository } from '../services/storage/repositories/ConversationRepository'
import type { RecordingRepository } from '../services/storage/repositories/RecordingRepository'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { SpeakerRepository } from '../services/storage/repositories/SpeakerRepository'
import type { SearchService } from '../services/search/SearchService'
import type { WebContents } from 'electron'
import type { TranscriptSegment, Recording } from '@shared/types'
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

const RAG_CONTEXT_RESULTS = 20  // segments to inject for cross-recording chat
const RAG_PREFETCH_MULTIPLIER = 4 // over-fetch when filtering to compensate for post-filter attrition
const MAX_DEBRIEF_CHARS = 3000   // cap per-recording debrief so we don't blow the context window
const MAX_DEBRIEF_RECORDINGS = 5 // include debriefs for at most the N most-represented recordings

async function buildRagContext(
  query: string,
  search: SearchService,
  recordingRepo: RecordingRepository,
  templateId?: string | null,
  templateName?: string,
  tags?: string[],
  includeJournals?: boolean
): Promise<string> {
  try {
    // When filtering, over-fetch to compensate for post-filter result attrition.
    const isFiltered = templateId !== undefined || (tags && tags.length > 0)
    const limit = isFiltered ? RAG_CONTEXT_RESULTS * RAG_PREFETCH_MULTIPLIER : RAG_CONTEXT_RESULTS
    const searchQuery: Parameters<typeof search.query>[0] = { query, limit }
    if (templateId !== undefined) searchQuery.templateId = templateId
    if (tags && tags.length > 0) searchQuery.tags = tags
    if (includeJournals) searchQuery.includeJournals = true
    const rawResults = await search.query(searchQuery)
    const results = isFiltered ? rawResults.slice(0, RAG_CONTEXT_RESULTS) : rawResults
    if (results.length === 0) return ''

    const scopeParts: string[] = []
    if (templateName) scopeParts.push(`in the "${templateName}" category`)
    if (tags && tags.length > 0) scopeParts.push(`tagged "${tags.join('", "')}"`)
    const scopeNote = scopeParts.length > 0 ? ` from recordings ${scopeParts.join(' and ')}` : ''

    // ── Specific transcript excerpts ─────────────────────────────────────────
    const excerptLines = results.map((r) => {
      const ts = `${Math.floor(r.timestampStart / 60)}:${String(Math.floor(r.timestampStart % 60)).padStart(2, '0')}`
      const speaker = r.speakerName ? `${r.speakerName}: ` : ''
      return `[${r.recordingTitle} @ ${ts}] ${speaker}${r.text}`
    })

    // ── Per-recording debriefs + metadata ────────────────────────────────────
    // Count how many segments came from each recording so the most-represented
    // ones (most relevant to the query) get their debriefs included first.
    const recordingHits = new Map<string, number>()
    for (const r of results) recordingHits.set(r.recordingId, (recordingHits.get(r.recordingId) ?? 0) + 1)
    const rankedRecordingIds = [...recordingHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)

    const debriefLines: string[] = []
    const metaLines: string[] = []
    const includedIds = new Set<string>()

    // Pass 1: recordings that appeared in segment search results (ranked by hit count)
    for (const rid of rankedRecordingIds) {
      const rec = recordingRepo.findById(rid)
      if (!rec) continue
      includedIds.add(rid)

      if (rec.debrief?.trim() && debriefLines.length < MAX_DEBRIEF_RECORDINGS) {
        const text = rec.debrief.trim().slice(0, MAX_DEBRIEF_CHARS)
        debriefLines.push(`=== "${rec.title}" ===\n${text}${rec.debrief.trim().length > MAX_DEBRIEF_CHARS ? '…' : ''}`)
      }

      const metaParts: string[] = []
      if (rec.tags?.length) metaParts.push(`Tags: ${rec.tags.join(', ')}`)
      if (rec.notes?.trim()) metaParts.push(`Notes: ${rec.notes.trim().slice(0, 300)}`)
      if (metaParts.length > 0) metaLines.push(`"${rec.title}": ${metaParts.join(' | ')}`)
    }

    // Pass 2: keyword-match recording titles against the query so recordings that ARE
    // the topic (e.g. "Jon Landon Demand planning") get their debriefs included even
    // when only a few of their segments ranked in the semantic search.
    const queryTerms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    const unsummarizedRelevant: string[] = []
    if (queryTerms.length > 0) {
      const allRecordings = recordingRepo.findAll()
      for (const rec of allRecordings) {
        if (includedIds.has(rec.id)) continue
        if (!includeJournals && rec.videoMode === 'webcam') continue
        const titleHits = queryTerms.filter((t) => rec.title.toLowerCase().includes(t)).length
        // Require ≥2 matching terms, or all terms if query is only 1-2 words
        const threshold = Math.min(2, queryTerms.length)
        if (titleHits < threshold) continue

        includedIds.add(rec.id)
        if (rec.debrief?.trim() && debriefLines.length < MAX_DEBRIEF_RECORDINGS) {
          const text = rec.debrief.trim().slice(0, MAX_DEBRIEF_CHARS)
          debriefLines.push(`=== "${rec.title}" ===\n${text}${rec.debrief.trim().length > MAX_DEBRIEF_CHARS ? '…' : ''}`)
        } else if (!rec.debrief?.trim()) {
          unsummarizedRelevant.push(rec.title)
        }

        const metaParts: string[] = []
        if (rec.tags?.length) metaParts.push(`Tags: ${rec.tags.join(', ')}`)
        if (rec.notes?.trim()) metaParts.push(`Notes: ${rec.notes.trim().slice(0, 300)}`)
        if (metaParts.length > 0) metaLines.push(`"${rec.title}": ${metaParts.join(' | ')}`)
      }
    }

    // If relevant recordings exist but have no AI summary, surface that to the user
    const unsummarizedNote = unsummarizedRelevant.length > 0
      ? `\n\nRECORDINGS WITHOUT SUMMARIES (relevant by title but not yet summarized — tell the user they can open these recordings and generate an AI debrief for richer answers):\n${unsummarizedRelevant.map((t) => `- "${t}"`).join('\n')}`
      : ''

    const debriefBlock = debriefLines.length > 0
      ? `\n\nRECORDING SUMMARIES (full AI-generated debriefs for the most relevant recordings):\n${debriefLines.join('\n\n')}`
      : ''
    const metaBlock = metaLines.length > 0
      ? `\n\nRECORDING METADATA:\n${metaLines.join('\n')}`
      : ''

    const uniqueRecordingCount = new Set(results.map((r) => r.recordingId)).size
    return `RELEVANT TRANSCRIPT EXCERPTS${scopeNote} (${results.length} segments from ${uniqueRecordingCount} recording(s)):\n${excerptLines.join('\n')}${debriefBlock}${metaBlock}${unsummarizedNote}`
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
    let recording: Recording | null = null
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
Tags: ${recording?.tags?.length ? recording.tags.join(', ') : 'none'}
Notes: ${recording?.notes?.trim() || 'none'}

FULL TRANSCRIPT:
${transcriptContext}

When referencing specific moments, include the speaker name and timestamp. Be concise and accurate.`
    } else {
      // Cross-recording mode: use RAG to inject relevant context from all recordings
      const ragContext = await buildRagContext(args.message, searchService, recordingRepo, args.templateId, args.templateName, args.tags, args.includeJournals)
      const scopeParts: string[] = []
      if (args.templateName) scopeParts.push(`the "${args.templateName}" category`)
      if (args.tags && args.tags.length > 0) scopeParts.push(`recordings tagged "${args.tags.join('", "')}"`)
      const scopeDescription = scopeParts.length > 0
        ? scopeParts.join(' and ')
        : 'the user\'s recorded conversations'
      systemPrompt = ragContext
        ? `You are an intelligent assistant with access to ${scopeDescription}.
You have been given full AI-generated summaries for the most relevant recordings AND specific transcript excerpts with timestamps.
When answering broad questions, synthesize across the recording summaries to give a comprehensive answer.
When citing specific moments or quotes, use the transcript excerpts.
Answer using ONLY the provided context below — do NOT draw on general knowledge to fill gaps.
Do NOT mention "the provided transcript", "the summaries", "the excerpts", or otherwise hint that you are working from search results — the user already knows you are searching their recordings.

${ragContext}`
        : `You are a helpful AI assistant for a call transcription application. No relevant content was found${scopeParts.length > 0 ? ` in ${scopeDescription}` : ''}. Let the user know and suggest they broaden their scope.`
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

  ipcMain.handle(IPC.ai.getThreadsByRecording, async (_event, args: GetThreadsByRecordingArgs): Promise<GetThreadsResult> => {
    const threads = conversationRepo.findThreadsByRecording(args.recordingId)
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

  ipcMain.handle(IPC.ai.pullModel, async (_event, args: PullModelArgs): Promise<void> => {
    const wc = getWebContents()
    try {
      for await (const progress of llm.pullOllamaModel(args.model)) {
        wc?.send(IPC.ai.pullProgress, { model: args.model, ...progress })
      }
      wc?.send(IPC.ai.pullDone, { model: args.model })
    } catch (err) {
      wc?.send(IPC.ai.pullError, { model: args.model, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
