// Core domain types shared between main and renderer processes

export type RecordingStatus = 'recording' | 'processing' | 'complete' | 'error'

export interface Recording {
  id: string
  title: string
  createdAt: number // Unix ms
  updatedAt: number
  duration: number | null
  audioPath: string | null
  status: RecordingStatus
  summary: string | null
  summaryModel: string | null
  summaryAt: number | null
  debrief: string | null
  debriefAt: number | null
  notes: string | null
  tags: string[]
  /** ID of the SummaryTemplate to use when auto-generating the debrief. null = use default template. */
  templateId: string | null
}

export interface SummaryTemplate {
  id: string
  name: string
  /** System prompt sent to the LLM as role:system. */
  systemPrompt: string
  /**
   * User message template. Supports two placeholders:
   *   {{title}}      — replaced with recording.title
   *   {{transcript}} — replaced with the full formatted transcript
   */
  userPromptTemplate: string
  /** True for the built-in default that ships with VoiceBox and cannot be deleted. */
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface TranscriptSegment {
  id: string
  recordingId: string
  text: string
  speakerId: string | null
  speakerName: string | null
  speakerConfidence: number | null
  timestampStart: number // seconds
  timestampEnd: number
  whisperConfidence: number | null
  isEdited: boolean
  createdAt: number
}

export interface SpeakerProfile {
  id: string
  name: string
  voiceEmbedding: number[] | null
  /** Number of audio samples that have been averaged into voiceEmbedding. Used
   *  by learnSpeaker to compute a proper running mean capped at EMBEDDING_SAMPLE_CAP
   *  so old recordings are not exponentially discarded. */
  embeddingSamples: number
  recordingCount: number
  firstSeenAt: number
  lastSeenAt: number
  notes: string | null
}

export interface ConversationThread {
  id: string
  recordingId: string | null
  createdAt: number
  updatedAt: number
  title: string | null
}

export interface ConversationMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  model: string | null
  provider: string | null
}

export interface AppSettings {
  key: string
  value: string
  updatedAt: number
}

// LLM types
export type LLMProviderType = 'ollama' | 'claude' | 'openai'
export type LLMFeature = 'summarization' | 'conversation' | 'embeddings' | 'intent'

export interface LLMModel {
  id: string
  name: string
  contextWindow: number
  supportsEmbeddings: boolean
  provider: LLMProviderType
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface CompletionRequest {
  model: string
  systemPrompt?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

export interface CompletionResponse {
  text: string
  model: string
  provider: string
  tokensUsed?: number
}

// Search types
export interface SearchResult {
  segmentId: string
  recordingId: string
  recordingTitle: string
  templateId: string | null
  recordingNotes: string | null
  recordingTags: string[]
  text: string
  speakerName: string | null
  timestampStart: number
  timestampEnd: number
  score: number
  matchType: 'semantic' | 'keyword' | 'hybrid'
  snippet: string
}

export interface SearchQuery {
  query: string
  recordingId?: string
  speakerName?: string
  /** Filter to recordings assigned to this templateId. Pass null to match recordings using the default (no template assigned). */
  templateId?: string | null
  dateFrom?: number
  dateTo?: number
  limit?: number
}

// Audio types
export interface AudioDevice {
  id: string
  name: string
  type: 'input' | 'output'
  isDefault: boolean
}

export interface AudioCaptureConfig {
  inputDeviceId: string | null
  systemAudioEnabled: boolean
  sampleRate: number
  channels: number
}

// Python bridge types
export interface PythonRequest {
  id: string
  type: string
  payload: unknown
}

export interface PythonResponse {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

// Transcription output from Whisper
export interface WhisperSegment {
  text: string
  start: number
  end: number
  confidence: number
  language?: string
}

// Diarization output from Pyannote
export interface DiarizationSegment {
  speakerId: string
  start: number
  end: number
}

// Voice embedding from Resemblyzer
export interface VoiceEmbeddingResult {
  embedding: number[]
  speakerId: string
}
