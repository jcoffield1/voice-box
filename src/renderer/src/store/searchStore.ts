import { create } from 'zustand'
import type { SearchResult, SearchQuery } from '@shared/types'

interface SearchState {
  query: string
  results: SearchResult[]
  searching: boolean
  error: string | null

  setQuery: (q: string) => void
  setResults: (results: SearchResult[]) => void
  setSearching: (v: boolean) => void
  setError: (e: string | null) => void

  search: (params: SearchQuery) => Promise<void>
  clearResults: () => void
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  results: [],
  searching: false,
  error: null,

  setQuery: (q) => set({ query: q }),
  setResults: (results) => set({ results }),
  setSearching: (v) => set({ searching: v }),
  setError: (e) => set({ error: e }),

  search: async (params) => {
    set({ searching: true, error: null })
    try {
      const result = await window.api.search.query({ query: params })
      set({ results: result.results })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Search failed' })
    } finally {
      set({ searching: false })
    }
  },

  clearResults: () => set({ results: [], query: '' })
}))
