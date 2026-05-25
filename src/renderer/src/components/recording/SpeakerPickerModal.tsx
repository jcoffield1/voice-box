import { useState, useEffect, useRef } from 'react'
import { X, Search, UserPlus, Check } from 'lucide-react'
import type { SpeakerProfile } from '@shared/types'

interface Props {
  selectedIds: string[]
  onSave: (speakerIds: string[]) => void
  onClose: () => void
}

export default function SpeakerPickerModal({ selectedIds, onSave, onClose }: Props) {
  const [allSpeakers, setAllSpeakers] = useState<SpeakerProfile[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set(selectedIds))
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.api.speaker.getAll().then(({ speakers }) => setAllSpeakers(speakers))
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [allSpeakers])

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = async () => {
    const name = query.trim()
    if (!name) return
    setCreating(true)
    try {
      const { speaker } = await window.api.speaker.create({ name })
      setAllSpeakers((prev) => [...prev, speaker])
      setChecked((prev) => new Set(prev).add(speaker.id))
      setQuery('')
    } finally {
      setCreating(false)
    }
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? allSpeakers.filter((s) => s.name.toLowerCase().includes(q))
    : allSpeakers
  const exactMatch = allSpeakers.some((s) => s.name.toLowerCase() === q)
  const canCreate = q.length > 0 && !exactMatch

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-[26rem] shadow-2xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-zinc-100">Speakers in this recording</h2>
          <button className="btn-ghost p-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-zinc-500 mb-3">
          Select everyone who participated. Only these speakers will be matched to the transcript.
        </p>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          <input
            ref={inputRef}
            className="input pl-8 text-sm"
            placeholder="Search or add new speaker…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) {
                e.preventDefault()
                void handleCreate()
              }
            }}
          />
        </div>

        {/* Speaker list */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5 mb-4 max-h-[40vh]">
          {filtered.map((sp) => {
            const isChecked = checked.has(sp.id)
            return (
              <button
                key={sp.id}
                onClick={() => toggle(sp.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${
                  isChecked
                    ? 'bg-accent/15 text-zinc-100'
                    : 'hover:bg-surface-700 text-zinc-400'
                }`}
              >
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                  isChecked
                    ? 'bg-accent border-accent'
                    : 'border-zinc-600'
                }`}>
                  {isChecked && <Check className="w-3.5 h-3.5 text-white" />}
                </div>
                <span className="flex-1 truncate">{sp.name}</span>
                {sp.voiceEmbedding && <span className="text-[10px] opacity-40">🎤 voice trained</span>}
              </button>
            )
          })}
          {filtered.length === 0 && !canCreate && (
            <p className="text-xs text-zinc-600 px-3 py-2">No speakers found</p>
          )}
        </div>

        {/* Create new */}
        {canCreate && (
          <button
            onClick={() => void handleCreate()}
            disabled={creating}
            className="w-full flex items-center gap-2 px-3 py-2.5 mb-4 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-surface-700 border border-dashed border-zinc-700 transition-colors"
          >
            <UserPlus className="w-4 h-4 shrink-0" />
            {creating ? 'Creating…' : `Create "${query.trim()}"`}
          </button>
        )}

        {/* Summary + actions */}
        <div className="flex items-center justify-between shrink-0 pt-2 border-t border-surface-700">
          <span className="text-xs text-zinc-500">
            {checked.size === 0
              ? 'No speakers selected — will match all'
              : `${checked.size} speaker${checked.size !== 1 ? 's' : ''} selected`}
          </span>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              onClick={() => onSave(Array.from(checked))}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
