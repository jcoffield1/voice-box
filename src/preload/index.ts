import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-types'
import type {
  StartRecordingArgs,
  StartRecordingResult,
  StopRecordingArgs,
  StopRecordingResult,
  GetRecordingsResult,
  GetRecordingArgs,
  GetRecordingResult,
  UpdateRecordingArgs,
  DeleteRecordingArgs,
  ExportTranscriptArgs,
  ExportTranscriptResult,
  GetTranscriptArgs,
  GetTranscriptResult,
  UpdateSegmentArgs,
  AssignSpeakerArgs,
  AssignSpeakerResult,
  RankSpeakersArgs,
  RankSpeakersResult,
  SweepSpeakersArgs,
  SweepSpeakersResult,
  SearchArgs,
  SearchResult_,
  ReindexArgs,
  ReindexResult,
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
  TestProviderResult,
  SpeakArgs,
  ListVoicesResult,
  GetSettingArgs,
  GetSettingResult,
  SetSettingArgs,
  GetAudioDevicesResult,
  GetProviderForFeatureArgs,
  GetProviderForFeatureResult,
  SetProviderForFeatureArgs,
  GetApiKeyArgs,
  GetApiKeyResult,
  SetApiKeyArgs,
  DeleteApiKeyArgs,
  SystemStatusResult,
  VoiceInputStartResult,
  VoiceInputStopResult,
  GetSpeakersResult,
  GetSpeakerArgs,
  GetSpeakerResult,
  RenameSpeakerArgs,
  DeleteSpeakerArgs,
  MergeSpeakersArgs,
  UpdateSpeakerNotesArgs,
  ResetVoiceArgs,
  RecordingDebriefReadyPayload
} from '../shared/ipc-types'
import type { TranscriptSegment } from '../shared/types'

// Type-safe IPC invoke helper
function invoke<TResult>(channel: string, args?: unknown): Promise<TResult> {
  return ipcRenderer.invoke(channel, args) as Promise<TResult>
}

// Type-safe event listener helper
function on(channel: string, callback: (...args: unknown[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // ─── Recording ────────────────────────────────────────────────────────────
  recording: {
    start: (args: StartRecordingArgs) =>
      invoke<StartRecordingResult>(IPC.recording.start, args),
    stop: (args: StopRecordingArgs) =>
      invoke<StopRecordingResult>(IPC.recording.stop, args),
    getAll: () =>
      invoke<GetRecordingsResult>(IPC.recording.getAll),
    get: (args: GetRecordingArgs) =>
      invoke<GetRecordingResult>(IPC.recording.get, args),
    update: (args: UpdateRecordingArgs) =>
      invoke<GetRecordingResult>(IPC.recording.update, args),
    delete: (args: DeleteRecordingArgs) =>
      invoke<void>(IPC.recording.delete, args),
    export: (args: ExportTranscriptArgs) =>
      invoke<ExportTranscriptResult>(IPC.recording.export, args),
    onDebriefReady: (cb: (payload: RecordingDebriefReadyPayload) => void) =>
      on(IPC.recording.debriefReady, cb as (...args: unknown[]) => void),
    onProcessed: (cb: (payload: { recordingId: string }) => void) =>
      on(IPC.recording.processed, cb as (...args: unknown[]) => void)
  },

  // ─── Transcript ───────────────────────────────────────────────────────────
  transcript: {
    get: (args: GetTranscriptArgs) =>
      invoke<GetTranscriptResult>(IPC.transcript.get, args),
    updateSegment: (args: UpdateSegmentArgs) =>
      invoke<void>(IPC.transcript.updateSegment, args),
    assignSpeaker: (args: AssignSpeakerArgs) =>
      invoke<AssignSpeakerResult>(IPC.transcript.assignSpeaker, args),
    rankSpeakers: (args: RankSpeakersArgs) =>
      invoke<RankSpeakersResult>(IPC.transcript.rankSpeakers, args),
    sweepSpeakers: (args: SweepSpeakersArgs) =>
      invoke<SweepSpeakersResult>(IPC.transcript.sweepSpeakers, args),
    onSegmentAdded: (cb: (segment: TranscriptSegment) => void) =>
      on(IPC.transcript.segmentAdded, cb as (...args: unknown[]) => void),
    onDiarizationComplete: (cb: (data: { recordingId: string }) => void) =>
      on(IPC.transcript.diarizationComplete, cb as (...args: unknown[]) => void),
    onSpeakersSwept: (cb: (data: { recordingId: string; segments: TranscriptSegment[] }) => void) =>
      on(IPC.transcript.speakersSwept, cb as (...args: unknown[]) => void),
    onDiarizationError: (cb: (data: { type: string; message: string }) => void) =>
      on('diarization:error', cb as (...args: unknown[]) => void)
  },

  // ─── Search ───────────────────────────────────────────────────────────────
  search: {
    query: (args: SearchArgs) =>
      invoke<SearchResult_>(IPC.search.query, args),
    reindex: (args?: ReindexArgs) =>
      invoke<ReindexResult>(IPC.search.reindex, args ?? {})
  },

  // ─── AI ───────────────────────────────────────────────────────────────────
  ai: {
    summarize: (args: SummarizeArgs) =>
      invoke<SummarizeResult>(IPC.ai.summarize, args),
    chat: (args: ChatArgs) =>
      invoke<ChatResult>(IPC.ai.chat, args),
    getThread: (args: GetThreadArgs) =>
      invoke<GetThreadResult>(IPC.ai.getThread, args),
    getThreads: () =>
      invoke<GetThreadsResult>(IPC.ai.getThreads),
    createThread: (args: CreateThreadArgs) =>
      invoke<CreateThreadResult>(IPC.ai.createThread, args),
    deleteThread: (args: DeleteThreadArgs) =>
      invoke<void>(IPC.ai.deleteThread, args),
    updateThreadTitle: (args: UpdateThreadTitleArgs) =>
      invoke<void>(IPC.ai.updateThreadTitle, args),
    getModels: (args: GetModelsArgs) =>
      invoke<GetModelsResult>(IPC.ai.getModels, args),
    testProvider: (args: TestProviderArgs) =>
      invoke<TestProviderResult>(IPC.ai.testProvider, args),
    speak: (args: SpeakArgs) =>
      invoke<void>(IPC.ai.speak, args),
    stopSpeaking: () =>
      invoke<void>(IPC.ai.stopSpeaking),
    listVoices: () =>
      invoke<ListVoicesResult>(IPC.ai.listVoices),
    onChatChunk: (cb: (data: { threadId: string; chunk: string }) => void) =>
      on(IPC.ai.chatChunk, cb as (...args: unknown[]) => void),
    onChatDone: (cb: (data: { threadId: string }) => void) =>
      on(IPC.ai.chatDone, cb as (...args: unknown[]) => void)
  },

  // ─── Settings ─────────────────────────────────────────────────────────────
  settings: {
    get: (args: GetSettingArgs) =>
      invoke<GetSettingResult>(IPC.settings.get, args),
    set: (args: SetSettingArgs) =>
      invoke<void>(IPC.settings.set, args),
    getAudioDevices: () =>
      invoke<GetAudioDevicesResult>(IPC.settings.getAudioDevices),
    getProviderForFeature: (args: GetProviderForFeatureArgs) =>
      invoke<GetProviderForFeatureResult>(IPC.settings.getProviderForFeature, args),
    setProviderForFeature: (args: SetProviderForFeatureArgs) =>
      invoke<void>(IPC.settings.setProviderForFeature, args),
    getApiKey: (args: GetApiKeyArgs) =>
      invoke<GetApiKeyResult>(IPC.settings.getApiKey, args),
    setApiKey: (args: SetApiKeyArgs) =>
      invoke<void>(IPC.settings.setApiKey, args),
    deleteApiKey: (args: DeleteApiKeyArgs) =>
      invoke<void>(IPC.settings.deleteApiKey, args),
    getSystemStatus: () =>
      invoke<SystemStatusResult>(IPC.settings.getSystemStatus)
  },

  // ─── Speaker ──────────────────────────────────────────────────────────────
  speaker: {
    getAll: () => invoke<GetSpeakersResult>(IPC.speaker.getAll),
    get: (args: GetSpeakerArgs) => invoke<GetSpeakerResult>(IPC.speaker.get, args),
    rename: (args: RenameSpeakerArgs) => invoke<GetSpeakerResult>(IPC.speaker.rename, args),
    delete: (args: DeleteSpeakerArgs) => invoke<void>(IPC.speaker.delete, args),
    merge: (args: MergeSpeakersArgs) => invoke<void>(IPC.speaker.merge, args),
    updateNotes: (args: UpdateSpeakerNotesArgs) => invoke<GetSpeakerResult>(IPC.speaker.updateNotes, args),
    resetVoice: (args: ResetVoiceArgs) => invoke<GetSpeakerResult>(IPC.speaker.resetVoice, args)
  },

  // ─── Audio events ─────────────────────────────────────────────────────────
  audio: {
    onLevel: (cb: (level: number) => void) =>
      on('audio:level', cb as (...args: unknown[]) => void)
  },

  // ─── Voice input ──────────────────────────────────────────────────────────
  voiceInput: {
    start: () => invoke<VoiceInputStartResult>(IPC.voiceInput.start),
    stop: () => invoke<VoiceInputStopResult>(IPC.voiceInput.stop),
    onDone: (cb: (data: { transcript: string }) => void) =>
      on(IPC.voiceInput.done, cb as (...args: unknown[]) => void)
  },

  // ─── Python status ────────────────────────────────────────────────────────
  python: {
    onRestarted: (cb: (data: { name: string; attempt: number }) => void) =>
      on('python:restarted', cb as (...args: unknown[]) => void),
    onFailed: (cb: (data: { name: string }) => void) =>
      on('python:failed', cb as (...args: unknown[]) => void)
  },

  // ─── Global shortcuts ─────────────────────────────────────────────────────
  shortcuts: {
    onPushToTalk: (cb: () => void) =>
      on('shortcut:pushToTalk', cb as (...args: unknown[]) => void)
  }
}

contextBridge.exposeInMainWorld('api', api)

// Expose the type for the renderer
export type Api = typeof api
