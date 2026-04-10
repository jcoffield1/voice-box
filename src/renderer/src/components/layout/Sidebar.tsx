import { NavLink } from 'react-router-dom'
import { Mic, Search, Settings, List, Users, MessageSquare } from 'lucide-react'
import { useRecordingStore } from '../../store/recordingStore'

const links = [
  { to: '/recordings', label: 'Recordings', icon: List },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/chat', label: 'AI Chat', icon: MessageSquare },
  { to: '/speakers', label: 'Speakers', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings }
]

export default function Sidebar() {
  const isRecording = useRecordingStore((s) => s.isRecording)

  return (
    <aside className="w-56 flex-shrink-0 bg-surface-900 border-r border-surface-700 flex flex-col py-4">
      {/* App logo / title — doubles as a drag handle for the window */}
      <div className="px-4 mb-6 flex items-center gap-2 app-region-drag">
        <div
          className={`w-3 h-3 rounded-full transition-colors ${
            isRecording ? 'bg-red-500 animate-pulse' : 'bg-accent'
          }`}
        />
        <span className="font-semibold text-zinc-100 tracking-wide">VoiceBox</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 space-y-1">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-accent/20 text-accent'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-surface-700'
              }`
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Recording indicator */}
      {isRecording && (
        <div className="mx-4 mt-auto p-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <div className="flex items-center gap-2 text-red-400 text-xs font-medium">
            <Mic className="w-3 h-3" />
            Recording…
          </div>
        </div>
      )}
    </aside>
  )
}
