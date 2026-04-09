import { useState } from 'react'
import type { TranscriptSegment } from '@shared/types'
import { X } from 'lucide-react'

interface Props {
  segment: TranscriptSegment
  onClose: () => void
  onSaved: (speakerName: string) => Promise<void>
}

export default function SpeakerLabelModal({ segment, onClose, onSaved }: Props) {
  const [name, setName] = useState(segment.speakerName ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSaved(name.trim())
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-96 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-zinc-100">Label Speaker</h2>
          <button className="btn-ghost p-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-zinc-400">
          Assign a name to speaker <strong className="text-zinc-200">{segment.speakerName ?? 'Unknown'}</strong>.
          This will update all segments with the same speaker label.
        </p>

        <input
          className="input"
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
          autoFocus
        />

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={!name.trim() || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
