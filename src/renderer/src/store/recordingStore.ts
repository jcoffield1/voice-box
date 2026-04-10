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
  clearLiveSegments: () => void
  setRecordings: (recordings: Recording[]) => void
  setLoadingRecordings: (v: boolean) => void
  addRecording: (r: Recording) => void
  updateRecording: (r: Recording) => void
  removeRecording: (id: string) => void

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

  setActiveRecordingId: (id) => set({ activeRecordingId: id }),
  setIsRecording: (v) => set({ isRecording: v }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  addLiveSegment: (segment) =>
    set((s) => ({ liveSegments: [...s.liveSegments, segment] })),
  clearLiveSegments: () => set({ liveSegments: [] }),
  setRecordings: (recordings) => set({ recordings }),
  setLoadingRecordings: (v) => set({ loadingRecordings: v }),
  addRecording: (r) => set((s) => ({ recordings: [r, ...s.recordings] })),
  updateRecording: (r) =>
    set((s) => ({ recordings: s.recordings.map((rec) => (rec.id === r.id ? r : rec)) })),
  removeRecording: (id) =>
    set((s) => ({ recordings: s.recordings.filter((r) => r.id !== id) })),

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
  },

  stopRecording: async () => {
    const id = get().activeRecordingId
    if (!id) return
    await window.api.recording.stop({ recordingId: id })
    set({ isRecording: false, activeRecordingId: null })
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

// Listen for auto-debrief ready event pushed from main process
window.api.recording.onDebriefReady(({ recordingId, debrief }) => {
  useRecordingStore.getState().updateRecording({
    ...useRecordingStore.getState().recordings.find((r) => r.id === recordingId)!,
    debrief,
    debriefAt: Date.now()
  })
})
