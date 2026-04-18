import { useEffect } from 'react'
import { useAIStore } from '../store/aiStore'

export function useChatThread(threadId: string | null) {
  const store = useAIStore()
  const messages = threadId ? (store.messages[threadId] ?? []) : []
  const streaming = threadId ? (store.streaming[threadId] ?? null) : null
  const loading = threadId ? (store.loading[threadId] ?? false) : false

  useEffect(() => {
    if (!threadId) return
    // Skip the fetch if messages are already loaded into the store (e.g. pre-loaded
    // by AIPanel before setting threadId to avoid an empty-flash on navigation).
    if (store.messages[threadId] !== undefined) return
    void store.loadThread(threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  // Subscribe to real-time streaming chunks
  useEffect(() => {
    const unsub = window.api.ai.onChatChunk(({ threadId: chunkThreadId, chunk }) => {
      if (!threadId || chunkThreadId !== threadId) return
      store.appendChunk(chunkThreadId, chunk)
    })
    return unsub
  }, [threadId, store])

  return {
    messages,
    streaming,
    loading,
    createThread: store.createThread,
    loadThread: store.loadThread,
    sendMessage: store.sendMessage,
    deleteThread: store.deleteThread,
    updateThreadTitle: store.updateThreadTitle,
    appendChunk: store.appendChunk,
    loadAllThreads: store.loadAllThreads,
    threadList: store.threadList,
    threads: store.threads,
  }
}
