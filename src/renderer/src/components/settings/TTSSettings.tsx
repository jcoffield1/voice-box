import { useState, useEffect } from 'react'
import { Volume2, ExternalLink, Loader2 } from 'lucide-react'
import type { MacOSVoice } from '@shared/ipc-types'

export default function TTSSettings() {
  const [voices, setVoices] = useState<MacOSVoice[]>([])
  const [selected, setSelected] = useState<string>('')
  const [rate, setRate] = useState<number>(185)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    const load = async () => {
      const [voicesRes, voiceSetting, rateSetting] = await Promise.all([
        window.api.ai.listVoices(),
        window.api.settings.get({ key: 'tts.voice' }),
        window.api.settings.get({ key: 'tts.rate' })
      ])
      setVoices(voicesRes.voices)
      setSelected(voiceSetting.value ?? '')
      setRate(rateSetting.value ? Number(rateSetting.value) : 185)
      setLoading(false)
    }
    void load()
  }, [])

  const handleVoiceChange = async (voice: string) => {
    setSelected(voice)
    await window.api.settings.set({ key: 'tts.voice', value: voice })
  }

  const handleRateChange = async (value: number) => {
    setRate(value)
    await window.api.settings.set({ key: 'tts.rate', value: String(value) })
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      await window.api.ai.speak({
        text: 'This is a preview of the selected voice.',
        rate,
        voice: selected || undefined
      })
    } finally {
      setTimeout(() => setTesting(false), 2500)
    }
  }

  const enVoices = voices.filter((v) => v.locale.startsWith('en'))
  const otherVoices = voices.filter((v) => !v.locale.startsWith('en'))

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <Volume2 className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-zinc-100">AI Voice Output</h2>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading voices…
        </div>
      ) : (
        <div className="space-y-3">
          {/* Voice selector */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Voice</label>
            <div className="flex gap-2">
              <select
                className="input flex-1"
                value={selected}
                onChange={(e) => void handleVoiceChange(e.target.value)}
              >
                <option value="">System default</option>
                {enVoices.length > 0 && (
                  <optgroup label="English">
                    {enVoices.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name}
                        {v.gender === 'VoiceGenderFemale' ? ' ♀' : v.gender === 'VoiceGenderMale' ? ' ♂' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {otherVoices.length > 0 && (
                  <optgroup label="Other languages">
                    {otherVoices.map((v) => (
                      <option key={v.name} value={v.name}>{v.name} ({v.locale})</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="btn-ghost py-2 px-3 text-xs shrink-0"
                disabled={testing}
                onClick={() => void handleTest()}
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Preview'}
              </button>
            </div>
          </div>

          {/* Speed */}
          <div>
            <div className="flex justify-between mb-1.5">
              <label className="text-xs text-zinc-400">Speed</label>
              <span className="text-xs text-zinc-500">{rate} wpm</span>
            </div>
            <input
              type="range"
              min={120}
              max={300}
              step={5}
              value={rate}
              onChange={(e) => void handleRateChange(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-zinc-600 mt-0.5">
              <span>Slow</span>
              <span>Fast</span>
            </div>
          </div>

          {/* Premium voices hint */}
          <p className="text-xs text-zinc-500 leading-relaxed">
            For more natural-sounding voices, download <strong className="text-zinc-400">Premium</strong> voices
            in macOS System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.
            They will appear in the list above after restarting.
          </p>
          <a
            href="#"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            onClick={(e) => {
              e.preventDefault()
              void window.api.settings.set({ key: '_openAccessibility', value: '1' })
            }}
          >
            <ExternalLink className="w-3 h-3" />
            Open Accessibility settings
          </a>
        </div>
      )}
    </div>
  )
}
