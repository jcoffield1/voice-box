import { useEffect } from 'react'
import { useTranscriptStore } from '../store/transcriptStore'

export function useTranscript(recordingId: string) {
  const store = useTranscriptStore()
  const segments = store.segmentsByRecording[recordingId] ?? []
  const loading = store.loading[recordingId] ?? false

  useEffect(() => {
    if (recordingId) {
      void store.loadTranscript(recordingId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId])

  return { segments, loading, editSegment: store.editSegment }
}
