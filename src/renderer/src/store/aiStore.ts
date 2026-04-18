import { create } from 'zustand'
import type { ConversationThread, ConversationMessage, LLMProviderType } from '@shared/types'

interface AIState {
  threads: Record<string, ConversationThread>
  threadList: ConversationThread[] // ordered by updatedAt desc — for history sidebar
  messages: Record<string, ConversationMessage[]>
  streaming: Record<string, string>
  loading: Record<string, boolean>

  setThread: (thread: ConversationThread) => void
  setMessages: (threadId: string, messages: ConversationMessage[]) => void
  addMessage: (message: ConversationMessage) => void
  appendChunk: (threadId: string, chunk: string) => void
  clearStreaming: (threadId: string) => void
  setLoading: (threadId: string, v: boolean) => void

  loadThread: (threadId: string) => Promise<void>
  loadAllThreads: () => Promise<void>
  createThread: (recordingId: string | null) => Promise<ConversationThread>
  deleteThread: (threadId: string) => Promise<void>
  updateThreadTitle: (threadId: string, title: string) => Promise<void>
  sendMessage: (
    threadId: string,
    message: string,
    recordingId: string | null,
    model: string,
    provider: LLMProviderType,
    templateId?: string | null,
    templateName?: string
  ) => Promise<void>
}

export const useAIStore = create<AIState>((set, get) => ({
  threads: {},
  threadList: [],
  messages: {},
  streaming: {},
  loading: {},

  setThread: (thread) =>
    set((s) => ({
      threads: { ...s.threads, [thread.id]: thread },
      // Upsert into threadList, keeping sorted by updatedAt desc
      threadList: [
        thread,
        ...s.threadList.filter((t) => t.id !== thread.id)
      ].sort((a, b) => b.updatedAt - a.updatedAt)
    })),

  setMessages: (threadId, messages) =>
    set((s) => ({ messages: { ...s.messages, [threadId]: messages } })),

  addMessage: (message) =>
    set((s) => {
      const existing = s.messages[message.threadId] ?? []
      return { messages: { ...s.messages, [message.threadId]: [...existing, message] } }
    }),

  appendChunk: (threadId, chunk) =>
    set((s) => ({
      streaming: { ...s.streaming, [threadId]: (s.streaming[threadId] ?? '') + chunk }
    })),

  clearStreaming: (threadId) =>
    set((s) => {
      const next = { ...s.streaming }
      delete next[threadId]
      return { streaming: next }
    }),

  setLoading: (threadId, v) =>
    set((s) => ({ loading: { ...s.loading, [threadId]: v } })),

  loadThread: async (threadId) => {
    get().setLoading(threadId, true)
    try {
      const result = await window.api.ai.getThread({ threadId })
      if (result.thread) get().setThread(result.thread)
      get().setMessages(threadId, result.messages)
    } finally {
      get().setLoading(threadId, false)
    }
  },

  loadAllThreads: async () => {
    const result = await window.api.ai.getThreads()
    set((s) => {
      const byId = { ...s.threads }
      for (const t of result.threads) byId[t.id] = t
      return { threads: byId, threadList: result.threads }
    })
  },

  createThread: async (recordingId) => {
    const result = await window.api.ai.createThread({ recordingId })
    get().setThread(result.thread)
    return result.thread
  },

  deleteThread: async (threadId) => {
    await window.api.ai.deleteThread({ threadId })
    set((s) => {
      const next = { ...s.threads }
      delete next[threadId]
      return {
        threads: next,
        threadList: s.threadList.filter((t) => t.id !== threadId)
      }
    })
  },

  updateThreadTitle: async (threadId, title) => {
    await window.api.ai.updateThreadTitle({ threadId, title })
    set((s) => {
      const thread = s.threads[threadId]
      if (!thread) return s
      const updated = { ...thread, title }
      return {
        threads: { ...s.threads, [threadId]: updated },
        threadList: s.threadList.map((t) => (t.id === threadId ? updated : t))
      }
    })
  },

  sendMessage: async (threadId, message, recordingId, model, provider, templateId, templateName) => {
    get().setLoading(threadId, true)
    get().clearStreaming(threadId)
    try {
      const userMsg: ConversationMessage = {
        id: `tmp_${Date.now()}`,
        threadId,
        role: 'user',
        content: message,
        createdAt: Date.now(),
        model: null,
        provider: null
      }
      get().addMessage(userMsg)

      const result = await window.api.ai.chat({
        threadId,
        message,
        recordingId,
        model,
        provider,
        ...(templateId !== undefined ? { templateId } : {}),
        ...(templateName ? { templateName } : {})
      })
      get().addMessage(result.message)
    } finally {
      get().setLoading(threadId, false)
      get().clearStreaming(threadId)
    }
  }
}))
