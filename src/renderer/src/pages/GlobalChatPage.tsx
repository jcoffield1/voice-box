import { useState, useRef, useEffect, useCallback } from 'react'
import {
  MessageSquare, Send, Loader2, Mic, MicOff, Volume2, VolumeX,
  Plus, Trash2, Clock, ChevronLeft, ChevronRight, Pencil
} from 'lucide-react'
import { useAIStore } from '../store/aiStore'
import ChatMessageBubble from '../components/ai/ChatMessageBubble'
import { useSettingsStore } from '../store/settingsStore'
import type { ConversationThread } from '@shared/types'

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

function threadLabel(thread: ConversationThread): string {
  return thread.title ?? `Chat ${new Date(thread.createdAt).toLocaleDateString()}`
}

export default function GlobalChatPage() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const store = useAIStore()

  // Thread-specific slices
  const messages = threadId ? (store.messages[threadId] ?? []) : []
  const streaming = threadId ? (store.streaming[threadId] ?? null) : null
  const loading = threadId ? (store.loading[threadId] ?? false) : false

  const [input, setInput] = useState('')
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [voiceActive, setVoiceActive] = useState(false)
  const providerMap = useSettingsStore((s) => s.providerMap)
  const provider = providerMap['conversation'] ?? 'ollama'
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prevMsgCount = useRef(0)

  // Load thread list on mount
  useEffect(() => {
    void store.loadAllThreads()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to streaming chunks for the active thread
  useEffect(() => {
    const unsub = window.api.ai.onChatChunk(({ threadId: chunkThreadId, chunk }) => {
      store.appendChunk(chunkThreadId, chunk)
    })
    return unsub
  }, [store])

  // Subscribe to streaming done
  useEffect(() => {
    const unsub = window.api.ai.onChatDone(({ threadId: doneThreadId }) => {
      store.clearStreaming(doneThreadId)
      // Update threadList to bump updatedAt so list stays sorted
      void store.loadAllThreads()
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  // Auto-speak new assistant messages
  useEffect(() => {
    if (!ttsEnabled) return
    if (messages.length > prevMsgCount.current) {
      const newest = messages[messages.length - 1]
      if (newest?.role === 'assistant') {
        void window.api.ai.speak({ text: newest.content, rate: 180 })
      }
    }
    prevMsgCount.current = messages.length
  }, [messages, ttsEnabled])

  const startEditing = useCallback((thread: ConversationThread, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(thread.id)
    setEditingTitle(thread.title ?? `Chat ${new Date(thread.createdAt).toLocaleDateString()}`)
    setTimeout(() => editInputRef.current?.select(), 0)
  }, [])

  const commitEdit = useCallback(async () => {
    if (!editingId) return
    const trimmed = editingTitle.trim()
    if (trimmed) await store.updateThreadTitle(editingId, trimmed)
    setEditingId(null)
  }, [editingId, editingTitle, store])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
  }, [])

  const openThread = useCallback(async (id: string) => {
    setThreadId(id)
    if (!store.messages[id]) {
      await store.loadThread(id)
    }
  }, [store])

  const ensureThread = useCallback(async () => {
    if (threadId) return threadId
    const thread = await store.createThread(null)
    setThreadId(thread.id)
    return thread.id
  }, [threadId, store])

  const handleNewChat = useCallback(async () => {
    const thread = await store.createThread(null)
    setThreadId(thread.id)
    setInput('')
  }, [store])

  const handleDeleteThread = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await store.deleteThread(id)
    if (threadId === id) setThreadId(null)
  }, [store, threadId])

  const handleSend = useCallback(async (text?: string) => {
    const t = (text ?? input).trim()
    if (!t) return
    setInput('')
    const tid = await ensureThread()
    await store.sendMessage(tid, t, null, '', provider)
  }, [input, ensureThread, store, provider])

  const handleVoiceDown = useCallback(async () => {
    if (voiceActive) return
    setVoiceActive(true)
    await window.api.voiceInput.start()
  }, [voiceActive])

  const handleVoiceUp = useCallback(async () => {
    if (!voiceActive) return
    const result = await window.api.voiceInput.stop()
    setVoiceActive(false)
    if (result.transcript) void handleSend(result.transcript)
  }, [voiceActive, handleSend])

  // Global push-to-talk shortcut
  useEffect(() => {
    const unsubscribe = window.api.shortcuts.onPushToTalk(() => {
      if (voiceActive) void handleVoiceUp()
      else void handleVoiceDown()
    })
    return unsubscribe
  }, [voiceActive, handleVoiceDown, handleVoiceUp])

  return (
    <div className="flex h-full">
      {/* ── Thread history sidebar ────────────────────────────────────────── */}
      <aside
        className={`flex-shrink-0 border-r border-surface-700 flex flex-col transition-[width] duration-200 ${
          sidebarOpen ? 'w-56' : 'w-0 overflow-hidden'
        }`}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-surface-700">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">History</span>
          <button
            className="btn-ghost p-1 text-xs"
            onClick={() => void handleNewChat()}
            title="New chat"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {(() => {
            const globalThreads = store.threadList.filter((t) => t.recordingId === null)
            if (globalThreads.length === 0) {
              return <p className="text-xs text-zinc-600 px-3 py-4 text-center">No conversations yet</p>
            }
            return globalThreads.map((thread) => (
              <div
                key={thread.id}
                className={`w-full text-left px-3 py-2 group flex items-start gap-2 hover:bg-surface-700 transition-colors ${
                  thread.id === threadId ? 'bg-surface-700 text-zinc-100' : 'text-zinc-400'
                } ${editingId !== thread.id ? 'cursor-pointer' : ''}`}
                role={editingId !== thread.id ? 'button' : undefined}
                tabIndex={editingId !== thread.id ? 0 : undefined}
                onClick={() => editingId !== thread.id && void openThread(thread.id)}
                onKeyDown={(e) => editingId !== thread.id && e.key === 'Enter' && void openThread(thread.id)}
              >
                <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  {editingId === thread.id ? (
                    <input
                      ref={editInputRef}
                      className="w-full bg-surface-600 text-zinc-100 text-xs rounded px-1.5 py-0.5 outline-none ring-1 ring-accent"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => void commitEdit()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void commitEdit() }
                        if (e.key === 'Escape') cancelEdit()
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <p className="text-xs font-medium truncate">{threadLabel(thread)}</p>
                  )}
                  <p className="text-xs text-zinc-600 flex items-center gap-1 mt-0.5">
                    <Clock className="w-2.5 h-2.5" />
                    {formatRelative(thread.updatedAt)}
                  </p>
                </div>
                <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0">
                  <button
                    className="p-0.5 hover:text-zinc-200"
                    onClick={(e) => startEditing(thread, e)}
                    title="Rename"
                  >
                    <Pencil className="w-2.5 h-2.5" />
                  </button>
                  <button
                    className="p-0.5 hover:text-red-400"
                    onClick={(e) => void handleDeleteThread(thread.id, e)}
                    title="Delete"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            ))
          })()}
        </div>
      </aside>

      {/* ── Sidebar toggle ─────────────────────────────────────────────────── */}
      <button
        className="absolute left-56 top-1/2 -translate-y-1/2 z-10 w-4 h-8 bg-surface-800 border border-surface-600 rounded-r flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
        style={{ left: sidebarOpen ? '14rem' : '0' }}
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      >
        {sidebarOpen ? <ChevronLeft className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>

      {/* ── Main chat area ─────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700 shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent" />
            <h1 className="text-sm font-semibold text-zinc-100">
              {threadId && store.threads[threadId]
                ? threadLabel(store.threads[threadId])
                : 'AI Chat'}
            </h1>
            {!threadId && (
              <span className="text-xs text-zinc-500">Cross-recording</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost py-1.5 px-2.5 text-xs"
              onClick={() => void handleNewChat()}
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              New
            </button>
            <button
              className={`btn-ghost p-1.5 ${ttsEnabled ? 'text-accent' : ''}`}
              onClick={() => {
                if (ttsEnabled) void window.api.ai.stopSpeaking()
                setTtsEnabled((v) => !v)
              }}
              title={ttsEnabled ? 'Disable text-to-speech' : 'Enable text-to-speech'}
            >
              {ttsEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 selectable">
          {messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
              <MessageSquare className="w-8 h-8 text-zinc-600" />
              <p className="text-sm text-zinc-500">
                Ask anything across all your recordings.
              </p>
              <p className="text-xs text-zinc-600 max-w-sm">
                Try: "What were the main action items from last week?" or "Who mentioned the budget?"
              </p>
            </div>
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
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-surface-700 px-4 py-3 shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              className="input text-sm resize-none leading-relaxed flex-1"
              placeholder={voiceActive ? '🎤 Listening…' : 'Ask about your recordings… (Shift+Enter for new line)'}
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
            <div className="flex flex-col gap-1.5">
              <button
                className={`btn-ghost p-2 ${voiceActive ? 'text-red-400' : ''}`}
                onMouseDown={handleVoiceDown}
                onMouseUp={handleVoiceUp}
                onTouchStart={handleVoiceDown}
                onTouchEnd={handleVoiceUp}
                title="Hold for voice input (or use ⌘⇧Space)"
              >
                {voiceActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              <button
                className="btn-primary p-2"
                onClick={() => void handleSend()}
                disabled={loading || !input.trim()}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-600 mt-1.5">
            ⌘⇧Space = push to talk &nbsp;·&nbsp; Shift+Enter = new line
          </p>
        </div>
      </div>
    </div>
  )
}

