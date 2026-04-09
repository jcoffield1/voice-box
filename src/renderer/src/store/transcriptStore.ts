import { create } from 'zustand'
import type { TranscriptSegment } from '@shared/types'

interface TranscriptState {
  segmentsByRecording: Record<string, TranscriptSegment[]>
  loading: Record<string, boolean>

  setSegments: (recordingId: string, segments: TranscriptSegment[]) => void
  setLoading: (recordingId: string, v: boolean) => void
  updateSegment: (segment: TranscriptSegment) => void

  loadTranscript: (recordingId: string) => Promise<void>
  editSegment: (segmentId: string, text: string) => Promise<void>
}

export const useTranscriptStore = create<TranscriptState>((set, get) => ({
  segmentsByRecording: {},
  loading: {},

  setSegments: (recordingId, segments) =>
    set((s) => ({ segmentsByRecording: { ...s.segmentsByRecording, [recordingId]: segments } })),

  setLoading: (recordingId, v) =>
    set((s) => ({ loading: { ...s.loading, [recordingId]: v } })),

  updateSegment: (segment) =>
    set((s) => {
      const existing = s.segmentsByRecording[segment.recordingId] ?? []
      const found = existing.some((seg) => seg.id === segment.id)
      return {
        segmentsByRecording: {
          ...s.segmentsByRecording,
          [segment.recordingId]: found
            ? existing.map((seg) => seg.id === segment.id ? segment : seg)
            : [...existing, segment]
        }
      }
    }),

  loadTranscript: async (recordingId) => {
    get().setLoading(recordingId, true)
    try {
      const result = await window.api.transcript.get({ recordingId })
      get().setSegments(recordingId, result.segments)
    } finally {
      get().setLoading(recordingId, false)
    }
  },

  editSegment: async (segmentId, text) => {
    await window.api.transcript.updateSegment({ segmentId, text })
    // Optimistic update via refetch is fine since segments are small
    const allSegments = Object.values(get().segmentsByRecording).flat()
    const seg = allSegments.find((s) => s.id === segmentId)
    if (seg) {
      get().updateSegment({ ...seg, text, isEdited: true })
    }
  }
}))
