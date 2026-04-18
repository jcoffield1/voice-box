import { useState, useRef, useEffect, useCallback } from 'react'
import { useChatThread } from '../../hooks/useAI'
import ChatMessageBubble from './ChatMessageBubble'
import { Send, Loader2, Sparkles, Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { useSettingsStore } from '../../store/settingsStore'

interface Props {
  recordingId: string
  /** Pre-populate the input field (e.g. from a search result "Ask AI" click) */
  initialMessage?: string
}

export default function AIPanel({ recordingId, initialMessage }: Props) {
  const [threadId, setThreadId] = useState<string | null>(null)
  const { messages, streaming, loading, createThread, sendMessage } = useChatThread(threadId)
  const [input, setInput] = useState(initialMessage ?? '')
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [voiceActive, setVoiceActive] = useState(false)
  const providerMap = useSettingsStore((s) => s.providerMap)
  const provider = providerMap['conversation'] ?? 'ollama'

  // Track previous message count to detect new assistant responses
  const prevMsgCount = useRef(messages.length)
  const prevStreaming = useRef(streaming)

  // Scroll-to-bottom refs
  const bottomRef = useRef<HTMLDivElement>(null)
  const justLoadedRef = useRef(false)

  // On mount (or recordingId change), restore the most recent thread for this recording
  useEffect(() => {
    setThreadId(null)
    void (async () => {
      const { threads } = await window.api.ai.getThreadsByRecording({ recordingId })
      if (threads.length > 0) {
        justLoadedRef.current = true
        setThreadId(threads[0].id)
      }
    })()
  }, [recordingId])

  // Scroll to bottom when messages load initially or new ones arrive
  useEffect(() => {
    if (!bottomRef.current || messages.length === 0) return
    bottomRef.current.scrollIntoView({ behavior: justLoadedRef.current ? 'instant' : 'smooth' })
    justLoadedRef.current = false
  }, [messages.length])

  // Also scroll when streaming content arrives
  useEffect(() => {
    if (streaming && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [streaming])

  // Update input when initialMessage changes (e.g. navigating via "Ask AI about this")
  useEffect(() => {
    if (initialMessage) setInput(initialMessage)
  }, [initialMessage])

  const ensureThread = useCallback(async () => {
    if (threadId) return threadId
    const thread = await createThread(recordingId)
    setThreadId(thread.id)
    return thread.id
  }, [threadId, createThread, recordingId])

  const handleSend = useCallback(async (text?: string) => {
    const t = (text ?? input).trim()
    if (!t) return
    setInput('')
    const tid = await ensureThread()
    await sendMessage(tid, t, recordingId, '', provider)
  }, [input, ensureThread, sendMessage, recordingId, provider])

  const handleSummarize = async () => {
    const tid = await ensureThread()
    await sendMessage(
      tid,
      'Please summarize this call transcript, highlighting key decisions and action items.',
      recordingId,
      '',
      provider
    )
  }

  // Auto-speak new assistant messages when TTS is enabled
  useEffect(() => {
    if (!ttsEnabled) return
    // When streaming just finished
    if (prevStreaming.current && !streaming && streaming === '') {
      // streaming just ended — speak the last streamed text
      if (streaming) void window.api.ai.speak({ text: streaming, rate: 180 })
    }
    // When a complete message arrives (non-streaming path)
    if (messages.length > prevMsgCount.current) {
      const newest = messages[messages.length - 1]
      if (newest?.role === 'assistant') {
        void window.api.ai.speak({ text: newest.content, rate: 180 })
      }
    }
    prevMsgCount.current = messages.length
    prevStreaming.current = streaming ?? ''
  }, [messages, streaming, ttsEnabled])

  // Push-to-talk: hold button → start capture, release → stop + fill input
  const handleVoiceDown = useCallback(async () => {
    if (voiceActive) return
    setVoiceActive(true)
    await window.api.voiceInput.start()
  }, [voiceActive])

  const handleVoiceUp = useCallback(async () => {
    if (!voiceActive) return
    const result = await window.api.voiceInput.stop()
    setVoiceActive(false)
    if (result.transcript) {
      // Immediately send the voice message
      void handleSend(result.transcript)
    }
  }, [voiceActive, handleSend])

  // Global keyboard shortcut (Cmd+Shift+Space) for push-to-talk
  useEffect(() => {
    const unsub = window.api.shortcuts.onPushToTalk(() => {
      if (voiceActive) void handleVoiceUp()
      else void handleVoiceDown()
    })
    return unsub
  }, [voiceActive, handleVoiceDown, handleVoiceUp])

  return (
    <div className="card flex flex-col h-full gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-200">AI Assistant</span>
        <div className="flex items-center gap-1">
          {/* TTS toggle */}
          <button
            className={`btn-ghost p-1.5 ${ttsEnabled ? 'text-accent' : ''}`}
            onClick={() => {
              if (ttsEnabled) void window.api.ai.stopSpeaking()
              setTtsEnabled((v) => !v)
            }}
            title={ttsEnabled ? 'Disable text-to-speech' : 'Enable text-to-speech'}
          >
            {ttsEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
          <button
            className="btn-ghost text-xs py-1 px-2"
            onClick={handleSummarize}
            disabled={loading}
            title="Summarize transcript"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Summarize
          </button>
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-3 min-h-0 selectable">
        {messages.length === 0 && !streaming && (
          <p className="text-xs text-zinc-500 text-center py-8">
            Ask a question about this call, or use Summarize.
          </p>
        )}
        {messages.map((msg) => (
          <ChatMessageBubble key={msg.id} message={msg} />
        ))}
        {streaming && (
          <ChatMessageBubble
            key="streaming"
            message={{
              id: 'streaming',
              threadId: threadId ?? '',
              role: 'assistant',
              content: streaming,
              createdAt: Date.now(),
              model: null,
              provider: null
            }}
            isStreaming
          />
        )}
        {loading && !streaming && (
          <div className="flex justify-start">
            <div className="bg-surface-700 rounded-xl px-3 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 items-end">
        <textarea
          className="input text-sm resize-none leading-relaxed flex-1"
          placeholder={voiceActive ? '🎤 Listening…' : 'Ask about this call…'}
          rows={2}
          value={input}
          disabled={voiceActive}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleSend()
            }
          }}
        />
        {/* Push-to-talk button */}
        <button
          className={`btn-ghost p-2 shrink-0 transition-colors ${
            voiceActive ? 'text-red-400 bg-red-500/10 ring-1 ring-red-500/30' : ''
          }`}
          onMouseDown={() => void handleVoiceDown()}
          onMouseUp={() => void handleVoiceUp()}
          onMouseLeave={() => { if (voiceActive) void handleVoiceUp() }}
          title="Hold to speak"
        >
          {voiceActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>
        <button
          className="btn-primary p-2 shrink-0"
          onClick={() => void handleSend()}
          disabled={!input.trim() || loading || voiceActive}
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

