import { useState, useEffect, useCallback } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useSearch } from '../hooks/useSearch'
import SearchResultCard from '../components/search/SearchResultCard'
import type { SpeakerProfile } from '@shared/types'

const HISTORY_KEY = 'vb:searchHistory'
const MAX_HISTORY = 10

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function saveHistory(query: string) {
  const history = loadHistory().filter((h) => h !== query)
  localStorage.setItem(HISTORY_KEY, JSON.stringify([query, ...history].slice(0, MAX_HISTORY)))
}

export default function SearchPage() {
  const [input, setInput] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([])
  const [speakerFilter, setSpeakerFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [history, setHistory] = useState<string[]>(loadHistory)
  const [showHistory, setShowHistory] = useState(false)
  const { results, searching, error, submit } = useSearch()

  useEffect(() => {
    window.api.speaker.getAll().then(({ speakers: all }) => setSpeakers(all)).catch(() => {})
  }, [])

  const handleSubmit = useCallback(
    (e?: React.FormEvent, overrideQuery?: string) => {
      e?.preventDefault()
      const q = (overrideQuery ?? input).trim()
      if (!q) return
      setShowHistory(false)
      saveHistory(q)
      setHistory(loadHistory())
      void submit(q, {
        speakerName: speakerFilter || undefined,
        dateFrom: dateFrom ? new Date(dateFrom).getTime() : undefined,
        dateTo: dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : undefined
      })
    },
    [input, speakerFilter, dateFrom, dateTo, submit]
  )

  const clearFilters = () => {
    setSpeakerFilter('')
    setDateFrom('')
    setDateTo('')
  }

  const hasFilters = speakerFilter || dateFrom || dateTo

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-xl font-semibold text-zinc-100">Search Transcripts</h1>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Main search bar */}
        <div className="relative">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                className="input flex-1 w-full selectable pr-8"
                placeholder="Search across all recordings…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => setShowHistory(history.length > 0)}
                onBlur={() => setTimeout(() => setShowHistory(false), 150)}
              />
              {input && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                  onClick={() => setInput('')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              className={`btn-ghost py-2 px-3 ${showFilters ? 'text-accent' : ''} ${hasFilters ? 'ring-1 ring-accent' : ''}`}
              onClick={() => setShowFilters((v) => !v)}
              title="Filters"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
            <button type="submit" className="btn-primary" disabled={searching}>
              <Search className="w-4 h-4" />
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {/* Search history dropdown */}
          {showHistory && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-600 rounded-lg shadow-lg z-10 py-1">
              {history.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:bg-surface-700 truncate"
                  onMouseDown={() => {
                    setInput(h)
                    handleSubmit(undefined, h)
                  }}
                >
                  {h}
                </button>
              ))}
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-400 border-t border-surface-700 mt-1"
                onMouseDown={() => {
                  localStorage.removeItem(HISTORY_KEY)
                  setHistory([])
                  setShowHistory(false)
                }}
              >
                Clear history
              </button>
            </div>
          )}
        </div>

        {/* Filters panel */}
        {showFilters && (
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-300">Filters</span>
              {hasFilters && (
                <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={clearFilters}>
                  Clear all
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Speaker</label>
                <select
                  className="input text-sm w-full"
                  value={speakerFilter}
                  onChange={(e) => setSpeakerFilter(e.target.value)}
                >
                  <option value="">All speakers</option>
                  {speakers.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">From date</label>
                <input
                  type="date"
                  className="input text-sm w-full"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">To date</label>
                <input
                  type="date"
                  className="input text-sm w-full"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
      </form>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">{results.length} result{results.length !== 1 ? 's' : ''}</p>
          {results.map((result, i) => (
            <SearchResultCard key={`${result.segmentId}-${i}`} result={result} />
          ))}
        </div>
      )}

      {!searching && results.length === 0 && input && (
        <p className="text-sm text-zinc-500 text-center py-8">No results found.</p>
      )}
    </div>
  )
}

