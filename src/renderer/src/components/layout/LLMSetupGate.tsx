import { useState, useEffect } from 'react'
import { Eye, EyeOff, Check, Loader2, RefreshCw, ExternalLink, ChevronRight, X } from 'lucide-react'

const SKIP_KEY = 'llm.setup.skipped'

type Provider = 'ollama' | 'openai' | 'claude'
type GateState = 'checking' | 'passed' | 'setup'

interface Props {
  children: React.ReactNode
}

/**
 * Soft gate: if no LLM is configured (Ollama not running + no cloud key stored),
 * show a setup wizard so the user can choose how to configure AI.
 * Unlike the HF gate this can be skipped — recording + transcription still work.
 */
export default function LLMSetupGate({ children }: Props) {
  const [gateState, setGateState] = useState<GateState>('checking')

  useEffect(() => {
    void check()
  }, [])

  async function check() {
    // Already skipped before?
    const { value: skipped } = await window.api.settings.get({ key: SKIP_KEY })
    if (skipped) { setGateState('passed'); return }

    // Check Ollama + stored cloud keys in parallel
    const [status, openaiKey, claudeKey] = await Promise.all([
      window.api.settings.getSystemStatus().catch(() => ({ ollamaAvailable: false, ollamaModels: [] })),
      window.api.settings.getApiKey({ provider: 'openai' }).catch(() => ({ apiKey: null })),
      window.api.settings.getApiKey({ provider: 'claude' }).catch(() => ({ apiKey: null })),
    ])

    const ready = status.ollamaAvailable || !!openaiKey.apiKey || !!claudeKey.apiKey
    setGateState(ready ? 'passed' : 'setup')
  }

  const handlePassed = () => setGateState('passed')

  if (gateState === 'checking') return null
  if (gateState === 'passed') return <>{children}</>

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-surface-900">
      <LLMSetupWizard onDone={handlePassed} />
    </div>
  )
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

function LLMSetupWizard({ onDone }: { onDone: () => void }) {
  const [selected, setSelected] = useState<Provider | null>(null)

  const handleSkip = async () => {
    await window.api.settings.set({ key: SKIP_KEY, value: 'true' })
    onDone()
  }

  return (
    <div className="w-full max-w-lg mx-4 space-y-6">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="w-14 h-14 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto">
          <svg className="w-7 h-7 text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-zinc-100">Set up AI</h1>
        <p className="text-sm text-zinc-400 leading-relaxed">
          VoiceBox uses a language model for chat, summarization, and speaker labeling.
          Choose how you'd like to run it.
        </p>
      </div>

      {/* Provider cards */}
      {!selected && (
        <div className="space-y-3">
          <ProviderCard
            title="Ollama (recommended)"
            badge="100% local · free"
            badgeColor="text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
            description="Run open-source models on your Mac. No data leaves your machine."
            onClick={() => setSelected('ollama')}
          />
          <ProviderCard
            title="OpenAI"
            badge="cloud · paid"
            badgeColor="text-blue-400 bg-blue-400/10 border-blue-400/20"
            description="GPT-4o and friends. Fast and capable, requires an API key."
            onClick={() => setSelected('openai')}
          />
          <ProviderCard
            title="Anthropic Claude"
            badge="cloud · paid"
            badgeColor="text-violet-400 bg-violet-400/10 border-violet-400/20"
            description="Claude Sonnet and Haiku. Excellent reasoning, requires an API key."
            onClick={() => setSelected('claude')}
          />
        </div>
      )}

      {selected === 'ollama' && (
        <OllamaSetup onBack={() => setSelected(null)} onDone={onDone} />
      )}
      {selected === 'openai' && (
        <CloudKeySetup provider="openai" onBack={() => setSelected(null)} onDone={onDone} />
      )}
      {selected === 'claude' && (
        <CloudKeySetup provider="claude" onBack={() => setSelected(null)} onDone={onDone} />
      )}

      {!selected && (
        <div className="text-center">
          <button className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors" onClick={handleSkip}>
            Skip for now — I'll configure this later in Settings
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Provider option card ─────────────────────────────────────────────────────

function ProviderCard({
  title, badge, badgeColor, description, onClick
}: {
  title: string
  badge: string
  badgeColor: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-surface-800 border border-surface-600 hover:border-accent/40 rounded-xl p-4 transition-colors group"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">{title}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${badgeColor}`}>{badge}</span>
          </div>
          <p className="text-xs text-zinc-500 leading-relaxed">{description}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-accent transition-colors shrink-0" />
      </div>
    </button>
  )
}

// ─── Ollama setup ─────────────────────────────────────────────────────────────

function OllamaSetup({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  const [models, setModels] = useState<string[]>([])

  const handleCheck = async () => {
    setChecking(true)
    setStatus('idle')
    try {
      const result = await window.api.settings.getSystemStatus()
      if (result.ollamaAvailable) {
        setStatus('ok')
        setModels(result.ollamaModels)
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
        <X className="w-3.5 h-3.5" /> Back
      </button>

      <div className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
        <p className="text-sm font-medium text-zinc-200">Set up Ollama</p>
        <ol className="space-y-2 text-sm text-zinc-400">
          <li className="flex gap-3">
            <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">1</span>
            <span>
              Download and install from{' '}
              <button
                className="text-accent hover:underline inline-flex items-center gap-0.5"
                onClick={() => window.open('https://ollama.ai', '_blank')}
              >
                ollama.ai <ExternalLink className="w-3 h-3" />
              </button>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">2</span>
            <span>
              Pull a model — e.g.{' '}
              <code className="bg-surface-700 px-1.5 py-0.5 rounded text-xs text-zinc-300">ollama pull llama3.2</code>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-5 h-5 rounded-full bg-accent/20 text-accent text-xs flex items-center justify-center font-medium">3</span>
            <span>
              Start the server:{' '}
              <code className="bg-surface-700 px-1.5 py-0.5 rounded text-xs text-zinc-300">ollama serve</code>
            </span>
          </li>
        </ol>
      </div>

      {status === 'ok' && models.length > 0 && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 space-y-1">
          <p className="text-xs font-medium text-emerald-400 flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" /> Ollama is running
          </p>
          <p className="text-xs text-zinc-500">Models: {models.join(', ')}</p>
        </div>
      )}
      {status === 'error' && (
        <p className="text-xs text-amber-400">
          Ollama not detected. Make sure it's installed and <code className="bg-surface-700 px-1 rounded">ollama serve</code> is running.
        </p>
      )}

      <div className="flex gap-2">
        <button
          className="btn-ghost flex-1 flex items-center justify-center gap-1.5"
          onClick={handleCheck}
          disabled={checking}
        >
          {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Check connection
        </button>
        {status === 'ok' && (
          <button className="btn-primary flex-1" onClick={onDone}>
            Continue <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Cloud key setup ─────────────────────────────────────────────────────────

const CLOUD_INFO: Record<'openai' | 'claude', { label: string; hint: string; prefix: string; url: string }> = {
  openai: {
    label: 'OpenAI API Key',
    hint: 'Starts with "sk-"',
    prefix: 'sk-',
    url: 'https://platform.openai.com/api-keys',
  },
  claude: {
    label: 'Anthropic API Key',
    hint: 'Starts with "sk-ant-"',
    prefix: 'sk-ant-',
    url: 'https://console.anthropic.com/settings/keys',
  },
}

function CloudKeySetup({
  provider, onBack, onDone
}: {
  provider: 'openai' | 'claude'
  onBack: () => void
  onDone: () => void
}) {
  const info = CLOUD_INFO[provider]
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    const trimmed = key.trim()
    if (!trimmed) return
    if (!trimmed.startsWith(info.prefix)) {
      setError(`${info.label} should start with "${info.prefix}"`)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await window.api.settings.setApiKey({ provider, apiKey: trimmed })
      onDone()
    } catch {
      setError('Failed to save — please try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
        <X className="w-3.5 h-3.5" /> Back
      </button>

      <div className="bg-surface-800 border border-surface-600 rounded-xl p-4 space-y-3">
        <p className="text-sm font-medium text-zinc-200">{info.label}</p>
        <p className="text-xs text-zinc-500">
          Get your key from{' '}
          <button
            className="text-accent hover:underline inline-flex items-center gap-0.5"
            onClick={() => window.open(info.url, '_blank')}
          >
            {info.url.replace('https://', '')} <ExternalLink className="w-3 h-3" />
          </button>
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              className="input w-full pr-9 font-mono text-sm"
              type={showKey ? 'text' : 'password'}
              placeholder={info.prefix + '…'}
              value={key}
              autoFocus
              onChange={(e) => { setKey(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
            />
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              onClick={() => setShowKey((v) => !v)}
              tabIndex={-1}
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button
            className="btn-primary px-4 flex items-center gap-1.5 shrink-0"
            onClick={handleSave}
            disabled={!key.trim() || saving}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <p className="text-xs text-zinc-600">Stored securely in macOS Keychain.</p>
      </div>
    </div>
  )
}
