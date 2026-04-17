import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import LiveRecordingModal from '../components/recording/LiveRecordingModal'
import RecordingList from '../components/recording/RecordingList'
import { useRecording } from '../hooks/useRecording'
import { Mic, Clock, FileText, AlertTriangle, CheckCircle, Upload } from 'lucide-react'
import type { SystemStatusResult } from '@shared/ipc-types'

function formatTotalDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const d = Math.floor(diff / 86400000)
  const h = Math.floor(diff / 3600000)
  const m = Math.floor(diff / 60000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}m ago`
  return 'just now'
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { recordings, loadingRecordings, deleteRecording, loadRecordings } = useRecording()
  const [showControls, setShowControls] = useState(false)
  const [importing, setImporting] = useState(false)
  const [systemStatus, setSystemStatus] = useState<SystemStatusResult | null>(null)

  useEffect(() => {
    window.api.settings.getSystemStatus()
      .then((s) => setSystemStatus(s))
      .catch(() => {})
  }, [])

  const handleImport = useCallback(async () => {
    setImporting(true)
    try {
      const result = await window.api.recording.import()
      await loadRecordings()
      navigate(`/recordings/${result.recordingId}`)
    } catch (err) {
      // User cancelled or an actual error — only log real errors
      const msg = (err as Error).message ?? ''
      if (!msg.includes('cancelled') && !msg.includes('Import cancelled')) {
        console.error('[Import] Failed:', msg)
      }
    } finally {
      setImporting(false)
    }
  }, [navigate, loadRecordings])

  // Stats
  const totalDuration = recordings.reduce((sum, r) => sum + (r.duration ?? 0), 0)
  const lastRecording = recordings.length > 0 ? recordings[0] : null

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* System status banner */}
      {systemStatus && (!systemStatus.ollamaAvailable || !systemStatus.whisperAvailable) && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
          <div className="text-sm text-yellow-200 space-y-1">
            {!systemStatus.ollamaAvailable && (
              <p>Ollama is not running — AI summarization and chat will be unavailable.
                <a href="https://ollama.ai" target="_blank" rel="noreferrer" className="underline ml-1">Install Ollama</a>
              </p>
            )}
            {!systemStatus.whisperAvailable && (
              <p>Whisper is not available — transcription will fail.
                Whisper is not available in the bundled environment. Try running <code className="font-mono text-xs bg-yellow-900/40 px-1 rounded">npm run setup:python</code> and restarting.
              </p>
            )}
          </div>
        </div>
      )}

      {systemStatus?.ollamaAvailable && systemStatus?.whisperAvailable && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-2.5 flex items-center gap-2">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs text-emerald-300">All services running</span>
          {systemStatus.ollamaModels.length > 0 && (
            <span className="text-xs text-zinc-500 ml-1">
              · {systemStatus.ollamaModels.length} Ollama model{systemStatus.ollamaModels.length !== 1 ? 's' : ''} available
            </span>
          )}
        </div>
      )}

      {/* Stats bar */}
      {recordings.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="card flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
              <FileText className="w-4 h-4 text-accent" />
            </div>
            <div>
              <div className="text-xl font-bold text-zinc-100">{recordings.length}</div>
              <div className="text-xs text-zinc-500">Recording{recordings.length !== 1 ? 's' : ''}</div>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
              <Clock className="w-4 h-4 text-accent" />
            </div>
            <div>
              <div className="text-xl font-bold text-zinc-100">{formatTotalDuration(totalDuration)}</div>
              <div className="text-xs text-zinc-500">Total duration</div>
            </div>
          </div>
          <div className="card flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
              <Mic className="w-4 h-4 text-accent" />
            </div>
            <div>
              <div className="text-xl font-bold text-zinc-100">
                {lastRecording ? formatRelative(lastRecording.createdAt) : '—'}
              </div>
              <div className="text-xs text-zinc-500">Last recording</div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-100">Recordings</h1>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost flex items-center gap-1.5"
            onClick={handleImport}
            disabled={importing}
          >
            <Upload className="w-3.5 h-3.5" />
            {importing ? 'Importing…' : 'Import Audio'}
          </button>
          <button
            className="btn-primary"
            onClick={() => setShowControls(true)}
          >
            New Recording
          </button>
        </div>
      </div>

      {showControls && (
        <LiveRecordingModal onClose={() => setShowControls(false)} />
      )}

      <RecordingList
        recordings={recordings}
        loading={loadingRecordings}
        onDelete={deleteRecording}
      />
    </div>
  )
}

