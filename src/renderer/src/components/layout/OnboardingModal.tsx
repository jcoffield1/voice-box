import { useState, useEffect } from 'react'
import { Mic, CheckCircle2, Activity, ChevronRight } from 'lucide-react'

const ONBOARDING_KEY = 'onboarding.complete'

type Step = 'welcome' | 'status' | 'done'

interface SystemStatus {
  ollama: boolean
  whisper: boolean
}

export default function OnboardingModal() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [name, setName] = useState('')
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)

  useEffect(() => {
    // Show modal only if onboarding hasn't been completed
    void (async () => {
      const result = await window.api.settings.get({ key: ONBOARDING_KEY })
      if (!result.value) setOpen(true)
    })()
  }, [])

  const checkStatus = async () => {
    setCheckingStatus(true)
    try {
      const result = await window.api.settings.getSystemStatus()
      setStatus({ ollama: result.ollamaAvailable, whisper: result.whisperAvailable })
    } catch {
      setStatus({ ollama: false, whisper: false })
    } finally {
      setCheckingStatus(false)
    }
  }

  const handleNext = async () => {
    if (step === 'welcome') {
      if (name.trim()) {
        await window.api.settings.set({ key: 'user.name', value: name.trim() })
      }
      setStep('status')
      void checkStatus()
    } else if (step === 'status') {
      setStep('done')
    }
  }

  const handleDone = async () => {
    await window.api.settings.set({ key: ONBOARDING_KEY, value: 'true' })
    setOpen(false)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface-800 border border-surface-600 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 pt-5">
          {(['welcome', 'status', 'done'] as Step[]).map((s) => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                s === step ? 'bg-accent' : 'bg-surface-600'
              }`}
            />
          ))}
        </div>

        <div className="p-8">
          {step === 'welcome' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center">
                  <Mic className="w-6 h-6 text-accent" />
                </div>
                <h2 className="text-xl font-semibold text-zinc-100">Welcome to VoiceBox</h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Transcribe, search, and chat with your recordings using local AI.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400">Your name (optional)</label>
                <input
                  className="input w-full"
                  placeholder="e.g. Jon Smith"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleNext()}
                  autoFocus
                />
                <p className="text-xs text-zinc-600">Used to identify you in transcripts.</p>
              </div>
              <button className="btn-primary w-full" onClick={handleNext}>
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {step === 'status' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center">
                  <Activity className="w-6 h-6 text-accent" />
                </div>
                <h2 className="text-xl font-semibold text-zinc-100">System Check</h2>
                <p className="text-sm text-zinc-400">
                  VoiceBox needs Whisper and Ollama to work.
                </p>
              </div>

              <div className="space-y-2">
                <StatusRow
                  label="Whisper (transcription)"
                  ok={status?.whisper ?? null}
                  checking={checkingStatus}
                  hint="Whisper is bundled — run 'npm run setup:python' to rebuild the environment"
                />
                <StatusRow
                  label="Ollama (local AI)"
                  ok={status?.ollama ?? null}
                  checking={checkingStatus}
                  hint="Download from ollama.ai and run: ollama serve"
                />
              </div>

              {!checkingStatus && status && (!status.ollama || !status.whisper) && (
                <p className="text-xs text-amber-400 leading-relaxed">
                  Some services are offline. You can still use VoiceBox — functionality will be limited until they're running.
                </p>
              )}

              <div className="flex gap-2">
                <button className="btn-ghost flex-1" onClick={checkStatus} disabled={checkingStatus}>
                  Re-check
                </button>
                <button className="btn-primary flex-1" onClick={handleNext}>
                  Continue
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                </div>
                <h2 className="text-xl font-semibold text-zinc-100">You're all set!</h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Start your first recording, or explore the Settings page to configure AI providers.
                </p>
              </div>
              <ul className="space-y-1.5 text-xs text-zinc-400">
                <li className="flex items-start gap-2"><span className="text-accent">•</span> Click <strong className="text-zinc-300">+ New Recording</strong> on the Recordings page</li>
                <li className="flex items-start gap-2"><span className="text-accent">•</span> Use <strong className="text-zinc-300">⌘⇧Space</strong> as a global push-to-talk shortcut in the AI panel</li>
                <li className="flex items-start gap-2"><span className="text-accent">•</span> Label speakers by saying <em className="text-zinc-300">"Speaker 1 is Jon"</em> in the AI chat</li>
              </ul>
              <button className="btn-primary w-full" onClick={handleDone}>
                Get Started
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusRow({
  label,
  ok,
  checking,
  hint
}: {
  label: string
  ok: boolean | null
  checking: boolean
  hint: string
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-700">
      <div className="mt-0.5">
        {checking || ok === null ? (
          <div className="w-3.5 h-3.5 rounded-full border-2 border-zinc-500 border-t-transparent animate-spin" />
        ) : ok ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <div className="w-3.5 h-3.5 rounded-full bg-red-500/30 border border-red-500/60" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-200">{label}</p>
        {!checking && ok === false && (
          <p className="text-xs text-zinc-500 mt-0.5">{hint}</p>
        )}
      </div>
      {!checking && (
        <span className={`text-xs font-medium ${ok ? 'text-emerald-400' : ok === false ? 'text-red-400' : 'text-zinc-500'}`}>
          {ok === null ? 'checking' : ok ? 'OK' : 'Offline'}
        </span>
      )}
    </div>
  )
}
