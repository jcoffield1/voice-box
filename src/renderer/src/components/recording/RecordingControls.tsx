import { useState } from 'react'
import { Mic, Square, Monitor } from 'lucide-react'
import { useRecordingStore } from '../../store/recordingStore'
import { useSettingsStore } from '../../store/settingsStore'
import AudioLevelBar from './AudioLevelBar'

interface Props {
  onDismiss: () => void
}

export default function RecordingControls({ onDismiss }: Props) {
  const [title, setTitle] = useState('')
  const [systemAudio, setSystemAudio] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const { isRecording, audioLevel, startRecording, stopRecording } = useRecordingStore()
  const { selectedInputDeviceId, audioDevices } = useSettingsStore()

  const handleStart = async () => {
    setStartError(null)
    setStarting(true)
    const label = title.trim() || `Recording ${new Date().toLocaleString()}`
    try {
        await startRecording(label, {
        sampleRate: 16000,
        channels: 1,
        inputDeviceId: selectedInputDeviceId,
        systemAudioEnabled: systemAudio
      })
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    await stopRecording()
    onDismiss()
  }

  if (isRecording) {
    return (
      <div className="card flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm text-zinc-200">Recording in progress</span>
          <AudioLevelBar level={audioLevel} />
        </div>
        <button className="btn-danger" onClick={handleStop}>
          <Square className="w-3.5 h-3.5" />
          Stop
        </button>
      </div>
    )
  }

  return (
    <div className="card space-y-4">
      <h2 className="text-sm font-medium text-zinc-200">New Recording</h2>
      <div className="space-y-3">
        <input
          className="input"
          placeholder="Recording title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {audioDevices.length > 0 && (
          <select
            className="input"
            value={selectedInputDeviceId ?? ''}
            onChange={(e) => useSettingsStore.getState().setSelectedInputDeviceId(e.target.value || null)}
          >
            <option value="">Default microphone</option>
            {audioDevices
              .filter((d) => d.type === 'input')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        )}
        <label className="flex items-center gap-2 cursor-pointer select-none group">
          <input
            type="checkbox"
            className="rounded border-surface-500 bg-surface-700 text-accent focus:ring-accent/50"
            checked={systemAudio}
            onChange={(e) => setSystemAudio(e.target.checked)}
          />
          <Monitor className="w-3.5 h-3.5 text-zinc-400 group-hover:text-zinc-200 transition-colors" />
          <span className="text-sm text-zinc-400 group-hover:text-zinc-200 transition-colors">
            Capture system audio
          </span>
          <span className="text-xs text-zinc-600">(requires BlackHole)</span>
        </label>
      </div>
      {startError && (
        <p className="text-xs text-red-400 leading-snug">{startError}</p>
      )}
      <div className="flex gap-2">
        <button className="btn-primary" onClick={handleStart} disabled={starting}>
          <Mic className="w-4 h-4" />
          {starting ? 'Starting…' : 'Start Recording'}
        </button>
        <button className="btn-ghost" onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </div>
  )
}
