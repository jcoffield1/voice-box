import { useRef, useState, useEffect, useCallback } from 'react'
import { Play, Pause, Volume2 } from 'lucide-react'

interface Props {
  /** vbfile:// URL pointing to the local audio file */
  src: string
  /** Known duration in seconds (from the recording record) — shown immediately before loadedmetadata fires */
  knownDuration?: number | null
  /** Optional: jump to this time in seconds on mount / when it changes */
  jumpToSeconds?: number
  /** Called with current playback position (seconds) on every timeupdate */
  onTimeUpdate?: (seconds: number) => void
  /** Imperative seek: when this value changes the player seeks to it */
  seekToSeconds?: number
  /**
   * Companion counter for `seekToSeconds` that increments on every seek
   * request, so callers can re-trigger a seek to the same time (e.g. a
   * "replay this segment" button).
   */
  seekNonce?: number
  /** Counter that, when incremented, pauses playback. */
  pauseSignal?: number
  /** Counter that, when incremented, resumes playback from the current position. */
  playSignal?: number
  /** Called whenever play/pause state changes. */
  onPlayingChange?: (playing: boolean) => void
}

function formatTime(seconds: number) {
  if (!isFinite(seconds)) return '--:--'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default function AudioPlayer({ src, knownDuration, jumpToSeconds, onTimeUpdate, seekToSeconds, seekNonce, pauseSignal, playSignal, onPlayingChange }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(knownDuration ?? 0)
  const [volume, setVolume] = useState(1)

  // Tracks whether we've already set the src on the audio element.
  // We NEVER set src until the user explicitly requests playback — this is
  // the only reliable way to prevent Electron/Chromium from auto-playing.
  const srcLoadedRef = useRef(false)

  // Pending action to execute once the src is loaded and metadata is ready.
  const pendingRef = useRef<{ type: 'play' } | { type: 'seek'; time: number } | null>(null)

  // Mount guards for the imperative signal effects — prevent the effect from
  // firing on the initial render when seekNonce/playSignal are already non-zero
  // (e.g. navigating between recordings without unmounting this component).
  const seekMountedRef = useRef(false)
  const pauseMountedRef = useRef(false)
  const playMountedRef = useRef(false)

  // Reset everything when the source URL changes (different recording).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.removeAttribute('src')
    audio.load()
    srcLoadedRef.current = false
    pendingRef.current = null
    setPlaying(false)
    setCurrentTime(0)
    setDuration(knownDuration ?? 0)
    seekMountedRef.current = false
    pauseMountedRef.current = false
    playMountedRef.current = false
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  // Load src imperatively and call play/seek once metadata is ready.
  const activate = useCallback((action: { type: 'play' } | { type: 'seek'; time: number }) => {
    const audio = audioRef.current
    if (!audio) return

    if (!srcLoadedRef.current) {
      srcLoadedRef.current = true
      pendingRef.current = action
      audio.src = src
      audio.load()
      // onLoadedMetadata will fire the pending action
    } else {
      // src is already set — act immediately
      if (action.type === 'seek') audio.currentTime = action.time
      void audio.play()
    }
  }, [src])

  // Jump to timestamp when prop changes (from search result) — seeks only, no play.
  useEffect(() => {
    if (jumpToSeconds == null) return
    const audio = audioRef.current
    if (!audio) return
    if (srcLoadedRef.current) {
      audio.currentTime = jumpToSeconds
    }
    // If src isn't loaded yet, we skip — the user hasn't interacted yet and
    // we don't want to trigger a load just for a visual seek position.
  }, [jumpToSeconds])

  // Seek + play when parent requests it (e.g. transcript segment play button).
  useEffect(() => {
    if (!seekMountedRef.current) {
      seekMountedRef.current = true
      return
    }
    if (seekToSeconds != null) {
      activate({ type: 'seek', time: seekToSeconds })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce ?? seekToSeconds])

  // Pause when parent requests it.
  useEffect(() => {
    if (!pauseMountedRef.current) {
      pauseMountedRef.current = true
      return
    }
    audioRef.current?.pause()
  }, [pauseSignal])

  // Resume when parent requests it (no seek — keeps current position).
  useEffect(() => {
    if (!playMountedRef.current) {
      playMountedRef.current = true
      return
    }
    activate({ type: 'play' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playSignal])

  // Notify parent of play/pause state changes.
  useEffect(() => {
    onPlayingChange?.(playing)
  }, [playing, onPlayingChange])

  // Execute the pending action once metadata is available.
  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    // WAV files recorded without a known final size report Infinity — keep
    // the knownDuration value already shown rather than overwriting with --:--.
    if (isFinite(audio.duration)) setDuration(audio.duration)
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    if (pending.type === 'seek') audio.currentTime = pending.time
    void audio.play()
  }, [])

  const handlePlayPause = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
    } else {
      activate({ type: 'play' })
    }
  }, [playing, activate])

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value)
    const audio = audioRef.current
    if (!audio) return
    if (srcLoadedRef.current) {
      audio.currentTime = t
    }
    setCurrentTime(t)
  }

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    if (audioRef.current) audioRef.current.volume = v
    setVolume(v)
  }

  return (
    <div className="card flex flex-col gap-3">
      {/* Audio element — src is set lazily via activate() on first user interaction */}
      <audio
        ref={audioRef}
        autoPlay={false}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => {
          const t = audioRef.current?.currentTime ?? 0
          setCurrentTime(t)
          onTimeUpdate?.(t)
        }}
        onLoadedMetadata={handleLoadedMetadata}
      />

      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-ghost p-2 shrink-0"
          onClick={handlePlayPause}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>

        <span className="text-xs text-zinc-500 font-mono w-10 text-right shrink-0">
          {formatTime(currentTime)}
        </span>

        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.5}
          value={currentTime}
          onChange={handleSeek}
          className="flex-1 h-1.5 accent-accent cursor-pointer"
          aria-label="Seek"
        />

        <span className="text-xs text-zinc-500 font-mono w-10 shrink-0">
          {formatTime(duration)}
        </span>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2 px-1">
        <Volume2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={handleVolume}
          className="w-24 h-1 accent-accent cursor-pointer"
          aria-label="Volume"
        />
        <span className="text-xs text-zinc-600 w-8 text-right">{Math.round(volume * 100)}%</span>
      </div>
    </div>
  )
}
