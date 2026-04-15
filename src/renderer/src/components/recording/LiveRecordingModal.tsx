import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mic, Square, Monitor, X, UserPlus, User, Loader2 } from 'lucide-react'
import { useRecordingStore } from '../../store/recordingStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranscriptStore } from '../../store/transcriptStore'
import AudioLevelBar from './AudioLevelBar'
import { useMicPreview } from '../../hooks/useMicPreview'
import SpeakerLabelModal from '../transcript/SpeakerLabelModal'
import type { TranscriptSegment } from '@shared/types'

interface Props {
  onClose: () => void
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function isRawLabel(id: string | null): boolean {
  return id != null && /^SPEAKER_\d+$/.test(id)
}

export default function LiveRecordingModal({ onClose }: Props) {
  const [title, setTitle] = useState('')
  const [systemAudio, setSystemAudio] = useState(false)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [assignTarget, setAssignTarget] = useState<TranscriptSegment | null>(null)

  const navigate = useNavigate()

  const {
    isRecording, audioLevel, activeRecordingId,
    liveSegments, startRecording, stopRecording, updateLiveSegment
  } = useRecordingStore()
  const { selectedInputDeviceId, audioDevices } = useSettingsStore()
  const micPreviewLevel = useMicPreview(selectedInputDeviceId, !isRecording && !starting)

  const bottomRef = useRef<HTMLDivElement>(null)
  const prevIsRecordingRef = useRef(isRecording)

  // Close (and navigate to recording page) when recording stops externally (error / crash)
  const postProcessingRecordingId = useRecordingStore((s) => s.postProcessingRecordingId)
  useEffect(() => {
    if (prevIsRecordingRef.current && !isRecording) {
      if (postProcessingRecordingId) navigate(`/recordings/${postProcessingRecordingId}`)
      onClose()
    }
    prevIsRecordingRef.current = isRecording
  }, [isRecording, onClose, navigate, postProcessingRecordingId])

  // Elapsed timer
  useEffect(() => {
    if (!isRecording) { setElapsedSeconds(0); return }
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [isRecording])

  // Auto-scroll transcript to bottom as new segments arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveSegments.length])

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
    const id = activeRecordingId // capture before stopRecording clears it
    setStopping(true)
    try {
      await stopRecording()
    } finally {
      setStopping(false)
    }
    if (id) navigate(`/recordings/${id}`)
    onClose()
  }

  const handleAssignSave = useCallback(async ({
    speakerName,
    profileId
  }: { speakerName: string; profileId?: string }) => {
    if (!assignTarget || !activeRecordingId) return
    await window.api.transcript.assignSpeaker({
      recordingId: activeRecordingId,
      segmentId: assignTarget.id,
      speakerId: assignTarget.speakerId ?? null,
      speakerName,
      profileId
    })
    // Optimistically update the segment in the live list
    updateLiveSegment(assignTarget.id, {
      speakerName,
      speakerId: profileId ?? null
    })
    // Keep transcript store in sync too
    useTranscriptStore.getState().updateSegment({
      ...assignTarget,
      speakerName,
      speakerId: profileId ?? null
    })
    setAssignTarget(null)
  }, [assignTarget, activeRecordingId, updateLiveSegment])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        // Only close via X or Stop — not by clicking backdrop during recording
        if (!isRecording && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`bg-surface-800 border border-surface-600 rounded-2xl shadow-2xl flex flex-col transition-all duration-200 ${
          isRecording ? 'w-[52rem] max-h-[80vh]' : 'w-[28rem]'
        }`}
      >
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-700 shrink-0">
          {isRecording ? (
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
              <span className="text-sm font-medium text-zinc-200 truncate">
                {title.trim() || 'Recording…'}
              </span>
              <span className="text-xs font-mono text-zinc-400 tabular-nums shrink-0">
                {formatElapsed(elapsedSeconds)}
              </span>
              <div className="ml-1 flex-1 max-w-[120px]">
                <AudioLevelBar level={audioLevel} />
              </div>
            </div>
          ) : (
            <h2 className="text-base font-semibold text-zinc-100">New Recording</h2>
          )}

          <div className="flex items-center gap-2 shrink-0 ml-4">
            {isRecording && (
              <button
                className="btn-danger py-1.5 px-3 text-xs flex items-center gap-1.5"
                onClick={handleStop}
                disabled={stopping}
              >
                {stopping
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Square className="w-3.5 h-3.5" />}
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {!isRecording && (
              <button className="btn-ghost p-1.5" onClick={onClose} title="Cancel">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* ── Setup form (pre-recording) ─────────────────────────────────── */}
        {!isRecording && (
          <div className="px-5 py-5 space-y-4">
            <div className="space-y-3">
              <input
                className="input w-full"
                placeholder="Recording title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !starting) void handleStart() }}
                autoFocus
              />

              {audioDevices.length > 0 && (
                <select
                  className="input w-full"
                  value={selectedInputDeviceId ?? ''}
                  onChange={(e) =>
                    useSettingsStore.getState().setSelectedInputDeviceId(e.target.value || null)
                  }
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

            <div className="flex items-center gap-3">
              <button
                className="btn-primary"
                onClick={() => void handleStart()}
                disabled={starting}
              >
                <Mic className="w-4 h-4" />
                {starting ? 'Starting…' : 'Start Recording'}
              </button>
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <div className="flex items-center gap-2 ml-auto">
                <Mic
                  className={`w-3.5 h-3.5 transition-colors ${
                    micPreviewLevel > 0.05 ? 'text-accent' : 'text-zinc-600'
                  }`}
                />
                <AudioLevelBar level={micPreviewLevel} />
              </div>
            </div>
          </div>
        )}

        {/* ── Live transcript (during recording) ────────────────────────── */}
        {isRecording && (
          <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-0.5">
            {liveSegments.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-zinc-600 text-sm">
                Waiting for speech…
              </div>
            ) : (
              liveSegments.map((seg) => {
                const hasSpeaker = seg.speakerName && !isRawLabel(seg.speakerId)
                return (
                  <div
                    key={seg.id}
                    className="flex gap-3 py-1.5 px-2 rounded-lg hover:bg-surface-700/40 transition-colors group"
                  >
                    {/* Timestamp */}
                    <span className="text-xs text-zinc-600 pt-0.5 w-12 shrink-0 font-mono tabular-nums">
                      {formatTimestamp(seg.timestampStart)}
                    </span>

                    {/* Speaker chip */}
                    <div className="w-24 shrink-0">
                      <button
                        onClick={() => setAssignTarget(seg)}
                        className={`text-xs px-2 py-0.5 rounded-full border truncate max-w-full transition-colors ${
                          hasSpeaker
                            ? 'bg-violet-500/20 text-violet-300 border-violet-500/30 hover:bg-violet-500/30'
                            : 'border-dashed border-surface-500 text-zinc-600 hover:text-zinc-400 hover:border-zinc-500 flex items-center gap-1'
                        }`}
                        title={hasSpeaker ? `Reassign (${seg.speakerName})` : 'Assign speaker'}
                      >
                        {hasSpeaker ? (
                          <>
                            <User className="w-2.5 h-2.5 inline mr-0.5 opacity-60" />
                            {seg.speakerName}
                          </>
                        ) : (
                          <>
                            <UserPlus className="w-2.5 h-2.5 shrink-0" />
                            <span>Assign</span>
                          </>
                        )}
                      </button>
                    </div>

                    {/* Transcript text */}
                    <p className="flex-1 text-sm text-zinc-200 leading-snug pt-0.5">
                      {seg.text}
                    </p>
                  </div>
                )
              })
            )}
            <div ref={bottomRef} />
          </div>
        )}

        {/* Hint text during recording */}
        {isRecording && liveSegments.length > 0 && (
          <p className="px-5 py-2 text-xs text-zinc-600 border-t border-surface-700 shrink-0">
            Click a speaker chip to assign — recording continues uninterrupted.
          </p>
        )}
      </div>

      {/* ── Nested speaker assignment modal ─────────────────────────────── */}
      {assignTarget && (
        <SpeakerLabelModal
          segment={assignTarget}
          onClose={() => setAssignTarget(null)}
          onSaved={handleAssignSave}
        />
      )}
    </div>
  )
}
