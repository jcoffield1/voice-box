import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, Check, Trash2, Loader2, Wifi, WifiOff, RefreshCw, Download } from 'lucide-react'
import { useSettings } from '../../hooks/useSettings'
import type { LLMProviderType, LLMFeature } from '@shared/types'
import { MODEL_HINTS, MODEL_RECOMMENDED } from '../../data/modelHints'

interface PullState {
  status: string
  percent: number | null
}

const PROVIDERS: { id: LLMProviderType; label: string; hasKey: boolean; keyLabel?: string }[] = [
  { id: 'ollama', label: 'Ollama (local)', hasKey: false },
  { id: 'claude', label: 'Anthropic Claude', hasKey: true, keyLabel: 'Anthropic API Key' },
  { id: 'openai', label: 'OpenAI', hasKey: true, keyLabel: 'OpenAI API Key' }
]

const FEATURES: { id: LLMFeature; label: string; hint: string }[] = [
  { id: 'conversation',          label: 'Chat / Q&A',                  hint: MODEL_HINTS.conversation },
  { id: 'summarization',         label: 'Summarization',                hint: MODEL_HINTS.summarization },
  { id: 'intent',                label: 'Intent detection',             hint: MODEL_HINTS.intent },
  { id: 'embeddings',            label: 'Semantic search embeddings',   hint: MODEL_HINTS.embeddings },
  { id: 'transcript-refinement', label: 'Transcript refinement',        hint: MODEL_HINTS['transcript-refinement'] },
]

export default function LLMProviderSettings() {
  const { providerMap, modelMap, setProviderForFeature, setModelForFeature, availableModels, loadModels, saveApiKey } = useSettings()
  const [keys, setKeys] = useState<Partial<Record<LLMProviderType, string>>>({})
  const [hasExistingKey, setHasExistingKey] = useState<Partial<Record<LLMProviderType, boolean>>>({})
  const [showKey, setShowKey] = useState<Partial<Record<LLMProviderType, boolean>>>({})
  const [saved, setSaved] = useState<Partial<Record<LLMProviderType, boolean>>>({})
  const [testStatus, setTestStatus] = useState<Partial<Record<LLMProviderType, 'testing' | 'ok' | 'error'>>>({})
  const [testError, setTestError] = useState<Partial<Record<LLMProviderType, string>>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [pulling, setPulling] = useState<Partial<Record<LLMFeature, PullState | 'done' | 'error'>>>({})

  // Load whether each provider already has a key stored in keychain
  useEffect(() => {
    const cloudProviders: LLMProviderType[] = ['claude', 'openai']
    Promise.all(
      cloudProviders.map((p) =>
        window.api.settings.getApiKey({ provider: p }).then(({ apiKey }) => ({ p, has: !!apiKey }))
      )
    ).then((results) => {
      setHasExistingKey(Object.fromEntries(results.map(({ p, has }) => [p, has])))
    }).catch(() => {})
  }, [])

  // Load Ollama models on mount
  useEffect(() => {
    void handleRefreshModels()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRefreshModels = async () => {
    setModelsLoading(true)
    try {
      await loadModels('ollama')
    } finally {
      setModelsLoading(false)
    }
  }

  // Pull event listeners
  useEffect(() => {
    const offProgress = window.api.ai.onPullProgress((payload) => {
      const feature = Object.entries(MODEL_RECOMMENDED).find(([, m]) => m === payload.model)?.[0] as LLMFeature | undefined
      if (!feature) return
      setPulling((s) => ({ ...s, [feature]: { status: payload.status, percent: payload.percent } }))
    })
    const offDone = window.api.ai.onPullDone(async (payload) => {
      const feature = Object.entries(MODEL_RECOMMENDED).find(([, m]) => m === payload.model)?.[0] as LLMFeature | undefined
      if (!feature) return
      setPulling((s) => ({ ...s, [feature]: 'done' }))
      await loadModels('ollama')
      // Auto-select the newly pulled model for this feature
      setModelForFeature(feature, payload.model)
      await window.api.settings.setProviderForFeature({ feature, provider: 'ollama', model: payload.model })
      setTimeout(() => setPulling((s) => { const n = { ...s }; delete n[feature as LLMFeature]; return n }), 2000)
    })
    const offError = window.api.ai.onPullError((payload) => {
      const feature = Object.entries(MODEL_RECOMMENDED).find(([, m]) => m === payload.model)?.[0] as LLMFeature | undefined
      if (!feature) return
      setPulling((s) => ({ ...s, [feature]: 'error' }))
    })
    return () => { offProgress(); offDone(); offError() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePull = useCallback(async (feature: LLMFeature) => {
    const model = MODEL_RECOMMENDED[feature]
    if (!model) return
    setPulling((s) => ({ ...s, [feature]: { status: 'starting…', percent: null } }))
    await window.api.ai.pullModel({ model })
  }, [])

  const handleSaveKey = async (provider: LLMProviderType) => {
    const key = keys[provider]
    if (!key) return
    await saveApiKey(provider, key)
    setHasExistingKey((s) => ({ ...s, [provider]: true }))
    setKeys((ks) => ({ ...ks, [provider]: '' }))
    setSaved((s) => ({ ...s, [provider]: true }))
    setTimeout(() => setSaved((s) => ({ ...s, [provider]: false })), 2000)
  }

  const handleDeleteKey = async (provider: LLMProviderType) => {
    await window.api.settings.deleteApiKey({ provider })
    setHasExistingKey((s) => ({ ...s, [provider]: false }))
  }

  const handleTestProvider = async (provider: LLMProviderType) => {
    setTestStatus((s) => ({ ...s, [provider]: 'testing' }))
    setTestError((s) => ({ ...s, [provider]: undefined }))
    try {
      const result = await window.api.ai.testProvider({ provider })
      if (result.available) {
        setTestStatus((s) => ({ ...s, [provider]: 'ok' }))
        setTimeout(() => setTestStatus((s) => ({ ...s, [provider]: undefined })), 3000)
      } else {
        setTestStatus((s) => ({ ...s, [provider]: 'error' }))
        setTestError((s) => ({ ...s, [provider]: result.error ?? 'Unavailable' }))
      }
    } catch (err) {
      setTestStatus((s) => ({ ...s, [provider]: 'error' }))
      setTestError((s) => ({ ...s, [provider]: err instanceof Error ? err.message : 'Connection failed' }))
    }
  }

  const handleProviderChange = async (feature: LLMFeature, provider: LLMProviderType) => {
    setProviderForFeature(feature, provider)
    // Pick first available model for the new provider, or clear
    const models = availableModels[provider] ?? []
    const defaultModel = models[0]?.id ?? ''
    setModelForFeature(feature, defaultModel)
    await window.api.settings.setProviderForFeature({ feature, provider, model: defaultModel })
    // Load models for the new provider if not yet loaded
    if (!availableModels[provider]) {
      await loadModels(provider)
    }
  }

  const handleModelChange = async (feature: LLMFeature, model: string) => {
    setModelForFeature(feature, model)
    const provider = providerMap[feature] ?? 'ollama'
    await window.api.settings.setProviderForFeature({ feature, provider, model })
  }

  const ollamaModels = availableModels['ollama'] ?? []

  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold text-zinc-100">AI Providers</h2>

      {/* API keys */}
      <div className="card space-y-4">
        <h3 className="text-sm font-medium text-zinc-300">API Keys (stored in macOS Keychain)</h3>
        {PROVIDERS.filter((p) => p.hasKey).map((p) => (
          <div key={p.id}>
            <label className="block text-sm text-zinc-400 mb-1">{p.keyLabel}</label>
            {hasExistingKey[p.id] ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <Check className="w-3 h-3" /> Key stored in Keychain
                </span>
                <button
                  type="button"
                  className="btn-ghost py-1 px-2 text-xs hover:text-red-400 ml-auto"
                  onClick={() => void handleDeleteKey(p.id)}
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Remove
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    className="input pr-8"
                    type={showKey[p.id] ? 'text' : 'password'}
                    placeholder="sk-…"
                    value={keys[p.id] ?? ''}
                    onChange={(e) =>
                      setKeys((ks) => ({ ...ks, [p.id]: e.target.value }))
                    }
                  />
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    onClick={() =>
                      setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))
                    }
                    type="button"
                  >
                    {showKey[p.id] ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
                <button
                  className="btn-primary shrink-0"
                  onClick={() => void handleSaveKey(p.id)}
                  disabled={!keys[p.id]}
                >
                  {saved[p.id] ? <Check className="w-4 h-4" /> : 'Save'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Provider per feature */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">Model per Feature</h3>
          <button
            type="button"
            className="btn-ghost py-1 px-2 text-xs flex items-center gap-1.5"
            disabled={modelsLoading}
            onClick={() => void handleRefreshModels()}
          >
            {modelsLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh models
          </button>
        </div>
        {FEATURES.map((f) => {
          const provider = providerMap[f.id] ?? 'ollama'
          const currentModel = modelMap[f.id] ?? ''
          const modelsForProvider = provider === 'ollama' ? ollamaModels : (availableModels[provider] ?? [])
          return (
            <div key={f.id} className="space-y-1.5">
              <span className="text-xs text-zinc-500 uppercase tracking-wide">{f.label}</span>
              <div className="flex gap-2">
                <select
                  className="input w-40 shrink-0"
                  value={provider}
                  onChange={(e) => void handleProviderChange(f.id, e.target.value as LLMProviderType)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                {provider === 'ollama' ? (
                  ollamaModels.length > 0 ? (
                    <select
                      className="input flex-1 min-w-0"
                      value={currentModel}
                      onChange={(e) => void handleModelChange(f.id, e.target.value)}
                    >
                      {ollamaModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="input flex-1 text-zinc-500 text-xs flex items-center">
                      {modelsLoading ? 'Loading models…' : 'No models found — is Ollama running?'}
                    </span>
                  )
                ) : modelsForProvider.length > 0 ? (
                  <select
                    className="input flex-1 min-w-0"
                    value={currentModel}
                    onChange={(e) => void handleModelChange(f.id, e.target.value)}
                  >
                    {modelsForProvider.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input flex-1 min-w-0"
                    placeholder="Model name (e.g. claude-opus-4-5)"
                    value={currentModel}
                    onChange={(e) => void handleModelChange(f.id, e.target.value)}
                  />
                )}
              </div>
              {/* Hint + pull button */}
              {(() => {
                const recommended = MODEL_RECOMMENDED[f.id]
                const pullState = pulling[f.id]
                const alreadyInstalled = provider !== 'ollama' || !recommended ||
                  ollamaModels.some(m => m.id === recommended || m.id.startsWith(recommended.split(':')[0] + ':'))
                const isPulling = pullState && pullState !== 'done' && pullState !== 'error'
                return (
                  <div className="flex items-start gap-2">
                    <p className="text-xs text-zinc-400 leading-relaxed flex-1">{f.hint}</p>
                    {!alreadyInstalled && !isPulling && pullState !== 'done' && (
                      <button
                        type="button"
                        className="btn-ghost py-1 px-2 text-xs flex items-center gap-1 shrink-0 text-zinc-400 hover:text-zinc-200"
                        onClick={() => void handlePull(f.id)}
                      >
                        <Download className="w-3 h-3" />
                        Pull {recommended}
                      </button>
                    )}
                    {pullState === 'done' && (
                      <span className="text-xs text-emerald-400 flex items-center gap-1 shrink-0">
                        <Check className="w-3 h-3" /> Installed
                      </span>
                    )}
                    {pullState === 'error' && (
                      <span className="text-xs text-red-400 shrink-0">Pull failed</span>
                    )}
                  </div>
                )
              })()}
              {/* Pull progress bar */}
              {(() => {
                const pullState = pulling[f.id]
                if (!pullState || pullState === 'done' || pullState === 'error') return null
                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-zinc-500">
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {pullState.status}
                      </span>
                      {pullState.percent !== null && <span>{pullState.percent}%</span>}
                    </div>
                    {pullState.percent !== null && (
                      <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-300"
                          style={{ width: `${pullState.percent}%` }}
                        />
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>

      {/* Test connection */}
      <div className="card space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Test Connection</h3>
        {PROVIDERS.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3">
            <span className="text-sm text-zinc-400 min-w-0 truncate">{p.label}</span>
            <div className="flex items-center gap-2 shrink-0">
              {testStatus[p.id] === 'ok' && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <Wifi className="w-3.5 h-3.5" /> Connected
                </span>
              )}
              {testStatus[p.id] === 'error' && (
                <span className="text-xs text-red-400 flex items-center gap-1 max-w-[160px] truncate" title={testError[p.id]}>
                  <WifiOff className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{testError[p.id]}</span>
                </span>
              )}
              <button
                type="button"
                className="btn-ghost py-1 px-3 text-xs flex items-center gap-1.5 shrink-0"
                disabled={testStatus[p.id] === 'testing'}
                onClick={() => void handleTestProvider(p.id)}
              >
                {testStatus[p.id] === 'testing' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  'Test'
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
