import { useState, useEffect } from 'react'
import type { TranscriptSegment, SpeakerProfile } from '@shared/types'
import type { RankedSpeakerCandidate } from '@shared/ipc-types'
import { X, User, UserPlus, Search, Zap, ChevronLeft, Check } from 'lucide-react'

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

const CIRCLE_COLORS = [
  'bg-violet-500/25 text-violet-200',
  'bg-sky-500/25 text-sky-200',
  'bg-emerald-500/25 text-emerald-200',
  'bg-amber-500/25 text-amber-200',
  'bg-rose-500/25 text-rose-200',
  'bg-fuchsia-500/25 text-fuchsia-200',
]

function circleColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h += name.charCodeAt(i)
  return CIRCLE_COLORS[h % CIRCLE_COLORS.length]
}

function confidenceBarColor(c: number): string {
  if (c >= 0.80) return 'bg-emerald-400'
  if (c >= 0.60) return 'bg-amber-400'
  return 'bg-zinc-500'
}

function confidenceTextColor(c: number): string {
  if (c >= 0.80) return 'text-emerald-400'
  if (c >= 0.60) return 'text-amber-400'
  return 'text-zinc-500'
}

export default function SpeakerLabelModal({ segment, onClose, onSaved }: Props) {
  const [allSpeakers, setAllSpeakers] = useState<SpeakerProfile[]>([])
  const [candidates, setCandidates] = useState<RankedSpeakerCandidate[]>([])
  const [rankLoading, setRankLoading] = useState(false)
  const [expectedSpeakerIds, setExpectedSpeakerIds] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [expandedToSearch, setExpandedToSearch] = useState(false)

  // Search-mode state
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SpeakerProfile | null>(null)

  const currentSpeakerId =
    segment.speakerId && !isRawDiarizationLabel(segment.speakerId) ? segment.speakerId : null

  useEffect(() => {
    // Load all speakers, expected speaker IDs, and voice rankings in parallel
    Promise.all([
      window.api.speaker.getAll(),
      window.api.recording.getExpectedSpeakers({ recordingId: segment.recordingId }),
    ]).then(([{ speakers }, { speakerIds }]) => {
      setAllSpeakers(speakers)
      setExpectedSpeakerIds(speakerIds)
      // Pre-select current speaker for the search-mode fallback
      if (currentSpeakerId) {
        const match = speakers.find((s) => s.id === currentSpeakerId)
        if (match) setSelected(match)
      }
    }).catch(() => setExpectedSpeakerIds([]))

    setRankLoading(true)
    window.api.transcript.rankSpeakers({
      recordingId: segment.recordingId,
      segmentId: segment.id,
    }).then(({ candidates: ranked }) => {
      setCandidates(ranked)
    }).catch(() => {}).finally(() => setRankLoading(false))
  }, [segment.id, segment.recordingId, currentSpeakerId])

  // ── Derived data ──────────────────────────────────────────────────────────

  // Build a confidence map from ranked candidates
  const confidenceById = new Map(candidates.map((c) => [c.speakerId, c.confidence]))

  // Expected speakers sorted by voice confidence (highest first)
  const expectedSpeakers: Array<{ speaker: SpeakerProfile; confidence: number; isVoiceMatch: boolean }> =
    (expectedSpeakerIds ?? [])
      .map((id) => allSpeakers.find((s) => s.id === id))
      .filter(Boolean)
      .map((sp) => {
        const conf = confidenceById.get(sp!.id) ?? 0
        const candidate = candidates.find((c) => c.speakerId === sp!.id)
        return {
          speaker: sp!,
          confidence: conf,
          isVoiceMatch: candidate?.isVoiceMatch ?? false,
        }
      })
      .sort((a, b) => b.confidence - a.confidence)

  const useCardGrid = expectedSpeakers.length > 0 && !expandedToSearch

  // ── Search-mode derived ───────────────────────────────────────────────────

  type RichCandidate = { profile: SpeakerProfile; confidence: number; isVoiceMatch: boolean }
  const rankedAll: RichCandidate[] = candidates
    .map((c) => {
      const profile = allSpeakers.find((s) => s.id === c.speakerId)
      return profile ? { profile, confidence: c.confidence, isVoiceMatch: c.isVoiceMatch } : null
    })
    .filter(Boolean) as RichCandidate[]

  const q = query.trim().toLowerCase()
  const queryMatchesExisting = allSpeakers.some((s) => s.name.toLowerCase() === q)
  const canCreateNew = q.length > 0 && !queryMatchesExisting

  const searchResults: Array<{ profile: SpeakerProfile; confidence: number | null; isVoiceMatch: boolean }> =
    q.length > 0
      ? [
          ...rankedAll.filter((r) => r.profile.name.toLowerCase().includes(q)),
          ...allSpeakers
            .filter((s) => s.name.toLowerCase().includes(q) && !rankedAll.some((r) => r.profile.id === s.id))
            .map((s) => ({ profile: s, confidence: null, isVoiceMatch: false })),
        ]
      : rankedAll

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleQuickAssign = async (sp: SpeakerProfile) => {
    setSaving(true)
    try {
      await onSaved({ speakerName: sp.name, profileId: sp.id })
    } finally {
      setSaving(false)
    }
  }

  const handleSearchSave = async () => {
    if (q && canCreateNew) {
      setSaving(true)
      try { await onSaved({ speakerName: q.trim() }) } finally { setSaving(false) }
    } else if (selected) {
      setSaving(true)
      try { await onSaved({ speakerName: selected.name, profileId: selected.id }) } finally { setSaving(false) }
    }
  }

  const canSave = (canCreateNew && q.length > 0) || selected != null

  const MAX_SEARCH_RESULTS = 15
  const displayedResults = searchResults.slice(0, MAX_SEARCH_RESULTS)
  const hiddenResultCount = searchResults.length - displayedResults.length

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-[28rem] space-y-4 shadow-2xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          {expandedToSearch ? (
            <button
              className="btn-ghost p-1 flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
              onClick={() => { setExpandedToSearch(false); setQuery(''); setSelected(null) }}
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
          ) : (
            <h2 className="font-semibold text-zinc-100">Who is speaking here?</h2>
          )}
          <button className="btn-ghost p-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Segment preview */}
        <div className="shrink-0 px-3 py-2 rounded-lg bg-surface-700 border border-surface-600">
          <p className="text-xs text-zinc-400 line-clamp-2 italic">"{segment.text}"</p>
        </div>

        {useCardGrid ? (
          /* ── Card grid mode — expected speakers known ── */
          <div className="flex-1 overflow-y-auto min-h-0 space-y-3">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 shrink-0">
              <Zap className="w-3 h-3 text-violet-400" />
              <span>
                {rankLoading ? 'Analysing voice…' : 'Tap to assign — scores update as you confirm'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {expectedSpeakers.map(({ speaker, confidence, isVoiceMatch }) => {
                const isCurrentAssignment = speaker.id === currentSpeakerId
                const barPct = Math.round(confidence * 100)
                const colorClass = circleColor(speaker.name)
                return (
                  <button
                    key={speaker.id}
                    onClick={() => void handleQuickAssign(speaker)}
                    disabled={saving}
                    className={`relative flex flex-col gap-2 p-3 rounded-xl border text-left transition-colors ${
                      isCurrentAssignment
                        ? 'bg-accent/15 border-accent/40'
                        : 'bg-surface-700/60 border-surface-600 hover:bg-surface-700 hover:border-surface-500'
                    } ${saving ? 'opacity-60 cursor-not-allowed' : ''}`}
                  >
                    {/* Current assignment checkmark */}
                    {isCurrentAssignment && (
                      <Check className="absolute top-2 right-2 w-3.5 h-3.5 text-accent" />
                    )}

                    {/* Initial circle */}
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${colorClass}`}>
                      {speaker.name.slice(0, 1).toUpperCase()}
                    </div>

                    {/* Name */}
                    <div className="text-sm font-medium text-zinc-100 truncate pr-4">{speaker.name}</div>

                    {/* Confidence bar */}
                    {rankLoading ? (
                      <div className="h-1 bg-surface-600 rounded-full animate-pulse w-full" />
                    ) : isVoiceMatch ? (
                      <div className="space-y-0.5 w-full">
                        <div className="h-1.5 bg-surface-600 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${confidenceBarColor(confidence)}`}
                            style={{ width: `${barPct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className={`text-[10px] font-mono ${confidenceTextColor(confidence)}`}>
                            {barPct}%
                          </span>
                          <span className="text-[10px] text-zinc-600">voice match</span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-[10px] text-zinc-600">no voice data yet</span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Someone else escape hatch */}
            <button
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 hover:bg-surface-700 border border-dashed border-zinc-700 transition-colors"
              onClick={() => setExpandedToSearch(true)}
            >
              <UserPlus className="w-3.5 h-3.5 shrink-0" />
              Someone else…
            </button>
          </div>
        ) : (
          /* ── Search / list mode — no expected speakers or expanded ── */
          <>
            {!expandedToSearch && (
              <p className="text-xs text-zinc-500 shrink-0 leading-relaxed">
                After you confirm a speaker, the app will try to match other transcript lines
                in this recording to the same voice automatically.
              </p>
            )}

            <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
              {!expandedToSearch && (
                <p className="text-xs text-zinc-500 mb-2 flex items-center gap-1">
                  {rankedAll.some((r) => r.isVoiceMatch) ? (
                    <><Zap className="w-3 h-3 text-violet-400" />Top voice matches</>
                  ) : (
                    'Recently active speakers'
                  )}
                </p>
              )}
              {rankLoading && (
                <p className="text-xs text-zinc-600 px-1">Analysing voice…</p>
              )}
              {displayedResults.map(({ profile: sp, confidence, isVoiceMatch }) => {
                const isActive = selected?.id === sp.id
                return (
                  <button
                    key={sp.id}
                    onClick={() => { setSelected(sp); setQuery(sp.name) }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors text-sm ${
                      isActive
                        ? 'bg-accent/20 border border-accent/40 text-zinc-100'
                        : 'hover:bg-surface-700 text-zinc-300 border border-transparent'
                    }`}
                  >
                    <User className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                    <span className="flex-1 truncate">{sp.name}</span>
                    {isVoiceMatch && confidence !== null && (
                      <span className={`text-xs font-mono shrink-0 ${confidenceTextColor(confidence)}`}>
                        {Math.round(confidence * 100)}%
                      </span>
                    )}
                  </button>
                )
              })}
              {hiddenResultCount > 0 && (
                <p className="text-xs text-zinc-600 px-1 py-1">{hiddenResultCount} more — type to narrow results</p>
              )}
              {q.length > 0 && searchResults.length === 0 && !canCreateNew && (
                <p className="text-xs text-zinc-600 px-1">No speakers found</p>
              )}
            </div>

            {/* Search + add box */}
            <div className="shrink-0 space-y-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
                <input
                  autoFocus={expandedToSearch}
                  className="input pl-8 text-sm"
                  placeholder={allSpeakers.length > 0 ? 'Search or add new speaker…' : 'Enter speaker name…'}
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSelected(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSearchSave() }}
                />
              </div>
              {canCreateNew && (
                <button
                  onClick={() => void handleSearchSave()}
                  disabled={saving}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-surface-700 border border-dashed border-zinc-700 transition-colors"
                >
                  <UserPlus className="w-3.5 h-3.5 shrink-0" />
                  Create "{q.trim()}"
                </button>
              )}
            </div>

            <div className="flex justify-end gap-2 shrink-0">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={handleSearchSave} disabled={saving || !canSave}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
