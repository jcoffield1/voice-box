import { useState, useEffect } from 'react'
import { Eye, EyeOff, ExternalLink, Check, Loader2 } from 'lucide-react'

interface Props {
  children: React.ReactNode
}

/**
 * Blocks the entire app until a HuggingFace access token is stored.
 * The token is required to download the pyannote/speaker-diarization-3.1
 * gated model (one-time download; afterwards runs fully offline).
 */
export default function HuggingFaceSetupGate({ children }: Props) {
  const [checking, setChecking] = useState(true)
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.settings.getApiKey({ provider: 'huggingface' })
      .then(({ apiKey }) => {
        if (apiKey) setToken(apiKey)
        setHasToken(!!apiKey)
      })
      .catch(() => setHasToken(false))
      .finally(() => setChecking(false))
  }, [])

  // Re-show gate if a runtime 403 occurs (token saved but licenses not accepted)
  useEffect(() => {
    const unsub = window.api.transcript.onDiarizationError(({ type }) => {
      if (type === 'gated_repo') {
        // Pre-fill with the existing token so user just needs to click Save
        window.api.settings.getApiKey({ provider: 'huggingface' })
          .then(({ apiKey }) => { if (apiKey) setToken(apiKey) })
          .catch(() => {})
        setError('Access denied — make sure you have accepted all three model licenses below, then click Save.')
        setHasToken(false)
      }
    })
    return unsub
  }, [])

  const handleSave = async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('hf_')) {
      setError('HuggingFace tokens start with "hf_"')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await window.api.settings.setApiKey({ provider: 'huggingface', apiKey: trimmed })
      setHasToken(true)
    } catch {
      setError('Failed to save — please try again')
    } finally {
      setSaving(false)
    }
  }

  if (checking) return null

  if (hasToken) return <>{children}</>

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-900">
      <div className="w-full max-w-md mx-4 space-y-6">

        {/* Logo / header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto">
            {/* Key icon rendered as SVG to avoid an extra import */}
            <svg className="w-7 h-7 text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 21.75 8.25Z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">One-time setup required</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            VoiceBox uses pyannote speaker diarization models to identify who is speaking.
            These are gated models — you must accept <span className="text-zinc-300 font-medium">three</span> license
            agreements on HuggingFace and provide an access token so the weights can be downloaded to your machine.
          </p>
          <p className="text-xs text-zinc-500 leading-relaxed">
            The model runs <span className="text-zinc-400">entirely offline</span> after the initial download. Your token is never sent anywhere except HuggingFace.
          </p>
        </div>

        {/* Steps */}
        <div className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Setup steps</p>
          <ol className="space-y-2 text-sm text-zinc-300">
            <li className="flex gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">1</span>
              <span>
                Accept the license for{' '}
                <button
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                  onClick={() => window.open('https://huggingface.co/pyannote/speaker-diarization-3.1', '_blank')}
                >
                  pyannote/speaker-diarization-3.1
                  <ExternalLink className="w-3 h-3" />
                </button>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">2</span>
              <span>
                Accept the license for{' '}
                <button
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                  onClick={() => window.open('https://huggingface.co/pyannote/segmentation-3.0', '_blank')}
                >
                  pyannote/segmentation-3.0
                  <ExternalLink className="w-3 h-3" />
                </button>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">3</span>
              <span>
                Accept the license for{' '}
                <button
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                  onClick={() => window.open('https://huggingface.co/pyannote/speaker-diarization-community-1', '_blank')}
                >
                  pyannote/speaker-diarization-community-1
                  <ExternalLink className="w-3 h-3" />
                </button>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">4</span>
              <span>
                Create an access token at{' '}
                <button
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                  onClick={() => window.open('https://huggingface.co/settings/tokens', '_blank')}
                >
                  huggingface.co/settings/tokens
                  <ExternalLink className="w-3 h-3" />
                </button>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">5</span>
              <span>Paste the token below</span>
            </li>
          </ol>
        </div>

        {/* Token input */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                className="input w-full pr-9 font-mono text-sm"
                type={showToken ? 'text' : 'password'}
                placeholder="hf_..."
                value={token}
                autoFocus
                onChange={(e) => { setToken(e.target.value); setError(null) }}
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
              className="btn-primary px-4 flex items-center gap-1.5 shrink-0"
              onClick={handleSave}
              disabled={!token.trim() || saving}
            >
              {saving
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Check className="w-4 h-4" />
              }
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <p className="text-center text-xs text-zinc-600">
          Token is stored securely in your macOS Keychain and never leaves your machine.
        </p>
      </div>
    </div>
  )
}
