import { useSettings } from '../../hooks/useSettings'
import { Loader2 } from 'lucide-react'

export default function AudioDeviceSettings() {
  const {
    audioDevices,
    selectedInputDeviceId,
    selectedOutputDeviceId,
    whisperModel,
    language,
    setSelectedInputDeviceId,
    setSelectedOutputDeviceId,
    setWhisperModel,
    setLanguage
  } = useSettings()

  const save = async (key: string, value: string) => {
    await window.api.settings.set({ key, value })
  }

  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold text-zinc-100">Audio & Transcription</h2>
      <div className="card space-y-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Input Device (Microphone)</label>
          {audioDevices.length === 0 ? (
            <p className="text-sm text-zinc-500 flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading devices…
            </p>
          ) : (
            <select
              className="input"
              value={selectedInputDeviceId ?? ''}
              onChange={(e) => {
                setSelectedInputDeviceId(e.target.value || null)
                void save('audio.inputDeviceId', e.target.value)
              }}
            >
              <option value="">Default</option>
              {audioDevices
                .filter((d) => d.type === 'input')
                .map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Output Device (System Audio)</label>
          <select
            className="input"
            value={selectedOutputDeviceId ?? ''}
            onChange={(e) => {
              setSelectedOutputDeviceId(e.target.value || null)
              void save('audio.outputDeviceId', e.target.value)
            }}
          >
            <option value="">Default</option>
            {audioDevices
              .filter((d) => d.type === 'output')
              .map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Whisper Model</label>
          <select
            className="input"
            value={whisperModel}
            onChange={(e) => {
              setWhisperModel(e.target.value)
              void save('whisper.model', e.target.value)
            }}
          >
            {['tiny', 'base', 'small', 'medium', 'large'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            Larger models are more accurate but require more RAM and GPU.
          </p>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Language</label>
          <select
            className="input"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value)
              void save('whisper.language', e.target.value)
            }}
          >
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
            <option value="auto">Auto-detect</option>
          </select>
        </div>
      </div>
    </section>
  )
}
