import { useState, useEffect } from 'react'
import { Users, Loader2, Pencil } from 'lucide-react'
import type { SpeakerProfile } from '@shared/types'
import SpeakerPickerModal from './SpeakerPickerModal'

interface Props {
  recordingId: string
}

export default function RecordingSpeakersBar({ recordingId }: Props) {
  const [allSpeakers, setAllSpeakers] = useState<SpeakerProfile[]>([])
  const [expectedIds, setExpectedIds] = useState<string[]>([])
  const [sweeping, setSweeping] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    Promise.all([
      window.api.speaker.getAll(),
      window.api.recording.getExpectedSpeakers({ recordingId })
    ]).then(([{ speakers }, { speakerIds }]) => {
      setAllSpeakers(speakers)
      setExpectedIds(speakerIds)
      setLoaded(true)
    }).catch((err) => {
      console.error('[RecordingSpeakersBar] Failed to load:', err)
      setLoaded(true)
    })
  }, [recordingId])

  // Clear sweeping indicator when pipeline finishes
  useEffect(() => {
    const removeDiarDone = window.api.transcript.onDiarizationComplete(({ recordingId: rid }) => {
      if (rid === recordingId) setSweeping(false)
    })
    const removeSweptDone = window.api.transcript.onSpeakersSwept(({ recordingId: rid }) => {
      if (rid === recordingId) setSweeping(false)
    })
    return () => { removeDiarDone(); removeSweptDone() }
  }, [recordingId])

  const handleSave = async (ids: string[]) => {
    setModalOpen(false)
    const changed =
      ids.length !== expectedIds.length ||
      ids.some((id) => !expectedIds.includes(id))
    setExpectedIds(ids)
    // Refresh speaker list in case new ones were created in the modal
    window.api.speaker.getAll().then(({ speakers }) => setAllSpeakers(speakers))
    if (changed) {
      setSweeping(true)
      try {
        await window.api.recording.setExpectedSpeakers({ recordingId, speakerIds: ids })
      } catch {
        setSweeping(false)
      }
    }
  }

  if (!loaded) return null

  const selectedSpeakers = expectedIds
    .map((id) => allSpeakers.find((s) => s.id === id))
    .filter(Boolean) as SpeakerProfile[]

  return (
    <>
      <div className="rounded-lg border border-surface-700 bg-surface-800/60 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-zinc-200">Speakers in this recording</span>
          </div>
          <button
            className="btn-ghost flex items-center gap-1.5 text-xs px-2 py-1"
            onClick={() => setModalOpen(true)}
          >
            <Pencil className="w-3 h-3" />
            Edit
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-2 min-h-[28px]">
          {sweeping && (
            <span className="flex items-center gap-1.5 text-xs text-accent mr-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Re-identifying…
            </span>
          )}
          {selectedSpeakers.length > 0 ? (
            selectedSpeakers.map((sp) => (
              <span
                key={sp.id}
                className="text-xs font-medium px-2.5 py-1 rounded-full bg-accent/15 text-accent border border-accent/25"
              >
                {sp.name}
              </span>
            ))
          ) : (
            <span className="text-xs text-amber-400/80 italic">
              No speakers set — matching against all profiles
            </span>
          )}
        </div>
      </div>

      {modalOpen && (
        <SpeakerPickerModal
          selectedIds={expectedIds}
          onSave={(ids) => void handleSave(ids)}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}
