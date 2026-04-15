import { useState } from 'react'
import type { TranscriptSegment } from '@shared/types'
import SpeakerBadge from './SpeakerBadge'
import { Pencil, Check, X, UserPlus, Play } from 'lucide-react'
import { useTranscriptStore } from '../../store/transcriptStore'

interface Props {
  segment: TranscriptSegment
  onLabelSpeaker: () => void
  /** Current audio playback position in seconds (for highlight) */
  playbackSeconds?: number
  /** Called when user clicks the play button to seek to this segment */
  onSeek?: (seconds: number) => void
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function TranscriptSegmentRow({ segment, onLabelSpeaker, playbackSeconds, onSeek }: Props) {
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(segment.text)
  const editSegment = useTranscriptStore((s) => s.editSegment)

  const isActive = playbackSeconds != null
    && playbackSeconds >= segment.timestampStart
    && playbackSeconds < segment.timestampEnd

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
    <div className={`group flex gap-3 py-2 px-2 rounded-lg transition-colors ${
      isActive ? 'bg-accent/10 border border-accent/20' : 'hover:bg-surface-700/50'
    }`}>
      {/* Timestamp / play button */}
      <div className="w-12 shrink-0 pt-0.5">
        {onSeek ? (
          <button
            className="w-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-accent hover:text-accent/80"
            onClick={() => onSeek(segment.timestampStart)}
            title={`Play from ${formatTime(Math.round(segment.timestampStart * 1000))}`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
          </button>
        ) : null}
        <span className={`text-xs font-mono block text-center transition-all ${
          onSeek ? 'group-hover:hidden' : ''
        } ${isActive ? 'text-accent font-semibold' : 'text-zinc-500'}`}>
          {formatTime(Math.round(segment.timestampStart * 1000))}
        </span>
      </div>

      {/* Speaker badge */}
      <div className="w-24 shrink-0">
        <SpeakerBadge name={segment.speakerName} confidence={segment.speakerConfidence} />
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
          <p className={`text-sm leading-relaxed ${isActive ? 'text-white' : 'text-zinc-200'}`}>
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
