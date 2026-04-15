import { useState, useEffect, useRef } from 'react'

/**
 * Monitors microphone input level (0–1 RMS) via Web Audio API.
 * Only runs when `enabled` is true. Cleans up the stream and AudioContext on
 * disable or unmount.
 */
export function useMicPreview(deviceId: string | null | undefined, enabled: boolean): number {
  const [level, setLevel] = useState(0)
  const rafRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    if (!enabled) {
      setLevel(0)
      return
    }

    let cancelled = false

    const start = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
          video: false
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const ctx = new AudioContext()
        ctxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)

        const buf = new Float32Array(analyser.fftSize)
        const tick = () => {
          if (cancelled) return
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length)
          setLevel(Math.min(1, rms * 6)) // scale up so normal speech is visible
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      } catch {
        // Permission denied or no mic — stay at 0
      }
    }

    start()

    return () => {
      cancelled = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      ctxRef.current?.close()
      ctxRef.current = null
      setLevel(0)
    }
  }, [deviceId, enabled])

  return level
}
