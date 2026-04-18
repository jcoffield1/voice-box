import { useState, useEffect, useRef } from 'react'
import { Mic, MicOff, Loader2 } from 'lucide-react'

interface Props {
  /** Ref to the textarea where dictated text should be inserted */
  textareaRef: React.RefObject<HTMLTextAreaElement>
  /** Called with the full updated value after inserting transcription */
  onChange: (value: string) => void
}

type DictationState = 'idle' | 'recording' | 'transcribing'

export default function DictationButton({ textareaRef, onChange }: Props) {
  const [state, setState] = useState<DictationState>('idle')
  // Track cursor position at the moment the user might have moved away
  const insertPosRef = useRef<number | null>(null)

  // Register the onDone listener once
  useEffect(() => {
    const unsub = window.api.voiceInput.onDone(({ transcript }) => {
      setState('idle')
      if (!transcript.trim()) return

      const ta = textareaRef.current
      if (!ta) return

      // Use the saved insert position (where cursor was when Stop was clicked),
      // falling back to the textarea's current selectionStart.
      const pos = insertPosRef.current ?? ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)

      // Add a space separator if the character before the insert pos isn't whitespace
      const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
      // Add a space after if the next char isn't whitespace
      const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : ''

      const inserted = `${prefix}${transcript.trim()}${suffix}`
      const newValue = before + inserted + after
      onChange(newValue)

      // Restore focus and place cursor after the inserted text
      const newCursor = pos + inserted.length
      ta.focus()
      ta.setSelectionRange(newCursor, newCursor)

      insertPosRef.current = null
    })
    return unsub
  }, [textareaRef, onChange])

  const handleClick = async () => {
    if (state === 'idle') {
      // Snapshot the cursor position before recording starts
      insertPosRef.current = textareaRef.current?.selectionStart ?? null
      setState('recording')
      await window.api.voiceInput.start()
    } else if (state === 'recording') {
      // Capture cursor position at the moment they stop — the user may have
      // clicked into the textarea and moved it during recording
      insertPosRef.current = textareaRef.current?.selectionStart ?? insertPosRef.current
      setState('transcribing')
      await window.api.voiceInput.stop()
      // The onDone handler above will set state back to 'idle'
    }
  }

  const title =
    state === 'idle' ? 'Dictate notes (click to start recording)' :
    state === 'recording' ? 'Recording… click to stop and transcribe' :
    'Transcribing…'

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={state === 'transcribing'}
      title={title}
      className={`p-1.5 rounded transition-colors ${
        state === 'recording'
          ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20 animate-pulse'
          : state === 'transcribing'
          ? 'text-zinc-500 cursor-not-allowed'
          : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface-700'
      }`}
    >
      {state === 'transcribing'
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : state === 'recording'
        ? <MicOff className="w-3.5 h-3.5" />
        : <Mic className="w-3.5 h-3.5" />
      }
    </button>
  )
}
