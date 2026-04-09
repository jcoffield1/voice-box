import { useRef, useState, useEffect, useCallback } from 'react'
import { Play, Pause, Volume2 } from 'lucide-react'

interface Props {
  /** vbfile:// URL pointing to the local audio file */
  src: string
  /** Optional: jump to this time in seconds on mount / when it changes */
  jumpToSeconds?: number
}

function formatTime(seconds: number) {
  if (!isFinite(seconds)) return '--:--'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default function AudioPlayer({ src, jumpToSeconds }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)

  // Jump to timestamp when prop changes
  useEffect(() => {
    if (jumpToSeconds != null && audioRef.current) {
      audioRef.current.currentTime = jumpToSeconds
    }
  }, [jumpToSeconds])

  const handlePlayPause = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
    } else {
      void audio.play()
    }
  }, [playing])

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value)
    if (audioRef.current) audioRef.current.currentTime = t
    setCurrentTime(t)
  }

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    if (audioRef.current) audioRef.current.volume = v
    setVolume(v)
  }

  return (
    <div className="card flex flex-col gap-3">
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        preload="metadata"
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
