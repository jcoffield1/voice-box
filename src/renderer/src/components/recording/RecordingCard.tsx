import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Trash2, FileText, Clock, CheckCircle, AlertTriangle, X } from 'lucide-react'
import type { Recording } from '@shared/types'

interface Props {
  recording: Recording
  onDelete: (id: string) => void
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function statusColor(status: Recording['status']) {
  switch (status) {
    case 'recording': return 'text-zinc-500'
    case 'processing': return 'text-amber-400'
    case 'complete': return 'text-green-400'
    case 'error': return 'text-red-400'
    default: return 'text-zinc-500'
  }
}

export default function RecordingCard({ recording, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false)

  const created = new Date(recording.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  return (
    <div className="card flex items-center gap-4 group hover:border-surface-600 transition-colors">
      <div className="w-10 h-10 rounded-lg bg-surface-700 flex items-center justify-center flex-shrink-0">
        <FileText className="w-5 h-5 text-zinc-400" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to={`/recordings/${recording.id}`}
            className="block font-medium text-zinc-100 hover:text-accent transition-colors truncate"
          >
            {recording.title}
          </Link>
          {recording.summary && (
            <span className="flex items-center gap-0.5 text-xs text-emerald-400 shrink-0" title="Summary available">
              <CheckCircle className="w-3 h-3" />
              <span>Summary</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-zinc-500">
          <span>{created}</span>
          {recording.duration && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDuration(recording.duration)}
              </span>
            </>
          )}
          <span>·</span>
          <span className={statusColor(recording.status)}>
            {recording.status}
          </span>
        </div>
        {recording.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {recording.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="text-xs bg-accent/10 text-accent/80 rounded-full px-2 py-0.5 border border-accent/20"
              >
                {tag}
              </span>
            ))}
            {recording.tags.length > 4 && (
              <span className="text-xs text-zinc-600">+{recording.tags.length - 4}</span>
            )}
          </div>
        )}
      </div>

      <button
        className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-500 hover:text-red-400 p-1 rounded"
        onClick={() => setConfirming(true)}
        title="Delete recording"
      >
        <Trash2 className="w-4 h-4" />
      </button>

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirming(false) }}
        >
          <div className="card w-80 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-red-400" />
              </div>
              <h2 className="font-semibold text-zinc-100">Delete recording?</h2>
              <button className="btn-ghost p-1 ml-auto" onClick={() => setConfirming(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-zinc-400">
              <span className="font-medium text-zinc-200">{recording.title}</span> and its
              transcript will be permanently deleted. This cannot be undone.
            </p>

            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
              <button
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                onClick={() => { setConfirming(false); onDelete(recording.id) }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
