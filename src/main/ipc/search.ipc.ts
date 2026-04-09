import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  SearchArgs,
  SearchResult_,
  ReindexArgs,
  ReindexResult
} from '@shared/ipc-types'
import type { SearchService } from '../services/search/SearchService'
import type { EmbeddingService } from '../services/llm/EmbeddingService'

interface SearchIpcDeps {
  search: SearchService
  embeddingService: EmbeddingService
}

export function registerSearchIpc(deps: SearchIpcDeps): void {
  const { search, embeddingService } = deps

  ipcMain.handle(IPC.search.query, async (_event, args: SearchArgs): Promise<SearchResult_> => {
    const results = await search.query(args.query)
    return { results }
  })

  ipcMain.handle(IPC.search.reindex, async (_event, args: ReindexArgs): Promise<ReindexResult> => {
    return embeddingService.indexAll(args?.recordingId)
  })
}
