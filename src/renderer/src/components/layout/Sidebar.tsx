import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Mic, Search, Settings, List, Users, MessageSquare, FileText, ChevronLeft, ChevronRight } from 'lucide-react'
import { useRecordingStore } from '../../store/recordingStore'

const links = [
  { to: '/recordings', label: 'Recordings', icon: List },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/chat', label: 'AI Chat', icon: MessageSquare },
  { to: '/speakers', label: 'Speakers', icon: Users },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/settings', label: 'Settings', icon: Settings }
]

const STORAGE_KEY = 'sidebar-collapsed'

export default function Sidebar() {
  const isRecording = useRecordingStore((s) => s.isRecording)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')

  function toggle() {
    setCollapsed((prev) => {
      localStorage.setItem(STORAGE_KEY, String(!prev))
      return !prev
    })
  }

  return (
    <aside
      className={`flex-shrink-0 bg-surface-900 border-r border-surface-700 flex flex-col py-4 transition-[width] duration-200 ease-in-out ${
        collapsed ? 'w-14' : 'w-56'
      }`}
    >
      {/* App logo / title — doubles as a drag handle for the window */}
      {/* pt-5 ensures content clears the macOS traffic-light buttons (hiddenInset titlebar) */}
      <div className={`mb-6 pt-5 flex items-center app-region-drag ${collapsed ? 'justify-center px-0' : 'gap-2 px-4'}`}>
        <div
          className={`w-3 h-3 rounded-full shrink-0 transition-colors ${
            isRecording ? 'bg-red-500 animate-pulse' : 'bg-accent'
          }`}
        />
        {!collapsed && (
          <span className="font-semibold text-zinc-100 tracking-wide">VoiceBox</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 space-y-1">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `flex items-center rounded-lg text-sm transition-colors ${
                collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2'
              } ${
                isActive
                  ? 'bg-accent/20 text-accent'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-surface-700'
              }`
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {!collapsed && label}
          </NavLink>
        ))}
      </nav>

      {/* Recording indicator */}
      {isRecording && (
        <div className={`mt-auto ${collapsed ? 'mx-2' : 'mx-4'}`}>
          <div
            title={collapsed ? 'Recording…' : undefined}
            className={`p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center text-red-400 ${
              collapsed ? 'justify-center' : 'gap-2'
            }`}
          >
            <Mic className="w-3 h-3 shrink-0" />
            {!collapsed && <span className="text-xs font-medium">Recording…</span>}
          </div>
        </div>
      )}

      {/* Collapse / expand toggle */}
      <button
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={`app-region-no-drag mt-3 mx-2 flex items-center rounded-lg px-2 py-2 text-zinc-500 hover:text-zinc-200 hover:bg-surface-700 transition-colors text-xs ${
          collapsed ? 'justify-center' : 'gap-2'
        }`}
      >
        {collapsed ? <ChevronRight className="w-4 h-4 shrink-0" /> : (
          <>
            <ChevronLeft className="w-4 h-4 shrink-0" />
            <span>Collapse</span>
          </>
        )}
      </button>
    </aside>
  )
}
