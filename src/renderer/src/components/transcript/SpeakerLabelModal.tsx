import { useState, useEffect, useRef } from 'react'
import type { TranscriptSegment, SpeakerProfile } from '@shared/types'
import type { RankedSpeakerCandidate } from '@shared/ipc-types'
import { X, User, UserPlus, Search, Zap } from 'lucide-react'

interface SaveResult {
  speakerName: string
  profileId?: string
}

interface Props {
  segment: TranscriptSegment
  onClose: () => void
  onSaved: (result: SaveResult) => Promise<void>
}

function isRawDiarizationLabel(id: string | null): boolean {
  return id != null && /^SPEAKER_\d+$/.test(id)
}

function confidenceColor(c: number): string {
  if (c >= 0.80) return 'text-emerald-400'
  if (c >= 0.65) return 'text-amber-400'
  return 'text-red-400'
}

export default function SpeakerLabelModal({ segment, onClose, onSaved }: Props) {
  const [allSpeakers, setAllSpeakers] = useState<SpeakerProfile[]>([])
  const [candidates, setCandidates] = useState<RankedSpeakerCandidate[]>([])
  const [rankLoading, setRankLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SpeakerProfile | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentSpeaker =
    segment.speakerId && !isRawDiarizationLabel(segment.speakerId) && segment.speakerName
      ? segment.speakerName
      : null

  // Load all speakers + voice rankings on mount
  useEffect(() => {
    window.api.speaker.getAll().then(({ speakers: all }) => {
      setAllSpeakers(all)
      // Pre-select current speaker if already assigned
      if (segment.speakerId && !isRawDiarizationLabel(segment.speakerId)) {
        const match = all.find((s) => s.id === segment.speakerId)
        if (match) setSelected(match)
      }
    })

    setRankLoading(true)
    window.api.transcript.rankSpeakers({
      recordingId: segment.recordingId,
      segmentId: segment.id
    }).then(({ candidates: ranked }) => {
      setCandidates(ranked)
    }).catch(() => {}).finally(() => setRankLoading(false))
  }, [segment.id, segment.recordingId, segment.speakerId])

  // All ranked candidates enriched with full profile
  type RichCandidate = { profile: SpeakerProfile; confidence: number; isVoiceMatch: boolean }
  const rankedAll: RichCandidate[] = candidates
    .map((c) => {
      const profile = allSpeakers.find((s) => s.id === c.speakerId)
      return profile ? { profile, confidence: c.confidence, isVoiceMatch: c.isVoiceMatch } : null
    })
    .filter(Boolean) as RichCandidate[]

  // Top 3 for the default (no-query) view
  const topMatches = rankedAll.slice(0, 3)

  const q = query.trim().toLowerCase()
  const queryMatchesExisting = allSpeakers.some((s) => s.name.toLowerCase() === q)
  const canCreateNew = q.length > 0 && !queryMatchesExisting

  // Search: first show ranked speakers matching the query (with confidence), then
  // any remaining allSpeakers matches that weren't in the ranked list.
  const searchResults: Array<RichCandidate | { profile: SpeakerProfile; confidence: null; isVoiceMatch: false }> =
    q.length > 0
      ? [
          ...rankedAll.filter((r) => r.profile.name.toLowerCase().includes(q)),
          ...allSpeakers
            .filter(
              (s) =>
                s.name.toLowerCase().includes(q) &&
                !rankedAll.some((r) => r.profile.id === s.id)
            )
            .map((s) => ({ profile: s, confidence: null as null, isVoiceMatch: false as const }))
        ]
      : []

  const handleSelect = (sp: SpeakerProfile) => {
    setSelected(sp)
    setQuery('')
  }

  const handleSave = async () => {
    if (query.trim() && canCreateNew) {
      setSaving(true)
      try { await onSaved({ speakerName: query.trim() }) } finally { setSaving(false) }
    } else if (selected) {
      setSaving(true)
      try { await onSaved({ speakerName: selected.name, profileId: selected.id }) } finally { setSaving(false) }
    }
  }

  const canSave = (canCreateNew && query.trim().length > 0) || selected != null

  const showSearchResults = q.length > 0
  const hasVoiceMatches = !showSearchResults && topMatches.some((m) => m.isVoiceMatch)
  const hasConfirmedOnly = !showSearchResults && topMatches.length > 0 && !hasVoiceMatches
  // Legacy names kept for clarity
  const isShowingVoiceMatches = hasVoiceMatches
  const isShowingRecentFallback = hasConfirmedOnly

  // Pin selected speaker at top if not already visible in the current list
  const visibleList = showSearchResults ? searchResults : topMatches
  const selectedPinned =
    selected != null && !visibleList.some((r) => r.profile.id === selected.id)
      ? selected
      : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-[26rem] space-y-4 shadow-2xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <h2 className="font-semibold text-zinc-100">Who is speaking here?</h2>
          <button className="btn-ghost p-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Segment preview */}
        <div className="shrink-0 px-3 py-2 rounded-lg bg-surface-700 border border-surface-600">
          <p className="text-xs text-zinc-400 line-clamp-2 italic">"{segment.text}"</p>
        </div>

        {/* Current assignment */}
        {currentSpeaker && (
          <div className="shrink-0 flex items-center gap-2 text-xs text-zinc-400">
            <User className="w-3.5 h-3.5 shrink-0" />
            <span>Currently assigned to <strong className="text-zinc-200">{currentSpeaker}</strong></span>
          </div>
        )}

        <p className="text-xs text-zinc-500 shrink-0 leading-relaxed">
          After you confirm a speaker, the app will try to match other transcript lines
          in this recording to the same voice automatically.
        </p>

        {/* Top voice matches or search results */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
          {/* Pinned selected speaker (not in ranked list — e.g. chosen during live recording) */}
          {selectedPinned && (
            <div className="mb-1">
              <p className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                <User className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400">Selected</span>
              </p>
              <button
                onClick={() => handleSelect(selectedPinned)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm bg-accent/20 border border-accent/40 text-zinc-100"
              >
                <User className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                <span className="flex-1 truncate">{selectedPinned.name}</span>
              </button>
            </div>
          )}
          {isShowingVoiceMatches && (
            <p className="text-xs text-zinc-500 mb-2 flex items-center gap-1">
              <Zap className="w-3 h-3 text-violet-400" />
              Top voice matches
            </p>
          )}
          {isShowingRecentFallback && (
            <p className="text-xs text-zinc-500 mb-2">Recently active speakers</p>
          )}
          {rankLoading && !showSearchResults && (
            <p className="text-xs text-zinc-600 px-1">Analysing voice…</p>
          )}
          {(showSearchResults ? searchResults : topMatches).map(({ profile: sp, confidence, isVoiceMatch }, idx) => {
            const isActive = selected?.id === sp.id
            // Separator between voice-matched and confirmed-only entries
            const prevIsVoiceMatch = idx > 0 && (showSearchResults ? searchResults : topMatches)[idx - 1].isVoiceMatch
            const showSeparator = isShowingVoiceMatches && prevIsVoiceMatch && !isVoiceMatch
            return (
              <div key={sp.id}>
                {showSeparator && (
                  <p className="text-xs text-zinc-600 mt-2 mb-1 px-1">Also in this recording</p>
                )}
                <button
                  onClick={() => handleSelect(sp)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors text-sm ${
                    isActive
                      ? 'bg-accent/20 border border-accent/40 text-zinc-100'
                      : 'hover:bg-surface-700 text-zinc-300 border border-transparent'
                  }`}
                >
                  <User className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                  <span className="flex-1 truncate">{sp.name}</span>
                  {isVoiceMatch && confidence !== null && (
                    <span className={`text-xs font-mono shrink-0 ${confidenceColor(confidence)}`}>
                      {Math.round(confidence * 100)}%
                    </span>
                  )}
                </button>
              </div>
            )
          })}
          {showSearchResults && searchResults.length === 0 && !canCreateNew && (
            <p className="text-xs text-zinc-600 px-1">No speakers found</p>
          )}
        </div>

        {/* Search + add box */}
        <div className="shrink-0 space-y-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
            <input
              ref={inputRef}
              className="input pl-8 text-sm"
              placeholder={allSpeakers.length > 0 ? 'Search or add new speaker…' : 'Enter speaker name…'}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
            />
          </div>
          {canCreateNew && (
            <button
              onClick={() => { setSelected(null); void handleSave() }}
              disabled={saving}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-surface-700 border border-dashed border-zinc-700 transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5 shrink-0" />
              Create "{query.trim()}"
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 shrink-0">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving || !canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}


