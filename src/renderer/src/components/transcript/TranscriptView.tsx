import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { useTranscript } from '../../hooks/useTranscript'
import { useTranscriptStore } from '../../store/transcriptStore'
import { useRecordingStore } from '../../store/recordingStore'
import TranscriptSegmentRow from './TranscriptSegmentRow'
import SpeakerLabelModal from './SpeakerLabelModal'
import type { TranscriptSegment } from '@shared/types'
import { Loader2, AlertTriangle, Eye, EyeOff, Search, ChevronUp, ChevronDown, X as XIcon } from 'lucide-react'

const LOW_CONFIDENCE_THRESHOLD = 0.7

interface Props {
  recordingId: string
  isLive: boolean
  jumpToSeconds?: number
  /** Current playback position from AudioPlayer (seconds) */
  playbackSeconds?: number
  /** Called when user clicks a segment play button */
  onSeek?: (seconds: number) => void
  /** Called when user clicks the pause button on the active segment */
  onPause?: () => void
  /** Called to resume playback from the current position (no seek) */
  onResume?: () => void
  /** Whether the AudioPlayer is currently playing */
  isAudioPlaying?: boolean
}

export default function TranscriptView({ recordingId, isLive, jumpToSeconds, playbackSeconds, onSeek, onPause, onResume, isAudioPlaying }: Props) {
  const { segments, loading } = useTranscript(recordingId)
  const liveSegments = useRecordingStore((s) => s.liveSegments)
  const loadTranscript = useTranscriptStore((s) => s.loadTranscript)
  const displaySegments = isLive ? liveSegments : segments

  // Reload from DB when recording stops so we pick up the persisted segments
  const wasLiveRef = useRef(isLive)
  useEffect(() => {
    if (wasLiveRef.current && !isLive && recordingId) {
      void loadTranscript(recordingId)
    }
    wasLiveRef.current = isLive
  }, [isLive, recordingId, loadTranscript])

  const [assignTarget, setAssignTarget] = useState<TranscriptSegment | null>(null)
  const [reviewMode, setReviewMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set())

  // Snapshot of speaker assignments used to detect which segments changed after a sweep
  const speakerSnapshotRef = useRef<Map<string, string | null>>(new Map())
  const diarizationError = useRecordingStore((s) => s.diarizationError)
  const setDiarizationError = useRecordingStore((s) => s.setDiarizationError)
  const postProcessingRecordingId = useRecordingStore((s) => s.postProcessingRecordingId)
  const isPostProcessing = !isLive && postProcessingRecordingId === recordingId

  // Reload transcript when diarization completes post-recording
  useEffect(() => {
    if (isLive) return
    const removeDone = window.api.transcript.onDiarizationComplete(({ recordingId: diarRecId }) => {
      if (diarRecId === recordingId) {
        void useTranscriptStore.getState().loadTranscript(recordingId)
      }
    })
    return () => { removeDone() }
  }, [isLive, recordingId])

  // Keep a snapshot of speaker assignments so we can diff after a sweep
  useEffect(() => {
    speakerSnapshotRef.current = new Map(displaySegments.map((s) => [s.id, s.speakerId]))
  }, [displaySegments])

  // Flash segments whose speaker changed as a result of a background sweep
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSweepFlash = useCallback(({ recordingId: rid, segments: newSegs }: { recordingId: string; segments: TranscriptSegment[] }) => {
    if (rid !== recordingId || isLive) return
    const snapshot = speakerSnapshotRef.current
    const changedIds = newSegs
      .filter((s) => snapshot.has(s.id) && snapshot.get(s.id) !== s.speakerId)
      .map((s) => s.id)
    if (changedIds.length === 0) return
    setFlashedIds(new Set(changedIds))
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setFlashedIds(new Set()), 2000)
  }, [recordingId, isLive])

  useEffect(() => {
    const remove = window.api.transcript.onSpeakersSwept(handleSweepFlash)
    return () => { remove(); if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current) }
  }, [handleSweepFlash])

  const bottomRef = useRef<HTMLDivElement>(null)
  const segmentRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Auto-scroll during live recording
  useEffect(() => {
    if (isLive) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveSegments, isLive])

  // Auto-scroll to the active (currently playing) segment
  useEffect(() => {
    if (playbackSeconds == null || isLive) return
    const active = displaySegments.find(
      (seg) => playbackSeconds >= seg.timestampStart && playbackSeconds < seg.timestampEnd
    )
    if (active) {
      const el = segmentRefs.current[active.id]
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [playbackSeconds, displaySegments, isLive])

  // Jump to a specific timestamp from search result
  useEffect(() => {
    if (jumpToSeconds == null || displaySegments.length === 0) return
    // Find the closest segment to the target time
    const target = displaySegments.reduce((closest, seg) => {
      const d = Math.abs(seg.timestampStart - jumpToSeconds)
      const dc = Math.abs(closest.timestampStart - jumpToSeconds)
      return d < dc ? seg : closest
    })
    const el = segmentRefs.current[target.id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-accent', 'rounded-lg')
      setTimeout(() => el.classList.remove('ring-2', 'ring-accent', 'rounded-lg'), 2500)
    }
  }, [jumpToSeconds, displaySegments])

  // Count low-confidence speaker assignments
  const lowConfidenceSegments = displaySegments.filter(
    (seg) => seg.speakerConfidence !== null && seg.speakerConfidence < LOW_CONFIDENCE_THRESHOLD
  )
  const shownSegments = reviewMode ? lowConfidenceSegments : displaySegments

  // ── Search: list of segment ids whose text contains the query (case-insensitive) ──
  const trimmedQuery = searchQuery.trim()
  const matchIds = useMemo(() => {
    if (!trimmedQuery) return [] as string[]
    const needle = trimmedQuery.toLowerCase()
    return shownSegments.filter((s) => s.text.toLowerCase().includes(needle)).map((s) => s.id)
  }, [trimmedQuery, shownSegments])

  // Reset cursor when the query or visible set changes
  useEffect(() => {
    setSearchIdx(0)
  }, [trimmedQuery])
  // Clamp cursor if matches shrink (e.g. switching to review mode)
  useEffect(() => {
    if (matchIds.length === 0) return
    if (searchIdx >= matchIds.length) setSearchIdx(0)
  }, [matchIds.length, searchIdx])

  // Scroll the active match into view whenever it changes
  const activeMatchId = matchIds[searchIdx] ?? null
  useEffect(() => {
    if (!activeMatchId) return
    const el = segmentRefs.current[activeMatchId]
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeMatchId])

  const gotoMatch = (delta: 1 | -1): void => {
    if (matchIds.length === 0) return
    setSearchIdx((i) => (i + delta + matchIds.length) % matchIds.length)
  }

  if (loading && !isLive) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading transcript…
      </div>
    )
  }

  if (displaySegments.length === 0) {
    if (isPostProcessing) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20 text-accent text-xs">
          <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
          <span>Analyzing recording — identifying speakers and generating summary…</span>
        </div>
      )
    }
    return (
      <div className="card flex-1 flex items-center justify-center text-zinc-500 text-sm">
        {isLive ? 'Waiting for speech…' : 'No transcript available.'}
      </div>
    )
  }

  return (
    <>
      {/* Post-recording processing banner */}
      {isPostProcessing && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20 text-accent text-xs">
          <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
          <span>Analyzing recording — identifying speakers and generating summary…</span>
        </div>
      )}

      {/* Diarization error banner */}
      {diarizationError && (
        <div className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{diarizationError}</span>
          </div>
          <button className="shrink-0 hover:text-red-200" onClick={() => setDiarizationError(null)}>✕</button>
        </div>
      )}

      {/* Low-confidence review banner */}
      {!isLive && lowConfidenceSegments.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              {lowConfidenceSegments.length} segment{lowConfidenceSegments.length !== 1 ? 's' : ''} with uncertain speaker assignments
            </span>
          </div>
          <button
            className="flex items-center gap-1.5 hover:text-amber-200 transition-colors font-medium"
            onClick={() => setReviewMode((v) => !v)}
          >
            {reviewMode ? (
              <>
                <EyeOff className="w-3.5 h-3.5" />
                Show all
              </>
            ) : (
              <>
                <Eye className="w-3.5 h-3.5" />
                Review
              </>
            )}
          </button>
        </div>
      )}

      {/* Search bar */}
      {!isLive && displaySegments.length > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-800/95 backdrop-blur border border-surface-600 shadow-sm">
          <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                gotoMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                setSearchQuery('')
              }
            }}
            placeholder="Search transcript…"
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none"
          />
          <span className="text-xs text-zinc-500 tabular-nums shrink-0">
            {trimmedQuery
              ? matchIds.length === 0
                ? 'No matches'
                : `${searchIdx + 1} / ${matchIds.length}`
              : ''}
          </span>
          <button
            className="btn-ghost p-1 disabled:opacity-30"
            onClick={() => gotoMatch(-1)}
            disabled={matchIds.length === 0}
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            className="btn-ghost p-1 disabled:opacity-30"
            onClick={() => gotoMatch(1)}
            disabled={matchIds.length === 0}
            title="Next match (Enter)"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {searchQuery && (
            <button
              className="btn-ghost p-1"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="card flex-1 overflow-y-auto space-y-1 selectable">
        {reviewMode && shownSegments.length === 0 && (
          <p className="text-xs text-zinc-500 text-center py-8">No uncertain segments found.</p>
        )}
        {shownSegments.map((seg) => (
          <div
            key={seg.id}
            ref={(el) => { segmentRefs.current[seg.id] = el }}
            className={
              reviewMode && seg.speakerConfidence !== null && seg.speakerConfidence < LOW_CONFIDENCE_THRESHOLD
                ? 'ring-1 ring-amber-500/40 rounded-lg'
                : ''
            }
          >
            <TranscriptSegmentRow
              segment={seg}
              onLabelSpeaker={() => setAssignTarget(seg)}
              playbackSeconds={!isLive ? playbackSeconds : undefined}
              onSeek={!isLive ? onSeek : undefined}
              onPause={!isLive ? onPause : undefined}
              onResume={!isLive ? onResume : undefined}
              isAudioPlaying={!isLive ? isAudioPlaying : false}
              highlightQuery={trimmedQuery || undefined}
              isCurrentMatch={seg.id === activeMatchId}
              isRecentlyUpdated={flashedIds.has(seg.id)}
            />
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {assignTarget && (
        <SpeakerLabelModal
          segment={assignTarget}
          onClose={() => setAssignTarget(null)}
          onSaved={async ({ speakerName, profileId }) => {
            await window.api.transcript.assignSpeaker({
              recordingId,
              segmentId: assignTarget.id,
              speakerId: assignTarget.speakerId ?? null,
              speakerName,
              profileId
            })
            // Update the segment optimistically in the store — no full reload so
            // scroll position is preserved. The background sweep will push any
            // additional auto-assignments via speakersSwept.
            const store = useTranscriptStore.getState()
            store.updateSegment({ ...assignTarget, speakerName, speakerId: profileId ?? assignTarget.speakerId ?? speakerName })
            setAssignTarget(null)
          }}
        />
      )}
    </>
  )
}
