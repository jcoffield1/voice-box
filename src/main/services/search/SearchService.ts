import type Database from 'better-sqlite3'
import type { SearchQuery, SearchResult } from '@shared/types'
import type { LLMService } from '../llm/LLMService'

interface FtsRow {
  id: string
  recording_id: string
  text: string
  speaker_name: string | null
  timestamp_start: number
  timestamp_end: number
  rank: number
}

interface RecordingTitleRow {
  id: string
  title: string
  template_id: string | null
}

const DEFAULT_LIMIT = 20

/**
 * Hybrid search: semantic (vector) + keyword (FTS5) with Reciprocal Rank Fusion.
 */
export class SearchService {
  constructor(
    private readonly db: Database.Database,
    private readonly llm: LLMService
  ) {}

  async query(query: SearchQuery): Promise<SearchResult[]> {
    const limit = query.limit ?? DEFAULT_LIMIT

    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearch(query, limit),
      this.keywordSearch(query, limit)
    ])

    return this.mergeRrf(semanticResults, keywordResults, limit)
  }

  private async semanticSearch(query: SearchQuery, limit: number): Promise<SearchResult[]> {
    try {
      const embeddings = await this.llm.embed([query.query])
      if (!embeddings.length) return []

      const vec = embeddings[0]
      // sqlite-vec query — returns segment_id ordered by similarity
      const rows = this.db
        .prepare<[Buffer, number], { segment_id: string; distance: number }>(
          `SELECT segment_id, distance
           FROM transcript_embeddings
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`
        )
        .all(Buffer.from(new Float32Array(vec).buffer), limit)

      return rows
        .map((r) => this.resolveSegment(r.segment_id, 1 / (1 + r.distance), 'semantic'))
        .filter((r): r is SearchResult => r !== null)
        .filter((r) => this.matchesFilters(r, query))
    } catch {
      // If embeddings not available, fall through to keyword only
      return []
    }
  }

  private keywordSearch(query: SearchQuery, limit: number): SearchResult[] {
    const ftsQuery = query.query.replace(/['"*]/g, '') // Sanitize FTS query
    const rows = this.db
      .prepare<[string, number], FtsRow>(
        `SELECT ts.id, ts.recording_id, ts.text, ts.speaker_name,
                ts.timestamp_start, ts.timestamp_end,
                fts.rank
         FROM transcript_fts fts
         JOIN transcript_segments ts ON ts.rowid = fts.rowid
         WHERE transcript_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`
      )
      .all(ftsQuery, limit)

    return rows
      .map((r) => this.rowToResult(r, -r.rank / 10, 'keyword'))
      .filter((r) => this.matchesFilters(r, query))
  }

  private resolveSegment(segmentId: string, score: number, type: SearchResult['matchType']): SearchResult | null {
    const row = this.db
      .prepare<string, FtsRow & { recording_id: string }>(
        `SELECT ts.id, ts.recording_id, ts.text, ts.speaker_name,
                ts.timestamp_start, ts.timestamp_end, 0 as rank
         FROM transcript_segments ts
         WHERE ts.id = ?`
      )
      .get(segmentId)
    if (!row) return null
    return this.rowToResult(row, score, type)
  }

  private rowToResult(
    row: Pick<FtsRow, 'id' | 'recording_id' | 'text' | 'speaker_name' | 'timestamp_start' | 'timestamp_end'>,
    score: number,
    matchType: SearchResult['matchType']
  ): SearchResult {
    const recording = this.db
      .prepare<string, RecordingTitleRow>(`SELECT id, title, template_id FROM recordings WHERE id = ?`)
      .get(row.recording_id)

    const snippet = row.text.length > 200 ? row.text.slice(0, 200) + '…' : row.text

    return {
      segmentId: row.id,
      recordingId: row.recording_id,
      recordingTitle: recording?.title ?? 'Unknown Recording',
      templateId: recording?.template_id ?? null,
      text: row.text,
      speakerName: row.speaker_name,
      timestampStart: row.timestamp_start,
      timestampEnd: row.timestamp_end,
      score,
      matchType,
      snippet
    }
  }

  private matchesFilters(result: SearchResult, query: SearchQuery): boolean {
    if (query.recordingId && result.recordingId !== query.recordingId) return false
    if (query.speakerName && result.speakerName?.toLowerCase() !== query.speakerName.toLowerCase()) return false
    if ('templateId' in query) {
      // null means "recordings using the default" (no explicit template assigned)
      if (result.templateId !== query.templateId) return false
    }
    return true
  }

  /**
   * Reciprocal Rank Fusion — merges ranked lists from semantic + keyword search.
   */
  private mergeRrf(
    semantic: SearchResult[],
    keyword: SearchResult[],
    limit: number
  ): SearchResult[] {
    const k = 60 // RRF constant
    const scores = new Map<string, { result: SearchResult; score: number }>()

    const addRank = (results: SearchResult[], type: 'semantic' | 'keyword') => {
      results.forEach((r, i) => {
        const rrfScore = 1 / (k + i + 1)
        const existing = scores.get(r.segmentId)
        if (existing) {
          existing.score += rrfScore
          existing.result.matchType = 'hybrid'
        } else {
          scores.set(r.segmentId, { result: { ...r, matchType: type }, score: rrfScore })
        }
      })
    }

    addRank(semantic, 'semantic')
    addRank(keyword, 'keyword')

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.result, score: entry.score }))
  }
}
