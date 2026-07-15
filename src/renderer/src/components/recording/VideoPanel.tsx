import { useRef, useEffect, useState, useCallback } from 'react'
import { Maximize2, Minimize2, X, Video } from 'lucide-react'

interface Props {
  /** vbfile:// URL pointing to the local video file */
  src: string
  /** Current playback position from AudioPlayer (seconds) */
  playbackSeconds: number | undefined
  /** Incremented on each seek so we can force-sync video position */
  seekNonce: number
  /** Whether the audio player is currently playing */
  isAudioPlaying: boolean
  /** Seconds the video started AFTER the audio (camera warm-up).
   *  Video position = audio position − offset. */
  offsetSeconds?: number
  /** Called when the user clicks the close button */
  onClose: () => void
  /** Called when the user wants to delete the video file */
  onDelete?: () => void
}

const DRIFT_THRESHOLD = 0.5 // seconds before we force-correct video position

export default function VideoPanel({
  src,
  playbackSeconds,
  seekNonce,
  isAudioPlaying,
  offsetSeconds = 0,
  onClose,
  onDelete,
}: Props) {
  // Map an audio-timeline position to the video's own timeline
  const toVideoTime = (audioSeconds: number) => Math.max(0, audioSeconds - offsetSeconds)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [videoError, setVideoError] = useState(false)
  // Track whether the video src has been loaded at least once
  const srcLoadedRef = useRef(false)

  // Load src lazily on first play (mirrors AudioPlayer behaviour)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!srcLoadedRef.current) {
      srcLoadedRef.current = true
      video.src = src
      video.load()
    }
  }, [src])

  // Reset when src changes (different recording)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.removeAttribute('src')
    video.load()
    srcLoadedRef.current = false
    setVideoError(false)
  // Only re-run when the src prop changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  // Seek video to audio position whenever a seek is requested
  useEffect(() => {
    const video = videoRef.current
    if (!video || playbackSeconds == null) return
    if (!srcLoadedRef.current) {
      srcLoadedRef.current = true
      video.src = src
      video.load()
    }
    video.currentTime = toVideoTime(playbackSeconds)
  // seekNonce changes on every audio seek
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce])

  // Follow the audio: play/pause, pre-roll hold, and drift correction.
  //
  // The video starts `offsetSeconds` into the audio timeline (camera warm-up).
  // While the audio is inside that gap the video must HOLD its first frame,
  // paused — letting it play and repeatedly seeking it back to 0 causes a
  // visible black flash on every corrective seek.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (!isAudioPlaying) {
      if (!video.paused) video.pause()
      return
    }

    if (!srcLoadedRef.current) {
      srcLoadedRef.current = true
      video.src = src
      video.load()
    }

    const inPreRoll = playbackSeconds != null && playbackSeconds < offsetSeconds
    if (inPreRoll) {
      if (!video.paused) video.pause()
      if (video.currentTime > 0.25) video.currentTime = 0
      return
    }

    if (video.paused) void video.play().catch(() => {})

    if (playbackSeconds != null) {
      const target = toVideoTime(playbackSeconds)
      if (Math.abs(video.currentTime - target) > DRIFT_THRESHOLD) {
        video.currentTime = target
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAudioPlaying, playbackSeconds, src, offsetSeconds])

  const handleDelete = useCallback(() => {
    if (window.confirm('Delete the video file for this recording? The audio transcript will remain.')) {
      onDelete?.()
    }
  }, [onDelete])

  return (
    <div
      className={`rounded-xl overflow-hidden border border-surface-600 bg-surface-900 flex flex-col ${
        expanded
          ? 'fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[720px] max-w-[90vw] max-h-[85vh] shadow-2xl'
          : 'w-full shrink-0'
      }`}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-surface-800 shrink-0">
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <Video className="w-3 h-3" />
          <span>Video</span>
        </div>
        <div className="flex items-center gap-1">
          {onDelete && (
            <button
              className="btn-ghost p-1 text-zinc-500 hover:text-red-400"
              onClick={handleDelete}
              title="Delete video file"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <button
            className="btn-ghost p-1"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Shrink' : 'Expand'}
          >
            {expanded
              ? <Minimize2 className="w-3 h-3" />
              : <Maximize2 className="w-3 h-3" />}
          </button>
          <button
            className="btn-ghost p-1"
            onClick={onClose}
            title="Hide video panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Video element */}
      <div className="relative bg-black">
        {videoError ? (
          <div className="flex items-center justify-center aspect-video text-xs text-zinc-600">
            Video file not found
          </div>
        ) : (
          <video
            ref={videoRef}
            className={`w-full block object-contain ${expanded ? 'max-h-[75vh]' : 'max-h-72'}`}
            muted
            playsInline
            preload="none"
            onError={() => setVideoError(true)}
          />
        )}
      </div>
    </div>
  )
}
