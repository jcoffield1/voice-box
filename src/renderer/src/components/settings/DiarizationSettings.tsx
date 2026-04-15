import { useState, useEffect } from 'react'
import { Eye, EyeOff, Check, Trash2 } from 'lucide-react'

export default function DiarizationSettings() {
  const [token, setToken] = useState('')
  const [hasExisting, setHasExisting] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.settings.getApiKey({ provider: 'huggingface' })
      .then(({ apiKey }) => setHasExisting(!!apiKey))
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    if (!token.trim()) return
    await window.api.settings.setApiKey({ provider: 'huggingface', apiKey: token.trim() })
    setHasExisting(true)
    setToken('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleDelete = async () => {
    await window.api.settings.deleteApiKey({ provider: 'huggingface' })
    setHasExisting(false)
  }

  return (
    <section className="card space-y-4">
      <h2 className="font-medium text-zinc-200">Speaker Diarization</h2>

      <p className="text-xs text-zinc-500 leading-relaxed">
        Speaker diarization uses{' '}
        <span className="text-zinc-400">pyannote/speaker-diarization-3.1</span>, a gated model on
        HuggingFace. To enable it, accept the model license at{' '}
        <span className="text-accent">huggingface.co/pyannote/speaker-diarization-3.1</span> and
        paste a HuggingFace access token below.
      </p>

      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-400">HuggingFace Access Token</label>

        {hasExisting ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-emerald-400 flex items-center gap-1">
              <Check className="w-3 h-3" /> Key stored in Keychain
            </span>
            <button
              type="button"
              className="btn-ghost py-1 px-2 text-xs hover:text-red-400 ml-auto"
              onClick={handleDelete}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                className="input w-full pr-9 text-sm font-mono"
                type={showToken ? 'text' : 'password'}
                placeholder="hf_..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
              />
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                onClick={() => setShowToken((v) => !v)}
                tabIndex={-1}
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <button
              className="btn-primary text-sm px-3 py-1.5 flex items-center gap-1.5"
              onClick={handleSave}
              disabled={!token.trim() || saved}
            >
              {saved ? <Check className="w-3.5 h-3.5" /> : null}
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
