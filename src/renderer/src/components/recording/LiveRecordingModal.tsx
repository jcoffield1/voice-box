import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Mic, Square, Monitor, X, UserPlus, User, Loader2, Pause, Play,
  Plus, Users, Trash2, Video, Camera, Layers, Check
} from 'lucide-react'
import { useRecordingStore } from '../../store/recordingStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranscriptStore } from '../../store/transcriptStore'
import AudioLevelBar from './AudioLevelBar'
import { useMicPreview } from '../../hooks/useMicPreview'
import SpeakerLabelModal from '../transcript/SpeakerLabelModal'
import type { TranscriptSegment, SpeakerProfile, VideoMode } from '@shared/types'
import type { ScreenSource } from '@shared/ipc-types'

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

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Fraction of the canvas width the webcam bubble occupies. */
const PIP_WIDTH_FRACTION = 0.22
/** Margin around the bubble as a fraction of canvas width. */
const PIP_MARGIN_FRACTION = 0.02

interface PipRect { x: number; y: number; w: number; h: number }

/**
 * Composite the screen stream and webcam stream onto a canvas: screen
 * full-frame, webcam as a rounded "bubble" whose position is read from
 * pipPosRef every frame (normalized 0–1 within the available area, so
 * dragging the preview moves the bubble in the recording live).
 */
async function createPipComposite(
  screenStream: MediaStream,
  camStream: MediaStream,
  pipPosRef: React.MutableRefObject<{ x: number; y: number }>,
  pipRectRef: React.MutableRefObject<PipRect | null>
): Promise<{ stream: MediaStream; cleanup: () => void }> {
  const screenVideo = document.createElement('video')
  screenVideo.srcObject = screenStream
  screenVideo.muted = true
  const camVideo = document.createElement('video')
  camVideo.srcObject = camStream
  camVideo.muted = true
  await Promise.all([screenVideo.play(), camVideo.play()])

  const W = screenVideo.videoWidth || 1920
  const H = screenVideo.videoHeight || 1080
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  let raf = 0
  const draw = () => {
    ctx.drawImage(screenVideo, 0, 0, W, H)
    const camW = camVideo.videoWidth
    const camH = camVideo.videoHeight
    if (camW && camH) {
      const pw = W * PIP_WIDTH_FRACTION
      const ph = pw * (camH / camW)
      const margin = W * PIP_MARGIN_FRACTION
      const x = margin + pipPosRef.current.x * Math.max(0, W - pw - 2 * margin)
      const y = margin + pipPosRef.current.y * Math.max(0, H - ph - 2 * margin)
      pipRectRef.current = { x, y, w: pw, h: ph }
      const r = pw * 0.06
      ctx.save()
      ctx.beginPath()
      roundRectPath(ctx, x, y, pw, ph, r)
      ctx.clip()
      ctx.drawImage(camVideo, x, y, pw, ph)
      ctx.restore()
      ctx.beginPath()
      roundRectPath(ctx, x, y, pw, ph, r)
      ctx.lineWidth = Math.max(2, W / 800)
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
  }
  draw()

  return {
    stream: canvas.captureStream(30),
    cleanup: () => {
      cancelAnimationFrame(raf)
      screenVideo.srcObject = null
      camVideo.srcObject = null
      pipRectRef.current = null
    }
  }
}

export default function LiveRecordingModal({ onClose }: Props) {
  const [title, setTitle] = useState('')
  const [systemAudio, setSystemAudio] = useState(false)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [assignTarget, setAssignTarget] = useState<TranscriptSegment | null>(null)

  // Video mode
  const [videoMode, setVideoMode] = useState<VideoMode>('none')
  const [screenSources, setScreenSources] = useState<ScreenSource[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [fetchingSources, setFetchingSources] = useState(false)
  const [videoError, setVideoError] = useState<string | null>(null)
  // Webcam PIP overlay for screen recordings ("show me in the corner")
  const [pipCam, setPipCam] = useState(false)

  // Video recording internals
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  // Underlying device streams (screen/camera) — stopped separately from the
  // composite canvas stream so the camera light reliably turns off
  const rawStreamsRef = useRef<MediaStream[]>([])
  // Tears down the PIP compositor (rAF loop + detached video elements)
  const compositeCleanupRef = useRef<(() => void) | null>(null)
  // PIP bubble position, normalized 0–1 within the available canvas area
  const pipPosRef = useRef({ x: 1, y: 1 })
  // Bubble rect in canvas pixels, updated each frame — used for drag hit-tests
  const pipRectRef = useRef<PipRect | null>(null)
  // Pointer offset within the bubble while dragging
  const pipDragRef = useRef<{ dx: number; dy: number } | null>(null)
  // Serialise chunk IPC writes to avoid out-of-order writes
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  // A/V sync: audio starts (main process) before video (camera/screen warm-up).
  // Measure the gap so playback can shift the video timeline to match.
  const audioStartTsRef = useRef<number | null>(null)
  const videoOffsetMsRef = useRef<number>(0)
  // Live self-view: the active capture stream, mirrored into a <video> preview
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const previewVideoRef = useRef<HTMLVideoElement>(null)

  // Attach the capture stream to the preview element whenever either changes
  useEffect(() => {
    const video = previewVideoRef.current
    if (!video) return
    video.srcObject = previewStream
    if (previewStream) void video.play().catch(() => {})
  }, [previewStream])

  // Expected speakers management
  const [allSpeakers, setAllSpeakers] = useState<SpeakerProfile[]>([])
  const [selectedSpeakerIds, setSelectedSpeakerIds] = useState<string[]>([])
  const [newSpeakerName, setNewSpeakerName] = useState('')
  const [creatingSpeaker, setCreatingSpeaker] = useState(false)

  const navigate = useNavigate()

  const {
    isRecording, isPaused, audioLevel, activeRecordingId,
    liveSegments, startRecording, stopRecording, pauseRecording, resumeRecording, updateLiveSegment
  } = useRecordingStore()
  const isAnyProcessing = useRecordingStore((s) => s.recordings.some((r) => r.status === 'processing'))
  const { selectedInputDeviceId, audioDevices } = useSettingsStore()
  const micPreviewLevel = useMicPreview(selectedInputDeviceId, !isRecording && !starting)

  const bottomRef = useRef<HTMLDivElement>(null)
  const prevIsRecordingRef = useRef(isRecording)

  // Load available speakers on mount
  useEffect(() => {
    window.api.speaker.getAll().then(({ speakers }) => setAllSpeakers(speakers))
  }, [])

  // Safety net: release the camera/screen streams if the modal unmounts
  // without a clean stop (e.g. recording crashed)
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state !== 'inactive') {
        try { mediaRecorderRef.current?.stop() } catch { /* already stopped */ }
      }
      compositeCleanupRef.current?.()
      compositeCleanupRef.current = null
      videoStreamRef.current?.getTracks().forEach((t) => t.stop())
      videoStreamRef.current = null
      rawStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      rawStreamsRef.current = []
    }
  }, [])

  // Fetch screen sources whenever screen mode is selected
  useEffect(() => {
    if (videoMode !== 'screen') {
      setScreenSources([])
      setSelectedSourceId(null)
      return
    }
    setFetchingSources(true)
    setVideoError(null)
    window.api.recording.getScreenSources()
      .then(({ sources }) => {
        setScreenSources(sources)
        // Auto-select the first full-screen source if available
        const firstScreen = sources.find((s) => s.isScreen)
        if (firstScreen) setSelectedSourceId(firstScreen.id)
      })
      .catch((e: unknown) => {
        setVideoError(e instanceof Error ? e.message : 'Could not list screen sources. Grant Screen Recording permission in System Settings → Privacy & Security.')
      })
      .finally(() => setFetchingSources(false))
  }, [videoMode])

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
    if (isPaused) return
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [isRecording, isPaused])

  // Auto-scroll transcript to bottom as new segments arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveSegments.length])

  const startVideoCapture = useCallback(async (recordingId: string): Promise<void> => {
    try {
      let stream: MediaStream

      if (videoMode === 'screen' && selectedSourceId) {
        const screenStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedSourceId,
            }
          } as unknown as MediaTrackConstraints
        })
        rawStreamsRef.current = [screenStream]
        stream = screenStream

        if (pipCam) {
          try {
            const camStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode: 'user' }
            })
            rawStreamsRef.current.push(camStream)
            pipPosRef.current = { x: 1, y: 1 } // lower-right corner
            const composite = await createPipComposite(screenStream, camStream, pipPosRef, pipRectRef)
            compositeCleanupRef.current = composite.cleanup
            stream = composite.stream
          } catch (e) {
            console.error('[LiveRecordingModal] Webcam overlay failed:', e)
            setVideoError('Webcam overlay unavailable — recording screen only.')
          }
        }
      } else if (videoMode === 'webcam') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', aspectRatio: { ideal: 9 / 16 } }
        })
        rawStreamsRef.current = [stream]
      } else {
        return
      }

      videoStreamRef.current = stream
      setPreviewStream(stream)
      chunkQueueRef.current = Promise.resolve()

      // Prefer VP9 for best Chromium compatibility; fall back to whatever is supported
      const mimeType = MediaRecorder.isTypeSupported('video/webm; codecs=vp9')
        ? 'video/webm; codecs=vp9'
        : 'video/webm'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder

      recorder.onstart = () => {
        // First video frame is captured now — record how far behind audio we are
        videoOffsetMsRef.current = audioStartTsRef.current != null
          ? Math.max(0, Date.now() - audioStartTsRef.current)
          : 0
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return
        chunkQueueRef.current = chunkQueueRef.current.then(async () => {
          const buffer = await event.data.arrayBuffer()
          await window.api.recording.saveVideoChunk({
            recordingId,
            chunk: new Uint8Array(buffer)
          })
        }).catch((e) => console.error('[Video] chunk send failed:', e))
      }

      // Collect chunks every 5 seconds so memory usage stays bounded
      recorder.start(5000)
    } catch (e) {
      console.error('[LiveRecordingModal] Failed to start video capture:', e)
      setVideoError(e instanceof Error ? e.message : String(e))
    }
  }, [videoMode, selectedSourceId, pipCam])

  const stopVideoCapture = useCallback(async (recordingId: string): Promise<void> => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    await new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        // Wait for all in-flight chunk writes to finish
        await chunkQueueRef.current
        // Tear down the PIP compositor, then stop all streams (composite +
        // underlying screen/camera devices)
        compositeCleanupRef.current?.()
        compositeCleanupRef.current = null
        videoStreamRef.current?.getTracks().forEach((t) => t.stop())
        videoStreamRef.current = null
        rawStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
        rawStreamsRef.current = []
        setPreviewStream(null)
        // Finalise the file in main process and update DB
        await window.api.recording.videoComplete({
          recordingId,
          offsetMs: videoOffsetMsRef.current
        })
        resolve()
      }
      recorder.stop()
    })

    mediaRecorderRef.current = null
  }, [])

  const handleStart = async () => {
    setStartError(null)
    setVideoError(null)
    setStarting(true)
    const label = title.trim() || `Recording ${new Date().toLocaleString()}`
    try {
      await startRecording(label, {
        sampleRate: 16000,
        channels: 1,
        inputDeviceId: selectedInputDeviceId,
        systemAudioEnabled: systemAudio
      }, selectedSpeakerIds.length > 0 ? selectedSpeakerIds : undefined, videoMode)

      // Audio timeline origin: stamped in the main process at audio.start()
      // (falls back to now if unavailable).
      audioStartTsRef.current = useRecordingStore.getState().audioStartedAt ?? Date.now()

      // activeRecordingId is set synchronously in the store by startRecording
      const recordingId = useRecordingStore.getState().activeRecordingId
      if (recordingId && videoMode !== 'none') {
        await startVideoCapture(recordingId)
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    const id = activeRecordingId // capture before store clears it
    setStopping(true)
    try {
      // Run audio and video stop concurrently
      const audioStop = stopRecording()
      const videoStop = id && videoMode !== 'none'
        ? stopVideoCapture(id)
        : Promise.resolve()

      await Promise.all([audioStop, videoStop])

      // If video was recorded, refresh the recording in the store to get videoPath
      if (id && videoMode !== 'none') {
        const { recording: updated } = await window.api.recording.get({ recordingId: id })
        if (updated) useRecordingStore.getState().updateRecording(updated)
      }
    } finally {
      setStopping(false)
    }
    if (id) navigate(`/recordings/${id}`)
    onClose()
  }

  const toggleSpeaker = (speakerId: string) => {
    setSelectedSpeakerIds((prev) =>
      prev.includes(speakerId)
        ? prev.filter((id) => id !== speakerId)
        : [...prev, speakerId]
    )
  }

  const handleCreateSpeaker = async () => {
    const name = newSpeakerName.trim()
    if (!name) return
    setCreatingSpeaker(true)
    try {
      const { speaker } = await window.api.speaker.create({ name })
      setAllSpeakers((prev) => [...prev, speaker])
      setSelectedSpeakerIds((prev) => [...prev, speaker.id])
      setNewSpeakerName('')
    } catch (e) {
      console.error('Failed to create speaker:', e)
    } finally {
      setCreatingSpeaker(false)
    }
  }

  const handleAssignSave = useCallback(async ({
    speakerName,
    profileId
  }: { speakerName: string; profileId?: string }) => {
    if (!assignTarget || !activeRecordingId) {
      setAssignTarget(null)
      return
    }
    try {
      await window.api.transcript.assignSpeaker({
        recordingId: activeRecordingId,
        segmentId: assignTarget.id,
        speakerId: assignTarget.speakerId ?? null,
        speakerName,
        profileId
      })
      updateLiveSegment(assignTarget.id, {
        speakerName,
        speakerId: profileId ?? null
      })
      useTranscriptStore.getState().updateSegment({
        ...assignTarget,
        speakerName,
        speakerId: profileId ?? null
      })
    } catch (err) {
      console.error('[LiveRecordingModal] assignSpeaker failed:', err)
    } finally {
      setAssignTarget(null)
    }
  }, [assignTarget, activeRecordingId, updateLiveSegment])

  const videoModeLabel: Record<VideoMode, string> = {
    none: 'Audio only',
    screen: 'Screen',
    webcam: 'Webcam journal',
  }

  // ── PIP bubble dragging on the live preview ──────────────────────────────
  // The preview shows the composited canvas stream, so pointer coordinates
  // map linearly onto canvas pixels (the <video> keeps its intrinsic aspect).
  const previewPointToCanvas = (e: React.PointerEvent<HTMLVideoElement>) => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * (el.videoWidth || 1),
      y: ((e.clientY - rect.top) / rect.height) * (el.videoHeight || 1)
    }
  }

  const handlePreviewPointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    const pip = pipRectRef.current
    if (!pip) return
    const p = previewPointToCanvas(e)
    if (p.x >= pip.x && p.x <= pip.x + pip.w && p.y >= pip.y && p.y <= pip.y + pip.h) {
      pipDragRef.current = { dx: p.x - pip.x, dy: p.y - pip.y }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
  }

  const handlePreviewPointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    const drag = pipDragRef.current
    const pip = pipRectRef.current
    const el = e.currentTarget
    if (!drag || !pip || !el.videoWidth || !el.videoHeight) return
    const p = previewPointToCanvas(e)
    const margin = el.videoWidth * PIP_MARGIN_FRACTION
    const availW = Math.max(1, el.videoWidth - pip.w - 2 * margin)
    const availH = Math.max(1, el.videoHeight - pip.h - 2 * margin)
    pipPosRef.current = {
      x: Math.min(1, Math.max(0, (p.x - drag.dx - margin) / availW)),
      y: Math.min(1, Math.max(0, (p.y - drag.dy - margin) / availH))
    }
  }

  const handlePreviewPointerUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    pipDragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (!isRecording && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`bg-surface-800 border border-surface-600 rounded-2xl shadow-2xl flex flex-col transition-all duration-200 ${
          isRecording ? 'w-[52rem] max-h-[80vh]' : 'w-[36rem] max-h-[90vh]'
        }`}
      >
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-700 shrink-0">
          {isRecording ? (
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isPaused ? 'bg-amber-400' : 'bg-red-500 animate-pulse'}`} />
              <span className="text-sm font-medium text-zinc-200 truncate">
                {isPaused ? 'Paused' : (title.trim() || 'Recording…')}
              </span>
              <span className="text-xs font-mono text-zinc-400 tabular-nums shrink-0">
                {formatElapsed(elapsedSeconds)}
              </span>
              <div className="ml-1 flex-1 max-w-[120px]">
                <AudioLevelBar level={isPaused ? 0 : audioLevel} />
              </div>
            </div>
          ) : (
            <h2 className="text-base font-semibold text-zinc-100">New Recording</h2>
          )}

          <div className="flex items-center gap-2 shrink-0 ml-4">
            {isRecording && (
              <>
                <button
                  className="btn-ghost py-1.5 px-3 text-xs flex items-center gap-1.5"
                  onClick={() => { void (isPaused ? resumeRecording() : pauseRecording()) }}
                  disabled={stopping}
                  title={isPaused ? 'Resume recording' : 'Pause recording'}
                >
                  {isPaused
                    ? <><Play className="w-3.5 h-3.5" /> Resume</>
                    : <><Pause className="w-3.5 h-3.5" /> Pause</>}
                </button>
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
              </>
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
          <div className="px-5 py-5 space-y-4 overflow-y-auto">
            <div className="space-y-3">
              <input
                className="input w-full"
                placeholder="Recording title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !starting && !isAnyProcessing) void handleStart() }}
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

            {/* ── Video mode picker ──────────────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Video className="w-3.5 h-3.5 text-zinc-400" />
                <span className="text-sm text-zinc-300">Video</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['none', 'screen', 'webcam'] as VideoMode[]).map((mode) => {
                  const Icon = mode === 'none' ? Mic : mode === 'screen' ? Layers : Camera
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setVideoMode(mode)}
                      className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg border text-xs font-medium transition-colors ${
                        videoMode === mode
                          ? 'border-accent/60 bg-accent/10 text-accent'
                          : 'border-surface-600 bg-surface-700/40 text-zinc-400 hover:border-surface-500 hover:text-zinc-200'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {videoModeLabel[mode]}
                    </button>
                  )
                })}
              </div>

              {/* Webcam note */}
              {videoMode === 'webcam' && (
                <p className="text-xs text-zinc-500 leading-snug">
                  Records your camera in portrait orientation — ideal for video journal entries. The video is muted during playback; audio comes from your microphone recording.
                </p>
              )}

              {/* Screen source picker */}
              {videoMode === 'screen' && (
                <div className="space-y-2">
                  {fetchingSources && (
                    <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading sources…
                    </div>
                  )}
                  {videoError && (
                    <p className="text-xs text-red-400 leading-snug">{videoError}</p>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer select-none group">
                    <input
                      type="checkbox"
                      className="rounded border-surface-500 bg-surface-700 text-accent focus:ring-accent/50"
                      checked={pipCam}
                      onChange={(e) => setPipCam(e.target.checked)}
                    />
                    <Camera className="w-3.5 h-3.5 text-zinc-400 group-hover:text-zinc-200 transition-colors" />
                    <span className="text-sm text-zinc-400 group-hover:text-zinc-200 transition-colors">
                      Show me in the corner
                    </span>
                    <span className="text-xs text-zinc-600">(webcam bubble — drag it in the preview while recording)</span>
                  </label>
                  {!fetchingSources && screenSources.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1">
                      {screenSources.map((source) => (
                        <button
                          key={source.id}
                          type="button"
                          onClick={() => setSelectedSourceId(source.id)}
                          className={`relative flex flex-col gap-1 rounded-lg border overflow-hidden text-left transition-colors ${
                            selectedSourceId === source.id
                              ? 'border-accent/70 ring-1 ring-accent/40'
                              : 'border-surface-600 hover:border-surface-400'
                          }`}
                        >
                          {source.thumbnailDataUrl ? (
                            <img
                              src={source.thumbnailDataUrl}
                              alt={source.name}
                              className="w-full aspect-video object-cover bg-surface-700"
                            />
                          ) : (
                            <div className="w-full aspect-video bg-surface-700 flex items-center justify-center">
                              <Layers className="w-5 h-5 text-zinc-600" />
                            </div>
                          )}
                          <span className="px-1.5 pb-1.5 text-[10px] text-zinc-300 leading-tight truncate">
                            {source.name}
                          </span>
                          {selectedSourceId === source.id && (
                            <div className="absolute top-1 right-1 w-4 h-4 bg-accent rounded-full flex items-center justify-center">
                              <Check className="w-2.5 h-2.5 text-white" />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Expected speakers ──────────────────────────────────────── */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-zinc-400" />
                <span className="text-sm text-zinc-300">Meeting participants</span>
                <span className="text-xs text-zinc-600">(optional — improves speaker identification)</span>
              </div>

              {selectedSpeakerIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedSpeakerIds.map((id) => {
                    const sp = allSpeakers.find((s) => s.id === id)
                    if (!sp) return null
                    return (
                      <button
                        key={id}
                        onClick={() => toggleSpeaker(id)}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-accent/20 text-accent border border-accent/30 hover:bg-red-500/20 hover:text-red-300 hover:border-red-500/30 transition-colors group"
                        title={`Remove ${sp.name}`}
                      >
                        <User className="w-3 h-3 group-hover:hidden" />
                        <Trash2 className="w-3 h-3 hidden group-hover:block" />
                        {sp.name}
                      </button>
                    )
                  })}
                </div>
              )}

              {allSpeakers.filter((s) => !selectedSpeakerIds.includes(s.id)).length > 0 && (
                <select
                  className="input w-full text-sm"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) toggleSpeaker(e.target.value)
                  }}
                >
                  <option value="">Add a speaker…</option>
                  {allSpeakers
                    .filter((s) => !selectedSpeakerIds.includes(s.id))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.voiceEmbedding ? '🎤' : ''}
                      </option>
                    ))}
                </select>
              )}

              <div className="flex gap-2">
                <input
                  className="input flex-1 text-sm"
                  placeholder="New speaker name"
                  value={newSpeakerName}
                  onChange={(e) => setNewSpeakerName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSpeakerName.trim()) {
                      e.preventDefault()
                      void handleCreateSpeaker()
                    }
                  }}
                />
                <button
                  className="btn-ghost py-1.5 px-3 text-xs flex items-center gap-1"
                  onClick={() => void handleCreateSpeaker()}
                  disabled={!newSpeakerName.trim() || creatingSpeaker}
                >
                  {creatingSpeaker ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Plus className="w-3 h-3" />
                  )}
                  Create
                </button>
              </div>
            </div>

            {startError && (
              <p className="text-xs text-red-400 leading-snug">{startError}</p>
            )}

            <div className="flex items-center gap-3">
              <button
                className="btn-primary"
                onClick={() => void handleStart()}
                disabled={starting || isAnyProcessing || (videoMode === 'screen' && !selectedSourceId)}
                title={
                  isAnyProcessing
                    ? 'A recording is being processed — please wait'
                    : videoMode === 'screen' && !selectedSourceId
                    ? 'Select a screen source above'
                    : undefined
                }
              >
                <Mic className="w-4 h-4" />
                {starting ? 'Starting…' : isAnyProcessing ? 'Processing…' : 'Start Recording'}
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

        {/* ── Live transcript + video self-view (during recording) ──────── */}
        {isRecording && (
          <div className="flex-1 flex min-h-0">
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
                    <span className="text-xs text-zinc-600 pt-0.5 w-12 shrink-0 font-mono tabular-nums">
                      {formatTimestamp(seg.timestampStart)}
                    </span>
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
                    <p className="flex-1 text-sm text-zinc-200 leading-snug pt-0.5">
                      {seg.text}
                    </p>
                  </div>
                )
              })
            )}
            <div ref={bottomRef} />
          </div>

          {/* Live self-view preview (webcam mirrored; screen shown as-is).
              In PIP mode the preview is the composited canvas — dragging the
              bubble here moves it in the actual recording. */}
          {previewStream && (
            <div className="shrink-0 p-3 border-l border-surface-700 flex flex-col items-center gap-1.5">
              <video
                ref={previewVideoRef}
                muted
                playsInline
                onPointerDown={handlePreviewPointerDown}
                onPointerMove={handlePreviewPointerMove}
                onPointerUp={handlePreviewPointerUp}
                style={{ touchAction: 'none' }}
                className={`rounded-lg bg-black border border-surface-600 ${
                  videoMode === 'webcam'
                    ? 'h-72 aspect-[9/16] object-cover scale-x-[-1]'
                    : `w-72 ${pipCam ? 'cursor-move' : ''}`
                }`}
              />
              {videoMode === 'screen' && pipCam && (
                <p className="text-[10px] text-zinc-600 text-center leading-tight">
                  Drag your bubble to reposition it
                </p>
              )}
            </div>
          )}
          </div>
        )}

        {isRecording && liveSegments.length > 0 && (
          <p className="px-5 py-2 text-xs text-zinc-600 border-t border-surface-700 shrink-0">
            Click a speaker chip to assign — recording continues uninterrupted.
          </p>
        )}
      </div>

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
