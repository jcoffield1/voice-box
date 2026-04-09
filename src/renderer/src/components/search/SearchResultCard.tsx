import { Link, useNavigate } from 'react-router-dom'
import type { SearchResult } from '@shared/types'
import SpeakerBadge from '../transcript/SpeakerBadge'
import { MessageSquare } from 'lucide-react'

interface Props {
  result: SearchResult
}

function formatTime(ms: number) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function SearchResultCard({ result }: Props) {
  const navigate = useNavigate()
  // Pass timestamp in ms as query param so RecordingPage can jump to it
  const timestampMs = Math.round(result.timestampStart * 1000)

  const handleAskAI = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const snippet = result.text.slice(0, 120)
    const ask = encodeURIComponent(`Tell me more about: "${snippet}"`)
    navigate(`/recordings/${result.recordingId}?t=${timestampMs}&ask=${ask}`)
  }

  return (
    <Link
      to={`/recordings/${result.recordingId}?t=${timestampMs}`}
      className="card block hover:border-surface-600 transition-colors group relative"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-sm font-medium text-accent truncate">{result.recordingTitle}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-zinc-400 font-mono">{formatTime(timestampMs)}</span>
          <button
            onClick={handleAskAI}
            title="Ask AI about this segment"
            className="opacity-0 group-hover:opacity-100 transition-opacity btn-ghost p-1 text-zinc-400 hover:text-accent"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {result.speakerName && (
        <div className="mb-1">
          <SpeakerBadge name={result.speakerName} />
        </div>
      )}

      <p className="text-sm text-zinc-300 leading-relaxed selectable">
        {result.snippet ?? result.text}
      </p>

      <div className="mt-2 flex items-center gap-3 text-xs text-zinc-600">
        <span>Score: {result.score.toFixed(3)}</span>
        <span className="capitalize">{result.matchType}</span>
      </div>
    </Link>
  )
}
