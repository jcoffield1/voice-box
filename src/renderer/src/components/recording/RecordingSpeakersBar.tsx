import { useState, useEffect, useMemo } from 'react'
import { Users, Loader2, Pencil, RefreshCw, AlertTriangle } from 'lucide-react'
import type { SpeakerProfile } from '@shared/types'
import SpeakerPickerModal from './SpeakerPickerModal'
import { useTranscriptStore } from '../../store/transcriptStore'
import { useRecordingStore } from '../../store/recordingStore'

const DOT_COLORS = [
  'bg-violet-400',
  'bg-sky-400',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-fuchsia-400',
]

function dotColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h += name.charCodeAt(i)
  return DOT_COLORS[h % DOT_COLORS.length]
}

function avgConfidenceColor(avg: number): string {
  if (avg >= 0.80) return 'text-emerald-400'
  if (avg >= 0.65) return 'text-amber-400'
  return 'text-red-400'
}

interface Props {
  recordingId: string
}

export default function RecordingSpeakersBar({ recordingId }: Props) {
  const [allSpeakers, setAllSpeakers] = useState<SpeakerProfile[]>([])
  const [expectedIds, setExpectedIds] = useState<string[]>([])
  const [sweeping, setSweeping] = useState(false)
  const [reidentifying, setReidentifying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  // Use live segments during recording, stored segments after
  const isLive = useRecordingStore((s) => s.isRecording && s.activeRecordingId === recordingId)
  const liveSegments = useRecordingStore((s) => s.liveSegments)
  const storedSegments = useTranscriptStore((s) => s.segmentsByRecording[recordingId] ?? [])
  const segments = isLive ? liveSegments : storedSegments

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
      if (rid === recordingId) { setSweeping(false); setReidentifying(false) }
    })
    return () => { removeDiarDone(); removeSweptDone() }
  }, [recordingId])

  const handleSave = async (ids: string[]) => {
    setModalOpen(false)
    const changed = ids.length !== expectedIds.length || ids.some((id) => !expectedIds.includes(id))
    setExpectedIds(ids)
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

  const handleReidentify = async () => {
    setReidentifying(true)
    try {
      await window.api.transcript.sweepSpeakers({ recordingId })
    } finally {
      // onSpeakersSwept clears the flag when segments change; clear it here
      // for the case where the sweep found nothing to update.
      setReidentifying(false)
    }
  }

  // ── Per-speaker stats ────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const byId = new Map<string, { count: number; totalConf: number; confCount: number }>()
    let unresolvedCount = 0

    for (const seg of segments) {
      const isUnresolved = !seg.speakerId || /^SPEAKER_\d+$/.test(seg.speakerId)
      if (isUnresolved) {
        unresolvedCount++
      } else {
        const entry = byId.get(seg.speakerId!) ?? { count: 0, totalConf: 0, confCount: 0 }
        entry.count++
        if (seg.speakerConfidence != null) {
          entry.totalConf += seg.speakerConfidence
          entry.confCount++
        }
        byId.set(seg.speakerId!, entry)
      }
    }

    return { byId, unresolvedCount }
  }, [segments])

  const hasStats = segments.length > 0

  if (!loaded) return null

  const selectedSpeakers = expectedIds
    .map((id) => allSpeakers.find((s) => s.id === id))
    .filter(Boolean) as SpeakerProfile[]

  return (
    <>
      <div className="rounded-lg border border-surface-700 bg-surface-800/60 p-3 space-y-2">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-zinc-200">Speakers</span>
          </div>
          <button
            className="btn-ghost flex items-center gap-1.5 text-xs px-2 py-1"
            onClick={() => setModalOpen(true)}
          >
            <Pencil className="w-3 h-3" />
            Edit
          </button>
        </div>

        {/* Sweeping indicator */}
        {(sweeping || reidentifying) && (
          <div className="flex items-center gap-1.5 text-xs text-accent">
            <Loader2 className="w-3 h-3 animate-spin" />
            {sweeping ? 'Re-identifying…' : 'Identifying…'}
          </div>
        )}

        {/* Speaker list */}
        {selectedSpeakers.length > 0 ? (
          <div className="space-y-1.5">
            {selectedSpeakers.map((sp) => {
              const spStats = stats.byId.get(sp.id)
              const avgConf = spStats && spStats.confCount > 0
                ? spStats.totalConf / spStats.confCount
                : null
              const segCount = spStats?.count ?? 0
              const dot = dotColor(sp.name)

              return (
                <div key={sp.id} className="flex items-center gap-2 min-w-0">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                  <span className="text-xs text-zinc-200 truncate flex-1 min-w-0">{sp.name}</span>
                  {hasStats && (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-zinc-600 tabular-nums">
                        {segCount} {segCount === 1 ? 'seg' : 'segs'}
                      </span>
                      {avgConf != null ? (
                        <span className={`text-xs font-mono tabular-nums ${avgConfidenceColor(avgConf)}`}>
                          {Math.round(avgConf * 100)}%
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-700">—</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <span className="text-xs text-amber-400/80 italic">
            No speakers set — matching against all profiles
          </span>
        )}

        {/* Unresolved count + Re-identify */}
        {hasStats && !isLive && (
          <div className={`flex items-center justify-between pt-1 border-t border-surface-700 ${
            stats.unresolvedCount > 0 ? '' : 'opacity-60'
          }`}>
            <div className="flex items-center gap-1.5">
              {stats.unresolvedCount > 0 ? (
                <>
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                  <span className="text-xs text-amber-400">
                    {stats.unresolvedCount} unresolved
                  </span>
                </>
              ) : (
                <span className="text-xs text-emerald-400">All speakers identified</span>
              )}
            </div>
            <button
              className="btn-ghost flex items-center gap-1 text-xs px-1.5 py-0.5"
              onClick={() => void handleReidentify()}
              disabled={reidentifying || sweeping}
              title="Re-run speaker identification with current voice profiles"
            >
              <RefreshCw className={`w-3 h-3 ${reidentifying ? 'animate-spin' : ''}`} />
              Re-identify
            </button>
          </div>
        )}
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
