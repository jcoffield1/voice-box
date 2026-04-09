import { useLocation, matchPath } from 'react-router-dom'
import { AudioLines } from 'lucide-react'
import { useRecordingStore } from '../../store/recordingStore'
import AudioLevelBar from '../recording/AudioLevelBar'

export default function TopBar() {
  const { pathname } = useLocation()
  const isRecording = useRecordingStore((s) => s.isRecording)
  const audioLevel = useRecordingStore((s) => s.audioLevel)
  const recordings = useRecordingStore((s) => s.recordings)

  const detailMatch = matchPath('/recordings/:id', pathname)
  const detailRecording = detailMatch
    ? recordings.find((r) => r.id === detailMatch.params.id)
    : null

  let title: string
  if (detailRecording) {
    title = detailRecording.title
  } else if (pathname.startsWith('/recordings')) {
    title = 'Recordings'
  } else if (pathname.startsWith('/search')) {
    title = 'Search'
  } else if (pathname.startsWith('/speakers')) {
    title = 'Speakers'
  } else if (pathname.startsWith('/chat')) {
    title = 'AI Chat'
  } else if (pathname.startsWith('/settings')) {
    title = 'Settings'
  } else {
    title = ''
  }

  return (
    <header className="h-12 flex items-center justify-between px-6 bg-surface-900 border-b border-surface-700 app-region-drag">
      <span className="text-sm font-medium text-zinc-300 truncate">{title}</span>
      {isRecording && (
        <div className="flex items-center gap-2 app-region-no-drag">
          <AudioLines className="w-4 h-4 text-red-400" />
          <AudioLevelBar level={audioLevel} />
        </div>
      )}
    </header>
  )
}
