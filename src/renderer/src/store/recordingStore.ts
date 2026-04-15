import { create } from 'zustand'
import type { Recording, TranscriptSegment, AudioCaptureConfig } from '@shared/types'

interface RecordingState {
  // Active recording
  activeRecordingId: string | null
  isRecording: boolean
  audioLevel: number
  liveSegments: TranscriptSegment[]

  // Recording list
  recordings: Recording[]
  loadingRecordings: boolean

  // Actions
  setActiveRecordingId: (id: string | null) => void
  setIsRecording: (v: boolean) => void
  setAudioLevel: (level: number) => void
  addLiveSegment: (segment: TranscriptSegment) => void
  updateLiveSegment: (id: string, patch: Partial<TranscriptSegment>) => void
  clearLiveSegments: () => void
  setRecordings: (recordings: Recording[]) => void
  setLoadingRecordings: (v: boolean) => void
  addRecording: (r: Recording) => void
  updateRecording: (r: Recording) => void
  removeRecording: (id: string) => void

  // Diarization error (captured globally so it survives during/after live recording)
  diarizationError: string | null
  setDiarizationError: (msg: string | null) => void

  // Set while the post-recording pipeline (diarization + speaker ID + debrief) is running
  postProcessingRecordingId: string | null

  // Async thunks
  startRecording: (title: string, config: AudioCaptureConfig) => Promise<void>
  stopRecording: () => Promise<void>
  loadRecordings: () => Promise<void>
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  activeRecordingId: null,
  isRecording: false,
  audioLevel: 0,
  liveSegments: [],
  recordings: [],
  loadingRecordings: false,
  diarizationError: null,
  postProcessingRecordingId: null,

  setActiveRecordingId: (id) => set({ activeRecordingId: id }),
  setIsRecording: (v) => set({ isRecording: v }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  addLiveSegment: (segment) =>
    set((s) => {
      const exists = s.liveSegments.some((seg) => seg.id === segment.id)
      return {
        liveSegments: exists
          ? s.liveSegments.map((seg) => seg.id === segment.id ? segment : seg)
          : [...s.liveSegments, segment]
      }
    }),
  updateLiveSegment: (id, patch) =>
    set((s) => ({ liveSegments: s.liveSegments.map((seg) => seg.id === id ? { ...seg, ...patch } : seg) })),
  clearLiveSegments: () => set({ liveSegments: [] }),
  setRecordings: (recordings) => set({ recordings }),
  setLoadingRecordings: (v) => set({ loadingRecordings: v }),
  addRecording: (r) => set((s) => ({ recordings: [r, ...s.recordings] })),
  updateRecording: (r) =>
    set((s) => ({ recordings: s.recordings.map((rec) => (rec.id === r.id ? r : rec)) })),
  removeRecording: (id) =>
    set((s) => ({ recordings: s.recordings.filter((r) => r.id !== id) })),
  setDiarizationError: (msg) => set({ diarizationError: msg }),

  startRecording: async (title, config) => {
    let result: Awaited<ReturnType<typeof window.api.recording.start>>
    try {
      result = await window.api.recording.start({ title, config })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[Recording] Failed to start:', msg)
      throw new Error(msg)
    }
    set({ activeRecordingId: result.recordingId, isRecording: true })
    get().clearLiveSegments()
    get().setDiarizationError(null)
  },

  stopRecording: async () => {
    const id = get().activeRecordingId
    if (!id) return
    await window.api.recording.stop({ recordingId: id })
    set({ isRecording: false, activeRecordingId: null, postProcessingRecordingId: id })
    await get().loadRecordings()
  },

  loadRecordings: async () => {
    set({ loadingRecordings: true })
    try {
      const result = await window.api.recording.getAll()
      set({ recordings: result.recordings })
    } finally {
      set({ loadingRecordings: false })
    }
  }
}))

// Listen for diarization errors globally so the banner works during and after live recording
window.api.transcript.onDiarizationError(({ message }) => {
  useRecordingStore.getState().setDiarizationError(message)
})

// Clear processing state when the full pipeline completes
window.api.recording.onProcessed(({ recordingId }) => {
  const store = useRecordingStore.getState()
  if (store.postProcessingRecordingId === recordingId) {
    useRecordingStore.setState({ postProcessingRecordingId: null })
  }
})

// Listen for auto-debrief ready event pushed from main process
window.api.recording.onDebriefReady(({ recordingId, debrief }) => {
  useRecordingStore.getState().updateRecording({
    ...useRecordingStore.getState().recordings.find((r) => r.id === recordingId)!,
    debrief,
    debriefAt: Date.now()
  })
})
