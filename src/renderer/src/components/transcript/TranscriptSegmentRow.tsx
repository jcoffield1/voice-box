import { useState } from 'react'
import type { TranscriptSegment } from '@shared/types'
import SpeakerBadge from './SpeakerBadge'
import { Pencil, Check, X, UserPlus } from 'lucide-react'
import { useTranscriptStore } from '../../store/transcriptStore'

interface Props {
  segment: TranscriptSegment
  onLabelSpeaker: () => void
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function TranscriptSegmentRow({ segment, onLabelSpeaker }: Props) {
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(segment.text)
  const editSegment = useTranscriptStore((s) => s.editSegment)

  const handleSave = async () => {
    if (draftText.trim() !== segment.text) {
      await editSegment(segment.id, draftText.trim())
    }
    setEditing(false)
  }

  const handleCancel = () => {
    setDraftText(segment.text)
    setEditing(false)
  }

  return (
    <div className="group flex gap-3 py-2 px-2 rounded-lg hover:bg-surface-700/50 transition-colors">
      {/* Timestamp */}
      <span className="text-xs text-zinc-500 pt-0.5 w-12 shrink-0 font-mono">
        {formatTime(Math.round(segment.timestampStart * 1000))}
      </span>

      {/* Speaker badge */}
      <div className="w-24 shrink-0">
        <SpeakerBadge name={segment.speakerName} />
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex gap-2 items-start">
            <textarea
              className="input text-sm leading-relaxed resize-none min-h-[48px]"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              autoFocus
            />
            <div className="flex flex-col gap-1">
              <button className="btn-ghost p-1" onClick={handleSave} title="Save">
                <Check className="w-3.5 h-3.5 text-green-400" />
              </button>
              <button className="btn-ghost p-1" onClick={handleCancel} title="Cancel">
                <X className="w-3.5 h-3.5 text-zinc-400" />
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-200 leading-relaxed">
            {segment.text}
            {segment.isEdited && (
              <span className="ml-1 text-xs text-zinc-600">(edited)</span>
            )}
          </p>
        )}
      </div>

      {/* Row actions */}
      {!editing && (
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            className="btn-ghost p-1"
            onClick={() => { setDraftText(segment.text); setEditing(true) }}
            title="Edit text"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            className="btn-ghost p-1"
            onClick={onLabelSpeaker}
            title="Assign speaker"
          >
            <UserPlus className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
