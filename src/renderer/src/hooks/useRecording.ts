import { useEffect, useCallback } from 'react'
import { useRecordingStore } from '../store/recordingStore'
import { useTranscriptStore } from '../store/transcriptStore'

/**
 * Wires up IPC event listeners for real-time transcription segments and audio level.
 * Call once at the top of the app.
 */
export function useRecordingEvents() {
  const addLiveSegment = useRecordingStore((s) => s.addLiveSegment)
  const setAudioLevel = useRecordingStore((s) => s.setAudioLevel)
  const updateSegment = useTranscriptStore((s) => s.updateSegment)

  useEffect(() => {
    const unsubSegment = window.api.transcript.onSegmentAdded((segment) => {
      addLiveSegment(segment)
      updateSegment(segment) // keep transcript store in sync
    })
    const unsubLevel = window.api.audio.onLevel((level) => {
      setAudioLevel(level)
    })
    return () => {
      unsubSegment()
      unsubLevel()
    }
  }, [addLiveSegment, setAudioLevel, updateSegment])
}

export function useRecording() {
  const store = useRecordingStore()

  useEffect(() => {
    void store.loadRecordings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deleteRecording = useCallback(async (id: string) => {
    await window.api.recording.delete({ recordingId: id })
    store.removeRecording(id)
  }, [store])

  return { ...store, deleteRecording }
}
