import { useCallback } from 'react'
import { useSearchStore } from '../store/searchStore'
import type { SearchQuery } from '@shared/types'

export function useSearch() {
  const store = useSearchStore()

  const submit = useCallback(
    async (query: string, filters?: Partial<SearchQuery>) => {
      if (!query.trim()) {
        store.clearResults()
        return
      }
      store.setQuery(query)
      await store.search({ query, limit: 20, ...filters })
    },
    [store]
  )

  return {
    query: store.query,
    results: store.results,
    searching: store.searching,
    error: store.error,
    submit,
    clearResults: store.clearResults
  }
}
