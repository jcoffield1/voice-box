import { useState } from 'react'
import { Database, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

type ReindexState = 'idle' | 'loading' | 'done' | 'error'

export default function EmbeddingSettings() {
  const [state, setState] = useState<ReindexState>('idle')
  const [queued, setQueued] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleReindex = async () => {
    setState('loading')
    setError(null)
    setQueued(null)
    try {
      const result = await window.api.search.reindex()
      setQueued(result.queued)
      setState('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-zinc-100">Embeddings</h2>
      </div>

      <p className="text-xs text-zinc-400 leading-relaxed">
        Semantic search uses vector embeddings of your transcript segments.
        Re-index when you change the embedding model or if search results seem stale.
      </p>

      <div className="flex items-center gap-3">
        <button
          className="btn-primary text-sm"
          onClick={handleReindex}
          disabled={state === 'loading'}
        >
          {state === 'loading' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Indexing…
            </>
          ) : (
            <>
              <Database className="w-3.5 h-3.5" />
              Re-index All Embeddings
            </>
          )}
        </button>

        {state === 'done' && queued !== null && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {queued === 0
              ? 'Nothing to re-index.'
              : `${queued} segment${queued !== 1 ? 's' : ''} queued for embedding.`}
          </span>
        )}

        {state === 'error' && (
          <span className="flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle className="w-3.5 h-3.5" />
            {error ?? 'Re-index failed.'}
          </span>
        )}
      </div>

      {state === 'loading' && (
        <p className="text-xs text-zinc-500">
          Embedding is processed in the background — you can continue using the app.
        </p>
      )}
    </div>
  )
}
