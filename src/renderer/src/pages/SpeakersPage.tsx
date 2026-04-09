import { useState, useEffect, useCallback } from 'react'
import type { SpeakerProfile } from '../../../../shared/types'
import { Users, Pencil, Trash2, Merge, Check, X, Mic, FileText } from 'lucide-react'

function speakerColor(name: string): string {
  const colors = [
    'bg-indigo-500', 'bg-emerald-500', 'bg-sky-500', 'bg-orange-500',
    'bg-pink-500', 'bg-violet-500', 'bg-teal-500', 'bg-yellow-500'
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface SpeakerCardProps {
  speaker: SpeakerProfile
  allSpeakers: SpeakerProfile[]
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onMerge: (sourceId: string, targetId: string) => Promise<void>
  onUpdateNotes: (id: string, notes: string | null) => Promise<void>
}

function SpeakerCard({ speaker, allSpeakers, onRename, onDelete, onMerge, onUpdateNotes }: SpeakerCardProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(speaker.name)
  const [merging, setMerging] = useState(false)
  const [mergeTarget, setMergeTarget] = useState('')
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState(speaker.notes ?? '')
  const [busy, setBusy] = useState(false)

  const saveRename = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === speaker.name) {
      setEditing(false)
      setName(speaker.name)
      return
    }
    setBusy(true)
    try {
      await onRename(speaker.id, trimmed)
    } finally {
      setBusy(false)
      setEditing(false)
    }
  }

  const confirmDelete = async () => {
    if (!confirm(`Delete speaker "${speaker.name}"? This cannot be undone.`)) return
    setBusy(true)
    try {
      await onDelete(speaker.id)
    } finally {
      setBusy(false)
    }
  }

  const confirmMerge = async () => {
    if (!mergeTarget) return
    const target = allSpeakers.find((s) => s.id === mergeTarget)
    if (!confirm(`Merge "${speaker.name}" into "${target?.name}"? All segments will be re-labelled.`)) return
    setBusy(true)
    try {
      await onMerge(speaker.id, mergeTarget)
    } finally {
      setBusy(false)
      setMerging(false)
      setMergeTarget('')
    }
  }

  const saveNotes = async () => {
    const trimmed = notes.trim()
    const current = speaker.notes ?? ''
    if (trimmed === current) return
    await onUpdateNotes(speaker.id, trimmed || null)
  }

  const initials = speaker.name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <div className="card flex items-start gap-4">
      {/* Avatar */}
      <div
        className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0 ${speakerColor(speaker.name)}`}
      >
        {initials || <Users className="w-4 h-4" />}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 space-y-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              className="input py-1 text-sm"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveRename()
                if (e.key === 'Escape') { setEditing(false); setName(speaker.name) }
              }}
            />
            <button className="btn-primary p-1.5" onClick={() => void saveRename()} disabled={busy}>
              <Check className="w-3.5 h-3.5" />
            </button>
            <button className="btn-ghost p-1.5" onClick={() => { setEditing(false); setName(speaker.name) }}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <p className="font-medium text-zinc-100 truncate">{speaker.name}</p>
        )}

        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="flex items-center gap-1">
            <Mic className="w-3 h-3" />
            {speaker.recordingCount} recording{speaker.recordingCount !== 1 ? 's' : ''}
          </span>
          <span>First: {formatDate(speaker.firstSeenAt)}</span>
          <span>Last: {formatDate(speaker.lastSeenAt)}</span>
          {speaker.voiceEmbedding && (
            <span className="text-emerald-400">Voice profile ✓</span>
          )}
        </div>

        {merging && (
          <div className="flex items-center gap-2 mt-2">
            <select
              className="input py-1 text-xs"
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
            >
              <option value="">Select target speaker…</option>
              {allSpeakers
                .filter((s) => s.id !== speaker.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
            </select>
            <button className="btn-primary py-1 px-2 text-xs" onClick={() => void confirmMerge()} disabled={!mergeTarget || busy}>
              Merge
            </button>
            <button className="btn-ghost py-1 px-2 text-xs" onClick={() => { setMerging(false); setMergeTarget('') }}>
              Cancel
            </button>
          </div>
        )}

        {notesOpen && (
          <div className="mt-2">
            <textarea
              className="input text-xs resize-none w-full"
              placeholder="Add notes about this speaker…"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => void saveNotes()}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      {!editing && !merging && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            className={`btn-ghost p-1.5 ${notesOpen ? 'text-accent' : ''}`}
            title="Notes"
            onClick={() => setNotesOpen((v) => !v)}
            disabled={busy}
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
          <button
            className="btn-ghost p-1.5"
            title="Rename speaker"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            className="btn-ghost p-1.5"
            title="Merge into another speaker"
            onClick={() => setMerging(true)}
            disabled={busy || allSpeakers.length < 2}
          >
            <Merge className="w-3.5 h-3.5" />
          </button>
          <button
            className="btn-ghost p-1.5 hover:text-red-400"
            title="Delete speaker"
            onClick={() => void confirmDelete()}
            disabled={busy}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

export default function SpeakersPage() {
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { speakers: all } = await window.api.speaker.getAll()
      setSpeakers(all)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleRename = async (id: string, name: string) => {
    const { speaker } = await window.api.speaker.rename({ speakerId: id, name })
    if (speaker) {
      setSpeakers((prev) => prev.map((s) => (s.id === id ? speaker : s)))
    }
  }

  const handleDelete = async (id: string) => {
    await window.api.speaker.delete({ speakerId: id })
    setSpeakers((prev) => prev.filter((s) => s.id !== id))
  }

  const handleMerge = async (sourceId: string, targetId: string) => {
    await window.api.speaker.merge({ sourceId, targetId })
    await load()
  }

  const handleUpdateNotes = async (id: string, notes: string | null) => {
    const { speaker } = await window.api.speaker.updateNotes({ speakerId: id, notes })
    if (speaker) {
      setSpeakers((prev) => prev.map((s) => (s.id === id ? speaker : s)))
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-100">Speakers</h1>
        <span className="text-sm text-zinc-500">
          {speakers.length} profile{speakers.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading && (
        <p className="text-sm text-zinc-500 text-center py-12">Loading…</p>
      )}

      {error && (
        <p className="text-sm text-red-400 text-center py-4">{error}</p>
      )}

      {!loading && speakers.length === 0 && (
        <div className="card text-center py-12 space-y-2">
          <Users className="w-8 h-8 text-zinc-600 mx-auto" />
          <p className="text-zinc-400">No speaker profiles yet.</p>
          <p className="text-xs text-zinc-600">
            Profiles are created automatically when you label speakers in transcripts.
          </p>
        </div>
      )}

      {!loading && speakers.length > 0 && (
        <div className="space-y-3">
          {speakers.map((s) => (
            <SpeakerCard
              key={s.id}
              speaker={s}
              allSpeakers={speakers}
              onRename={handleRename}
              onDelete={handleDelete}
              onMerge={handleMerge}
              onUpdateNotes={handleUpdateNotes}
            />
          ))}
        </div>
      )}
    </div>
  )
}
