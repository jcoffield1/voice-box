import type { Recording } from '@shared/types'
import RecordingCard from './RecordingCard'
import { Loader2 } from 'lucide-react'

interface Props {
  recordings: Recording[]
  loading: boolean
  onDelete: (id: string) => void
}

export default function RecordingList({ recordings, loading, onDelete }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading recordings…
      </div>
    )
  }

  if (recordings.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-500 text-sm">
        No recordings yet. Click <strong>New Recording</strong> to get started.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {recordings.map((r) => (
        <RecordingCard key={r.id} recording={r} onDelete={onDelete} />
      ))}
    </div>
  )
}
