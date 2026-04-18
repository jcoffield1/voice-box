// Typed IPC channel contracts. Used in both main process handlers and renderer calls.
// Rule: Never use `any` for IPC payloads. All channels must have types here.

import type {
  Recording,
  TranscriptSegment,
  SpeakerProfile,
  ConversationThread,
  ConversationMessage,
  SearchQuery,
  SearchResult,
  AudioDevice,
  AudioCaptureConfig,
  LLMModel,
  LLMProviderType,
  LLMFeature,
  SummaryTemplate,
} from './types'

// ─── Recording IPC ───────────────────────────────────────────────────────────

export interface StartRecordingArgs {
  title: string
  config: AudioCaptureConfig
}

export interface StartRecordingResult {
  recordingId: string
}

export interface StopRecordingArgs {
  recordingId: string
}

export interface StopRecordingResult {
  recordingId: string
  duration: number
}

export interface GetRecordingsResult {
  recordings: Recording[]
}

export interface GetRecordingArgs {
  recordingId: string
}

export interface GetRecordingResult {
  recording: Recording | null
}

export interface UpdateRecordingArgs {
  recordingId: string
  title?: string
  notes?: string
  tags?: string[]
  /** Set / clear the associated summary template. Pass null to use the default. */
  templateId?: string | null
}

export interface DeleteRecordingArgs {
  recordingId: string
}

export interface ImportAudioArgs {
  /** If provided, skip the file dialog and import this path directly. */
  filePath?: string
}

export interface ImportAudioResult {
  recordingId: string
}

export interface RecordingDebriefReadyPayload {
  recordingId: string
  debrief: string
}

// ─── Transcript IPC ──────────────────────────────────────────────────────────

export interface GetTranscriptArgs {
  recordingId: string
}

export interface GetTranscriptResult {
  segments: TranscriptSegment[]
}

export interface UpdateSegmentArgs {
  segmentId: string
  text: string
}

export interface AssignSpeakerArgs {
  recordingId: string
  segmentId: string          // The specific segment the user clicked
  speakerId: string | null   // Raw diarization label (SPEAKER_00) or resolved profile UUID or null
  speakerName: string
  profileId?: string         // If provided, use this exact profile UUID (no name lookup)
}

export interface AssignSpeakerResult {
  updatedSegments: number
}

export interface RankSpeakersArgs {
  recordingId: string
  segmentId: string
}

export interface RankedSpeakerCandidate {
  speakerId: string
  speakerName: string
  confidence: number
  /** true = ranked by voice similarity; false = fallback (recently active, no embedding data) */
  isVoiceMatch: boolean
}

export interface RankSpeakersResult {
  candidates: RankedSpeakerCandidate[]
}

export interface SweepSpeakersArgs {
  recordingId: string
}

export interface SweepSpeakersResult {
  /** Number of segments that were auto-assigned during the sweep. */
  updatedCount: number
}

// ─── Search IPC ──────────────────────────────────────────────────────────────

export interface SearchArgs {
  query: SearchQuery
}

export interface SearchResult_ {
  results: SearchResult[]
}

export interface ReindexArgs {
  recordingId?: string
}

export interface ReindexResult {
  queued: number
}

// ─── AI / LLM IPC ────────────────────────────────────────────────────────────

export interface SummarizeArgs {
  recordingId: string
  model: string
  provider: LLMProviderType
}

export interface SummarizeResult {
  summary: string
  model: string
  provider: string
}

export interface ChatArgs {
  threadId: string
  message: string
  recordingId: string | null
  model: string
  provider: LLMProviderType
  /** When set, RAG context is restricted to recordings assigned to this template.
   *  Pass null to restrict to recordings using the default (no template assigned). */
  templateId?: string | null
  /** Human-readable name of the selected template — used in the AI system prompt. */
  templateName?: string
}

export interface ChatResult {
  message: ConversationMessage
}

export interface GetThreadArgs {
  threadId: string
}

export interface GetThreadsByRecordingArgs {
  recordingId: string
}

export interface GetThreadResult {
  thread: ConversationThread | null
  messages: ConversationMessage[]
}

export interface CreateThreadArgs {
  recordingId: string | null
  title?: string
}

export interface CreateThreadResult {
  thread: ConversationThread
}

export interface GetThreadsResult {
  threads: ConversationThread[]
}

export interface DeleteThreadArgs {
  threadId: string
}

export interface UpdateThreadTitleArgs {
  threadId: string
  title: string
}

export interface GetModelsArgs {
  provider: LLMProviderType
}

export interface GetModelsResult {
  models: LLMModel[]
  available: boolean
}

export interface TestProviderArgs {
  provider: LLMProviderType
  apiKey?: string
}

export interface TestProviderResult {
  available: boolean
  error?: string
}

// ─── Settings IPC ────────────────────────────────────────────────────────────

export interface GetSettingArgs {
  key: string
}

export interface GetSettingResult {
  value: string | null
}

export interface SetSettingArgs {
  key: string
  value: string
}

export interface GetAudioDevicesResult {
  devices: AudioDevice[]
}

export interface GetProviderForFeatureArgs {
  feature: LLMFeature
}

export interface GetProviderForFeatureResult {
  provider: LLMProviderType
  model: string
}

export interface SetProviderForFeatureArgs {
  feature: LLMFeature
  provider: LLMProviderType
  model: string
}

// ─── Speaker IPC ─────────────────────────────────────────────────────────────

export interface GetSpeakersResult {
  speakers: SpeakerProfile[]
}

export interface GetSpeakerArgs {
  speakerId: string
}

export interface GetSpeakerResult {
  speaker: SpeakerProfile | null
}

export interface RenameSpeakerArgs {
  speakerId: string
  name: string
}

export interface DeleteSpeakerArgs {
  speakerId: string
}

export interface MergeSpeakersArgs {
  sourceId: string
  targetId: string
}

export interface UpdateSpeakerNotesArgs {
  speakerId: string
  notes: string | null
}

export interface ResetVoiceArgs {
  speakerId: string
}

// ─── IPC channel name map ─────────────────────────────────────────────────────
// This is the single source of truth for all channel strings.

export const IPC = {
  recording: {
    start: 'recording:start',
    stop: 'recording:stop',
    getAll: 'recording:getAll',
    get: 'recording:get',
    update: 'recording:update',
    delete: 'recording:delete',
    export: 'recording:export',
    exportSummary: 'recording:exportSummary',
    // Event pushed from main → renderer when auto-debrief is ready
    debriefReady: 'recording:debriefReady',
    // Event pushed from main → renderer when the full post-recording pipeline finishes
    processed: 'recording:processed',
    // Import an audio file and process it like a recording
    import: 'recording:import'
  },
  transcript: {
    get: 'transcript:get',
    updateSegment: 'transcript:updateSegment',
    assignSpeaker: 'transcript:assignSpeaker',
    rankSpeakers: 'transcript:rankSpeakers',
    sweepSpeakers: 'transcript:sweepSpeakers',
    // Event pushed from main → renderer during live recording
    segmentAdded: 'transcript:segmentAdded',
    // Event pushed from main → renderer when post-recording diarization finishes
    diarizationComplete: 'recording:diarizationComplete',
    // Event pushed from main → renderer when background speaker sweep updates segments
    speakersSwept: 'transcript:speakersSwept',
  },
  search: {
    query: 'search:query',
    reindex: 'search:reindex'
  },
  ai: {
    summarize: 'ai:summarize',
    chat: 'ai:chat',
    getThread: 'ai:getThread',
    getThreads: 'ai:getThreads',
    getThreadsByRecording: 'ai:getThreadsByRecording',
    createThread: 'ai:createThread',
    deleteThread: 'ai:deleteThread',
    updateThreadTitle: 'ai:updateThreadTitle',
    getModels: 'ai:getModels',
    testProvider: 'ai:testProvider',
    speak: 'ai:speak',
    stopSpeaking: 'ai:stopSpeaking',
    listVoices: 'ai:listVoices',
    // Streaming event pushed from main → renderer
    chatChunk: 'ai:chatChunk',
    chatDone: 'ai:chatDone'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    getAudioDevices: 'settings:getAudioDevices',
    getProviderForFeature: 'settings:getProviderForFeature',
    setProviderForFeature: 'settings:setProviderForFeature',
    getApiKey: 'settings:getApiKey',
    setApiKey: 'settings:setApiKey',
    deleteApiKey: 'settings:deleteApiKey',
    getSystemStatus: 'settings:getSystemStatus'
  },
  speaker: {
    getAll: 'speaker:getAll',
    get: 'speaker:get',
    rename: 'speaker:rename',
    delete: 'speaker:delete',
    merge: 'speaker:merge',
    updateNotes: 'speaker:updateNotes',
    resetVoice: 'speaker:resetVoice'
  },
  voiceInput: {
    start: 'voiceInput:start',
    stop: 'voiceInput:stop',
    // Event pushed from main → renderer with partial / final transcript
    chunk: 'voiceInput:chunk',
    done: 'voiceInput:done'
  },
  template: {
    getAll:  'template:getAll',
    get:     'template:get',
    create:  'template:create',
    clone:   'template:clone',
    update:  'template:update',
    delete:  'template:delete',
    import:  'template:import',
    export:  'template:export',
    test:    'template:test',
  }
} as const

// ─── Keychain IPC ─────────────────────────────────────────────────────────────

export interface GetApiKeyArgs {
  provider: string
}

export interface GetApiKeyResult {
  apiKey: string | null
}

export interface SetApiKeyArgs {
  provider: string
  apiKey: string
}

export interface DeleteApiKeyArgs {
  provider: string
}

// ─── Export IPC ──────────────────────────────────────────────────────────────

export interface ExportTranscriptArgs {
  recordingId: string
  format: 'txt' | 'md' | 'srt'
}

export interface ExportTranscriptResult {
  content: string
  filename: string
}

export interface ExportSummaryArgs {
  recordingId: string
  format: 'txt' | 'md' | 'docx' | 'pdf'
}

export interface ExportSummaryResult {
  /** Absolute path the file was saved to, or null if the user cancelled. */
  savedTo: string | null
}

// ─── Voice IPC ───────────────────────────────────────────────────────────────

export interface VoiceInputStartResult {
  ok: boolean
}

export interface VoiceInputStopResult {
  transcript: string
}

export interface SpeakArgs {
  text: string
  rate?: number // words per minute, default 200
  voice?: string // macOS voice name, e.g. "Nicky Siri" or "Samantha"
}

export interface MacOSVoice {
  name: string
  locale: string // e.g. "en-US"
  gender: string // "VoiceGenderMale" | "VoiceGenderFemale"
}

export interface ListVoicesResult {
  voices: MacOSVoice[]
}

// ─── System status IPC ───────────────────────────────────────────────────────

export interface SystemStatusResult {
  ollamaAvailable: boolean
  ollamaModels: string[]
  pythonAvailable: boolean
  whisperAvailable: boolean
}

// ─── Summary Template IPC ────────────────────────────────────────────────────

export interface GetTemplatesResult {
  templates: SummaryTemplate[]
}

export interface GetTemplateArgs {
  templateId: string
}

export interface GetTemplateResult {
  template: SummaryTemplate | null
}

export interface CreateTemplateArgs {
  name: string
  systemPrompt: string
  userPromptTemplate: string
}

export interface CreateTemplateResult {
  template: SummaryTemplate
}

export interface CloneTemplateArgs {
  templateId: string
}

export interface CloneTemplateResult {
  template: SummaryTemplate
}

export interface UpdateTemplateArgs {
  templateId: string
  name?: string
  systemPrompt?: string
  userPromptTemplate?: string
}

export interface UpdateTemplateResult {
  template: SummaryTemplate | null
}

export interface DeleteTemplateArgs {
  templateId: string
}

export interface ImportTemplateResult {
  template: SummaryTemplate
}

export interface ExportTemplateArgs {
  templateId: string
}

export interface TestTemplateArgs {
  /** The system prompt to test. */
  systemPrompt: string
  /** The user prompt template (may contain {{title}} and {{transcript}} placeholders). */
  userPromptTemplate: string
  /** Recording whose title and transcript will be substituted into the template. */
  recordingId: string
  model: string
  provider: LLMProviderType
}

export interface TestTemplateResult {
  /** The LLM-generated debrief text. */
  result: string
  model: string
  provider: string
}

// Derive union types
export type IpcChannel = (typeof IPC)[keyof typeof IPC][keyof (typeof IPC)[keyof typeof IPC]]
