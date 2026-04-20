import { useState, useEffect, useCallback, useRef } from 'react'
import { Mic2, Plus, Trash2, Upload, Pencil, Check, X, AudioLines, ChevronDown, ChevronRight, ChevronLeft, AlertCircle, Download, Loader2, Info, Play, Square, Users, MessageSquare } from 'lucide-react'
import type { TtsVoice, TtsVoiceSample, Qwen3ModelStatus, SpeakerProfile } from '@shared/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDuration(sec: number | null): string {
  if (sec === null) return ''
  return `${sec.toFixed(1)}s`
}

// ─── ModelStatusBanner ────────────────────────────────────────────────────────

interface ModelStatusBannerProps {
  status: Qwen3ModelStatus
  downloadProgress: number
  onDownload: () => void
}

function ModelStatusBanner({ status, downloadProgress, onDownload }: ModelStatusBannerProps) {
  if (status === 'ready') return null

  if (status === 'downloading') {
    return (
      <div className="card flex items-center gap-3 text-sm">
        <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
        <div className="flex-1">
          <div className="text-zinc-200 font-medium">Downloading F5-TTS model…</div>
          <div className="mt-1 h-1.5 rounded-full bg-surface-700 overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
        </div>
        <span className="text-zinc-500 tabular-nums">{downloadProgress}%</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="card border-red-500/30 bg-red-500/10 flex items-start gap-3 text-sm">
        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
        <div>
          <div className="text-red-300 font-medium">Model download failed</div>
          <div className="text-zinc-400 mt-0.5">Check your internet connection and try again.</div>
        </div>
        <button className="btn-secondary ml-auto shrink-0" onClick={onDownload}>Retry</button>
      </div>
    )
  }

  // not_downloaded
  return (
    <div className="card border-accent/30 bg-accent/5 flex items-start gap-3 text-sm">
      <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="text-zinc-100 font-medium">F5-TTS not downloaded</div>
        <div className="text-zinc-400 mt-0.5">
          Download the model (~1.8 GB) to enable AI voice cloning. The download only happens once and is stored locally.
        </div>
      </div>
      <button className="btn-primary flex items-center gap-1.5 shrink-0" onClick={onDownload}>
        <Download className="w-3.5 h-3.5" />
        Download
      </button>
    </div>
  )
}

// ─── SampleRow ────────────────────────────────────────────────────────────────

interface SampleRowProps {
  sample: TtsVoiceSample
  onDelete: (sampleId: string) => Promise<void>
}

function SampleRow({ sample, onDelete }: SampleRowProps) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleDelete = async () => {
    setBusy(true)
    try {
      await onDelete(sample.id)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const filename = sample.audioPath.split('/').pop() ?? sample.audioPath

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg bg-surface-800 text-sm">
      <AudioLines className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-zinc-200 truncate">{filename}</div>
        {sample.transcript && (
          <div className="text-zinc-500 truncate text-xs mt-0.5 italic">"{sample.transcript}"</div>
        )}
      </div>
      {sample.durationSec !== null && (
        <span className="text-zinc-500 text-xs tabular-nums shrink-0">{formatDuration(sample.durationSec)}</span>
      )}
      <span className="text-zinc-600 text-xs shrink-0">{formatDate(sample.createdAt)}</span>
      {confirming ? (
        <div className="flex items-center gap-1 shrink-0">
          <button
            disabled={busy}
            onClick={handleDelete}
            className="p-1 rounded text-red-400 hover:bg-red-500/20 transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-surface-700 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
          title="Delete sample"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

// ─── AddSampleFromSpeakerModal ────────────────────────────────────────────────

interface AddSampleFromSpeakerModalProps {
  voiceId: string
  onClose: () => void
  onAdded: (samples: TtsVoiceSample[]) => void
}

function AddSampleFromSpeakerModal({ voiceId, onClose, onAdded }: AddSampleFromSpeakerModalProps) {
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.speaker.getAll().then(({ speakers: sp }) => {
      const withRecordings = sp.filter((s) => s.recordingCount > 0)
      setSpeakers(withRecordings)
      if (withRecordings.length > 0) setSelectedId(withRecordings[0].id)
    })
  }, [])

  const handleAdd = async () => {
    if (!selectedId) { setError('Select a speaker first.'); return }
    setBusy(true)
    setError('')
    try {
      const res = await window.api.ttsVoice.addSamplesFromSpeaker({ voiceId, speakerId: selectedId })
      if (res.addedCount === 0) {
        setError('No usable audio segments found for this speaker (segments may be too short or unclipped).')
        return
      }
      onAdded(res.samples)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="card w-full max-w-md mx-4 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">Add Samples from Speaker</h2>
        <p className="text-xs text-zinc-400">
          VoiceBox will automatically clip the best speech segments attributed to the selected speaker
          across all your recordings and add them as reference audio.
        </p>

        {speakers.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">No identified speakers found. Transcribe a recording with diarization first.</p>
        ) : (
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Speaker</label>
            <select
              className="input w-full"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {speakers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.recordingCount} recording{s.recordingCount !== 1 ? 's' : ''})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn-primary flex items-center gap-1.5"
            onClick={handleAdd}
            disabled={busy || !selectedId || speakers.length === 0}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Add Clips
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── AddSampleFromRecordingModal ──────────────────────────────────────────────

interface Recording { id: string; title: string; createdAt: number }

interface AddFromRecordingModalProps {
  voiceId: string
  onClose: () => void
  onAdded: (sample: TtsVoiceSample) => void
}

function AddSampleFromRecordingModal({ voiceId, onClose, onAdded }: AddFromRecordingModalProps) {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [startSec, setStartSec] = useState('0')
  const [endSec, setEndSec] = useState('10')
  const [transcript, setTranscript] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.recording.getAll().then(({ recordings: recs }) => {
      const complete = recs.filter((r) => r.status === 'complete' && r.audioPath)
      setRecordings(complete as unknown as Recording[])
      if (complete.length > 0) setSelectedId(complete[0].id)
    })
  }, [])

  const handleAdd = async () => {
    if (!selectedId) { setError('Select a recording first.'); return }
    setBusy(true)
    setError('')
    try {
      const res = await window.api.ttsVoice.addSampleFromRecording({
        voiceId,
        recordingId: selectedId,
        startSec: parseFloat(startSec) || 0,
        endSec: parseFloat(endSec) || 10,
        transcript: transcript.trim() || undefined,
      })
      onAdded(res.sample)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="card w-full max-w-md mx-4 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">Clip from Recording</h2>

        <label className="block text-xs text-zinc-400 mb-1">Recording</label>
        <select
          className="input w-full"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {recordings.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Start (seconds)</label>
            <input
              type="number" min="0" step="0.5"
              className="input w-full"
              value={startSec}
              onChange={(e) => setStartSec(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">End (seconds)</label>
            <input
              type="number" min="0" step="0.5"
              className="input w-full"
              value={endSec}
              onChange={(e) => setEndSec(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            Transcript <span className="text-zinc-600">(optional — improves cloning)</span>
          </label>
          <input
            type="text"
            className="input w-full"
            placeholder="What is spoken in this clip…"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary flex items-center gap-1.5" onClick={handleAdd} disabled={busy || !selectedId}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Add Clip
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── TestVoicePanel ───────────────────────────────────────────────────────────

interface TestVoicePanelProps {
  voice: TtsVoice
  modelReady: boolean
}

function TestVoicePanel({ voice, modelReady }: TestVoicePanelProps) {
  const [testText, setTestText] = useState('The quick brown fox jumps over the lazy dog.')
  const [busy, setBusy] = useState(false)
  const [audioPath, setAudioPath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)

  const canSynthesize = modelReady && (voice.sampleCount > 0 || Boolean(voice.voiceDesignPrompt))

  const handleSynthesize = async () => {
    if (!testText.trim()) return
    setBusy(true)
    setError('')
    setAudioPath(null)
    setPlaying(false)
    try {
      const res = await window.api.ttsVoice.synthesize({ voiceId: voice.id, text: testText.trim() })
      setAudioPath(res.audioPath)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handlePlay = () => {
    if (!audioPath) return
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    const audio = new Audio(`file://${audioPath}`)
    audioRef.current = audio
    audio.onended = () => setPlaying(false)
    audio.onerror = () => { setPlaying(false); setError('Playback failed.') }
    audio.play()
    setPlaying(true)
  }

  const handleStop = () => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlaying(false)
  }

  if (!modelReady) {
    return (
      <p className="text-xs text-zinc-600 italic">
        Download the F5-TTS model to test this voice.
      </p>
    )
  }

  if (!canSynthesize) {
    return (
      <p className="text-xs text-zinc-600 italic">
        Add at least one audio sample or a voice design description to enable testing.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs text-zinc-400">Test phrase</label>
      <div className="flex gap-2">
        <input
          type="text"
          className="input flex-1 text-sm"
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSynthesize() }}
          placeholder="Enter text to synthesize…"
        />
        <button
          onClick={handleSynthesize}
          disabled={busy || !testText.trim()}
          className="btn-primary flex items-center gap-1.5 shrink-0"
          title="Generate speech"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>

      {audioPath && !busy && (
        <div className="flex items-center gap-2">
          <button
            onClick={playing ? handleStop : handlePlay}
            className="btn-secondary flex items-center gap-1.5 text-xs"
          >
            {playing ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {playing ? 'Stop' : 'Play'}
          </button>
          <span className="text-xs text-zinc-500">Ready to play</span>
          <button
            onClick={handleSynthesize}
            disabled={busy}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline ml-auto"
          >
            Regenerate
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

// ─── VoiceCard ────────────────────────────────────────────────────────────────

interface VoiceProgressInfo {
  percent: number
  message: string
  error?: string
}

interface VoiceCardProps {
  voice: TtsVoice
  modelReady: boolean
  onDelete: (id: string) => Promise<void>
  onRename: (id: string, name: string, description?: string, voiceDesignPrompt?: string) => Promise<void>
  progress?: VoiceProgressInfo | null
}

function VoiceCard({ voice, modelReady, onDelete, onRename, progress }: VoiceCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [samples, setSamples] = useState<TtsVoiceSample[]>([])
  const [loadingSamples, setLoadingSamples] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(voice.name)
  const [editDesc, setEditDesc] = useState(voice.description ?? '')
  const [editDesignPrompt, setEditDesignPrompt] = useState(voice.voiceDesignPrompt ?? '')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showAddFromRecording, setShowAddFromRecording] = useState(false)
  const [showAddFromSpeaker, setShowAddFromSpeaker] = useState(false)
  const [showTestPanel, setShowTestPanel] = useState(false)
  const [addSampleError, setAddSampleError] = useState('')

  const loadSamples = useCallback(async () => {
    setLoadingSamples(true)
    try {
      const res = await window.api.ttsVoice.getSamples({ voiceId: voice.id })
      setSamples(res.samples)
    } finally {
      setLoadingSamples(false)
    }
  }, [voice.id])

  useEffect(() => {
    if (expanded) void loadSamples()
  }, [expanded, loadSamples])

  const handleDelete = async () => {
    setBusy(true)
    try {
      await onDelete(voice.id)
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  const handleRename = async () => {
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    try {
      await onRename(
        voice.id,
        name,
        editDesc.trim() || undefined,
        editDesignPrompt.trim() || undefined,
      )
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFile = async () => {
    setAddSampleError('')
    setBusy(true)
    try {
      const res = await window.api.ttsVoice.addSample({ voiceId: voice.id })
      setSamples((prev) => [...prev, res.sample])
    } catch (err) {
      setAddSampleError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteSample = async (sampleId: string) => {
    await window.api.ttsVoice.deleteSample({ sampleId })
    setSamples((prev) => prev.filter((s) => s.id !== sampleId))
  }

  return (
    <>
      <div className="card space-y-3">
        {/* Header */}
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>

          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="space-y-2">
                <input
                  autoFocus
                  className="input w-full text-sm font-semibold"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(); if (e.key === 'Escape') setEditing(false) }}
                />
                <input
                  className="input w-full text-sm"
                  placeholder="Description (optional)"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
                />
                <textarea
                  className="input w-full text-sm resize-none"
                  rows={3}
                  placeholder="Voice design prompt (optional) — e.g. 'A warm, slightly husky male voice with a mild British accent.'"
                  value={editDesignPrompt}
                  onChange={(e) => setEditDesignPrompt(e.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="text-sm font-semibold text-zinc-100">{voice.name}</div>
                {voice.description && (
                  <div className="text-xs text-zinc-500 mt-0.5">{voice.description}</div>
                )}
                {voice.voiceDesignPrompt && (
                  <div className="text-xs text-zinc-600 mt-0.5 italic truncate" title={voice.voiceDesignPrompt}>
                    Design: "{voice.voiceDesignPrompt}"
                  </div>
                )}
              </>
            )}
            <div className="text-xs text-zinc-600 mt-1">
              {voice.sampleCount} sample{voice.sampleCount !== 1 ? 's' : ''} · Created {formatDate(voice.createdAt)}
            </div>
            {progress && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs ${progress.error ? 'text-red-400' : 'text-accent'}`}>
                    {progress.message}
                  </span>
                  {!progress.error && (
                    <span className="text-xs text-zinc-500 tabular-nums">{progress.percent}%</span>
                  )}
                </div>
                {!progress.error && (
                  <div className="h-1 rounded-full bg-zinc-700 overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all duration-500"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            {editing ? (
              <>
                <button
                  disabled={busy}
                  onClick={handleRename}
                  className="p-1.5 rounded text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  title="Save"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => { setEditing(false); setEditName(voice.name); setEditDesc(voice.description ?? ''); setEditDesignPrompt(voice.voiceDesignPrompt ?? '') }}
                  className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="p-1.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-surface-700 transition-colors"
                  title="Rename / edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                {confirmDelete ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={handleDelete}
                      className="p-1.5 rounded text-red-400 hover:bg-red-500/20 transition-colors"
                      title="Confirm delete"
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="p-1.5 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Delete voice"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Expanded samples panel */}
        {expanded && (
          <div className="ml-7 space-y-2">
            {loadingSamples ? (
              <div className="flex items-center gap-2 text-xs text-zinc-500 py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading samples…
              </div>
            ) : samples.length === 0 ? (
              <p className="text-xs text-zinc-500 py-1">
                No samples yet. Add audio clips to teach the AI this voice.
              </p>
            ) : (
              <div className="space-y-1.5">
                {samples.map((s) => (
                  <SampleRow key={s.id} sample={s} onDelete={handleDeleteSample} />
                ))}
              </div>
            )}

            {addSampleError && (
              <p className="text-xs text-red-400">{addSampleError}</p>
            )}

            {/* Add sample buttons */}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={handleImportFile}
                disabled={busy}
                className="btn-secondary flex items-center gap-1.5 text-xs"
                title="Import an audio file from disk"
              >
                <Upload className="w-3 h-3" />
                Import File
              </button>
              <button
                onClick={() => setShowAddFromRecording(true)}
                disabled={busy}
                className="btn-secondary flex items-center gap-1.5 text-xs"
                title="Clip from an existing recording"
              >
                <Mic2 className="w-3 h-3" />
                Clip from Recording
              </button>
              <button
                onClick={() => setShowAddFromSpeaker(true)}
                disabled={busy}
                className="btn-secondary flex items-center gap-1.5 text-xs"
                title="Auto-extract clips for a known speaker"
              >
                <Users className="w-3 h-3" />
                Add from Speaker
              </button>
            </div>

            {/* Voice design prompt notice */}
            {voice.voiceDesignPrompt && (
              <div className="rounded-md bg-surface-800 px-3 py-2 text-xs text-zinc-400">
                <span className="text-zinc-300 font-medium">Design fallback:</span>{' '}
                If no samples are available, synthesis uses the voice description prompt.
              </div>
            )}

            {/* Test Voice panel */}
            <div className="pt-1 border-t border-surface-700">
              <button
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-1"
                onClick={() => setShowTestPanel((v) => !v)}
              >
                <Play className="w-3 h-3" />
                {showTestPanel ? 'Hide test' : 'Test voice'}
                {showTestPanel ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
              {showTestPanel && (
                <div className="mt-2">
                  <TestVoicePanel voice={voice} modelReady={modelReady} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {showAddFromRecording && (
        <AddSampleFromRecordingModal
          voiceId={voice.id}
          onClose={() => setShowAddFromRecording(false)}
          onAdded={(s) => {
            setSamples((prev) => [...prev, s])
            setShowAddFromRecording(false)
          }}
        />
      )}

      {showAddFromSpeaker && (
        <AddSampleFromSpeakerModal
          voiceId={voice.id}
          onClose={() => setShowAddFromSpeaker(false)}
          onAdded={(newSamples) => {
            setSamples((prev) => [...prev, ...newSamples])
            setShowAddFromSpeaker(false)
          }}
        />
      )}
    </>
  )
}

// ─── CreateVoiceModal ─────────────────────────────────────────────────────────

interface CreateVoiceModalProps {
  onClose: () => void
  onCreate: (voice: TtsVoice) => void
}

type CreationMode = 'prompt' | 'files' | 'speaker'
type WizardStep = 'mode' | 'form' | 'result'

function CreateVoiceModal({ onClose, onCreate }: CreateVoiceModalProps) {
  const [step, setStep] = useState<WizardStep>('mode')
  const [mode, setMode] = useState<CreationMode>('prompt')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [voiceDesignPrompt, setVoiceDesignPrompt] = useState('')
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('')
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdVoice, setCreatedVoice] = useState<TtsVoice | null>(null)
  const [addedSamples, setAddedSamples] = useState<TtsVoiceSample[]>([])

  useEffect(() => {
    window.api.speaker.getAll().then(({ speakers: sp }) => {
      const withRec = sp.filter((s) => s.recordingCount > 0)
      setSpeakers(withRec)
      if (withRec.length > 0) setSelectedSpeakerId(withRec[0].id)
    })
  }, [])

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('A name is required.'); return }
    if (mode === 'prompt' && !voiceDesignPrompt.trim()) { setError('Enter a voice description.'); return }
    if (mode === 'speaker' && !selectedSpeakerId) { setError('Select a speaker.'); return }
    setBusy(true)
    setError('')
    try {
      if (mode === 'prompt') {
        const res = await window.api.ttsVoice.create({
          name: trimmed,
          description: description.trim() || undefined,
          voiceDesignPrompt: voiceDesignPrompt.trim(),
        })
        onCreate(res.voice)
        onClose()
        return
      }

      if (mode === 'files') {
        const res = await window.api.ttsVoice.create({
          name: trimmed,
          description: description.trim() || undefined,
        })
        setCreatedVoice(res.voice)
        try {
          const sampleRes = await window.api.ttsVoice.addSample({ voiceId: res.voice.id })
          setAddedSamples([sampleRes.sample])
        } catch (e) {
          if ((e as Error).message !== 'File selection cancelled.') {
            setError((e as Error).message)
          }
        }
        setStep('result')
        return
      }

      if (mode === 'speaker') {
        const res = await window.api.ttsVoice.create({
          name: trimmed,
          description: description.trim() || undefined,
        })
        // Add to list and close immediately — sample extraction runs in the background
        onCreate(res.voice)
        onClose()
        // Fire-and-forget; progress events will update the card
        window.api.ttsVoice.addSamplesFromSpeaker({
          voiceId: res.voice.id,
          speakerId: selectedSpeakerId,
        }).catch(() => { /* errors surface via voiceCreationProgress events */ })
        return
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleAddMoreFile = async () => {
    if (!createdVoice) return
    setBusy(true)
    setError('')
    try {
      const sampleRes = await window.api.ttsVoice.addSample({ voiceId: createdVoice.id })
      setAddedSamples((prev) => [...prev, sampleRes.sample])
    } catch (e) {
      if ((e as Error).message !== 'File selection cancelled.') {
        setError((e as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleFinish = () => {
    if (createdVoice) onCreate({ ...createdVoice, sampleCount: addedSamples.length })
    onClose()
  }

  // ── Step 1: Mode selection ──────────────────────────────────────────────────
  if (step === 'mode') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="card w-full max-w-lg mx-4 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">New Voice</h2>
            <p className="text-xs text-zinc-400 mt-1">How do you want to create this voice?</p>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <button
              onClick={() => { setMode('prompt'); setStep('form') }}
              className="text-left rounded-lg border border-surface-600 bg-surface-800 hover:border-accent/60 hover:bg-accent/5 p-4 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-surface-700 group-hover:bg-accent/20 transition-colors shrink-0">
                  <MessageSquare className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <div className="text-sm font-medium text-zinc-100">Describe a Voice</div>
                  <div className="text-xs text-zinc-400 mt-1">Upload audio clips of the voice. F5-TTS clones it from your samples — no audio needed.</div>
                </div>
              </div>
            </button>

            <button
              onClick={() => { setMode('files'); setStep('form') }}
              className="text-left rounded-lg border border-surface-600 bg-surface-800 hover:border-accent/60 hover:bg-accent/5 p-4 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-surface-700 group-hover:bg-accent/20 transition-colors shrink-0">
                  <Upload className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <div className="text-sm font-medium text-zinc-100">Clone from Audio Files</div>
                  <div className="text-xs text-zinc-400 mt-1">Upload one or more audio clips of the voice. F5-TTS clones it from your samples — the more you provide, the better.</div>
                </div>
              </div>
            </button>

            <button
              onClick={() => { setMode('speaker'); setStep('form') }}
              disabled={speakers.length === 0}
              className={`text-left rounded-lg border border-surface-600 bg-surface-800 p-4 transition-colors group ${
                speakers.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:border-accent/60 hover:bg-accent/5'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-surface-700 group-hover:bg-accent/20 transition-colors shrink-0">
                  <Users className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <div className="text-sm font-medium text-zinc-100">Clone from Speaker</div>
                  <div className="text-xs text-zinc-400 mt-1">
                    {speakers.length === 0
                      ? 'No identified speakers yet — transcribe a recording with diarization first.'
                      : 'Pick an identified speaker. VoiceBox automatically extracts the best clips from their recordings.'}
                  </div>
                </div>
              </div>
            </button>
          </div>

          <div className="flex justify-end pt-1">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: Form ────────────────────────────────────────────────────────────
  if (step === 'form') {
    const modeLabel = mode === 'prompt' ? 'Describe a Voice' : mode === 'files' ? 'Clone from Audio Files' : 'Clone from Speaker'
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="card w-full max-w-sm mx-4 space-y-4">
          <div className="flex items-center gap-2">
            <button
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-surface-700 transition-colors"
              onClick={() => { setStep('mode'); setError('') }}
              title="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <h2 className="text-sm font-semibold text-zinc-100">{modeLabel}</h2>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Voice Name</label>
            <input
              autoFocus
              type="text"
              className="input w-full"
              placeholder="e.g. Jon, Narrator, Sales Bot"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); if (e.key === 'Escape') setStep('mode') }}
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Description <span className="text-zinc-600">(optional)</span></label>
            <input
              type="text"
              className="input w-full"
              placeholder="Brief description of this voice"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {mode === 'prompt' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Voice Design Prompt</label>
              <textarea
                className="input w-full resize-none h-24 text-xs"
                placeholder="e.g. 'A warm, deep male voice with a slight British accent, slow and measured pace'"
                value={voiceDesignPrompt}
                onChange={(e) => setVoiceDesignPrompt(e.target.value)}
              />
            </div>
          )}

          {mode === 'files' && (
            <p className="text-xs text-zinc-500">
              After clicking Create, a file picker will open so you can select your first audio clip. Supported: wav, mp3, m4a, aiff, flac, ogg.
            </p>
          )}

          {mode === 'speaker' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Speaker</label>
              {speakers.length === 0 ? (
                <p className="text-xs text-zinc-500 italic">Loading speakers…</p>
              ) : (
                <select
                  className="input w-full"
                  value={selectedSpeakerId}
                  onChange={(e) => setSelectedSpeakerId(e.target.value)}
                >
                  {speakers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.recordingCount} recording{s.recordingCount !== 1 ? 's' : ''})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => { setStep('mode'); setError('') }} disabled={busy}>Back</button>
            <button
              className="btn-primary flex items-center gap-1.5"
              onClick={handleSubmit}
              disabled={busy || !name.trim() || (mode === 'prompt' && !voiceDesignPrompt.trim())}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {mode === 'files' ? 'Create & Select File' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 3: Result (files / speaker) ───────────────────────────────────────
  const speakerName = speakers.find((s) => s.id === selectedSpeakerId)?.name
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="card w-full max-w-sm mx-4 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-100">Voice Created</h2>

        {createdVoice && (
          <div className="rounded-md bg-surface-800 px-3 py-2">
            <div className="text-sm font-medium text-zinc-100">{createdVoice.name}</div>
            {createdVoice.description && <div className="text-xs text-zinc-500 mt-0.5">{createdVoice.description}</div>}
          </div>
        )}

        {addedSamples.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs text-zinc-400">
              {mode === 'speaker'
                ? `Extracted ${addedSamples.length} clip${addedSamples.length !== 1 ? 's' : ''} from ${speakerName ?? 'speaker'}:`
                : `${addedSamples.length} audio sample${addedSamples.length !== 1 ? 's' : ''} added:`}
            </p>
            <div className="space-y-1">
              {addedSamples.map((s) => (
                <div key={s.id} className="text-xs text-zinc-400 flex items-center gap-2 py-1 px-2 bg-surface-800 rounded">
                  <AudioLines className="w-3 h-3 shrink-0 text-zinc-600" />
                  <span className="truncate">{s.audioPath.split('/').pop()}</span>
                  {s.durationSec !== null && <span className="tabular-nums text-zinc-600 shrink-0">{formatDuration(s.durationSec)}</span>}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500 italic">No samples added yet.</p>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          {mode === 'files' && (
            <button
              className="btn-secondary flex items-center gap-1.5"
              onClick={handleAddMoreFile}
              disabled={busy}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Add Another File
            </button>
          )}
          <button className="btn-primary" onClick={handleFinish} disabled={busy}>Done</button>
        </div>
      </div>
    </div>
  )
}

// ─── VoiceLibraryPage ─────────────────────────────────────────────────────────

export default function VoiceLibraryPage() {
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [modelStatus, setModelStatus] = useState<Qwen3ModelStatus>('not_downloaded')
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [voiceProgress, setVoiceProgress] = useState<Record<string, VoiceProgressInfo>>({})

  useEffect(() => {
    // Listen for download progress events from main process
    const unsub = window.api.ttsVoice.onDownloadProgress(({ progress, status }) => {
      setDownloadProgress(progress)
      setModelStatus(status)
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.ttsVoice.onVoiceCreationProgress((payload) => {
      if (payload.done) {
        setVoiceProgress((prev) => {
          const next = { ...prev }
          delete next[payload.voiceId]
          return next
        })
        if (!payload.error) {
          // Refresh the voice to pick up updated sampleCount
          window.api.ttsVoice.get({ voiceId: payload.voiceId }).then(({ voice }) => {
            if (voice) setVoices((prev) => prev.map((v) => (v.id === voice.id ? voice : v)))
          })
        } else {
          // Show the error on the card briefly
          setVoiceProgress((prev) => ({
            ...prev,
            [payload.voiceId]: { percent: 0, message: payload.error!, error: payload.error },
          }))
          setTimeout(() => {
            setVoiceProgress((prev) => {
              const next = { ...prev }
              delete next[payload.voiceId]
              return next
            })
          }, 5000)
        }
      } else {
        setVoiceProgress((prev) => ({
          ...prev,
          [payload.voiceId]: { percent: payload.percent, message: payload.message },
        }))
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const init = async () => {
      const [voicesRes, statusRes] = await Promise.all([
        window.api.ttsVoice.getAll(),
        window.api.ttsVoice.modelStatus(),
      ])
      setVoices(voicesRes.voices)
      setModelStatus(statusRes.status)
      setLoading(false)
    }
    void init()
  }, [])

  const handleDownload = async () => {
    setModelStatus('downloading')
    setDownloadProgress(0)
    try {
      const res = await window.api.ttsVoice.downloadModel()
      setModelStatus(res.status)
    } catch {
      setModelStatus('error')
    }
  }

  const handleDelete = async (id: string) => {
    await window.api.ttsVoice.delete({ voiceId: id })
    setVoices((prev) => prev.filter((v) => v.id !== id))
  }

  const handleRename = async (id: string, name: string, description?: string, voiceDesignPrompt?: string) => {
    const res = await window.api.ttsVoice.rename({ voiceId: id, name, description, voiceDesignPrompt })
    if (res.voice) {
      setVoices((prev) => prev.map((v) => (v.id === id ? res.voice! : v)))
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mic2 className="w-5 h-5 text-accent" />
          <h1 className="text-xl font-semibold text-zinc-100">Voice Library</h1>
        </div>
        <button
          className="btn-primary flex items-center gap-1.5"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="w-3.5 h-3.5" />
          New Voice
        </button>
      </div>

      <p className="text-sm text-zinc-400">
        Create named AI voices by providing reference audio clips. The F5-TTS engine clones
        the voice from your samples — no training required. Add more clips over time to improve quality.
      </p>

      <ModelStatusBanner
        status={modelStatus}
        downloadProgress={downloadProgress}
        onDownload={handleDownload}
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading voices…
        </div>
      ) : voices.length === 0 ? (
        <div className="card text-center py-10 space-y-3">
          <AudioLines className="w-8 h-8 text-zinc-600 mx-auto" />
          <div className="text-sm text-zinc-400">No voices yet</div>
          <div className="text-xs text-zinc-500">
            Click <span className="text-zinc-300">New Voice</span> to create your first cloned voice.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {voices.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              modelReady={modelStatus === 'ready'}
              onDelete={handleDelete}
              onRename={handleRename}
              progress={voiceProgress[v.id] ?? null}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateVoiceModal
          onClose={() => setShowCreate(false)}
          onCreate={(v) => setVoices((prev) => [...prev, v])}
        />
      )}
    </div>
  )
}
