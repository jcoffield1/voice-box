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
  notes: string | null
  tags: string
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

    // Include recordings whose notes/tags match the query text
    const notesResults = this.notesAndTagsSearch(query, Math.min(limit, 5))
    const combinedKeyword = [
      ...keywordResults,
      ...notesResults.filter((nr) => !keywordResults.some((kr) => kr.segmentId === nr.segmentId))
    ]

    return this.mergeRrf(semanticResults, combinedKeyword, limit)
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
    const ftsQuery = this.buildFtsMatchExpression(query.query)
    if (!ftsQuery) return []
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

  /**
   * Convert a free-text query into an FTS5 MATCH expression. FTS5 defaults to
   * AND semantics across tokens, so passing a full question like "what
   * conversations have been centered around electron?" requires every word to
   * co-occur in a single segment — which never happens. We drop common stop
   * words and OR the remaining content tokens so any segment that mentions a
   * meaningful term still surfaces. Tokens shorter than 3 chars are dropped to
   * avoid noise; if everything is filtered out we fall back to OR-ing all
   * non-stop tokens regardless of length.
   */
  private buildFtsMatchExpression(raw: string): string {
    const STOP_WORDS = new Set([
      'a','an','and','any','are','around','as','at','be','been','being','but','by','can',
      'centered','could','did','do','does','doing','for','from','had','has','have','having',
      'he','her','here','him','his','how','i','if','in','into','is','it','its','just','like',
      'me','my','no','not','of','on','or','our','out','over','please','should','so','some',
      'such','than','that','the','their','them','then','there','these','they','this','those',
      'to','too','under','up','was','we','were','what','when','where','which','while','who',
      'why','will','with','would','you','your'
    ])
    const cleaned = raw.replace(/['"*():^]/g, ' ')
    const tokens = cleaned
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean)
    let content = tokens.filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    if (content.length === 0) content = tokens.filter((t) => !STOP_WORDS.has(t))
    if (content.length === 0) return ''
    // Quote each token defensively in case it collides with FTS5 keywords.
    return content.map((t) => `"${t}"`).join(' OR ')
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
      .prepare<string, RecordingTitleRow>(`SELECT id, title, template_id, notes, tags FROM recordings WHERE id = ?`)
      .get(row.recording_id)

    const snippet = row.text.length > 200 ? row.text.slice(0, 200) + '…' : row.text

    return {
      segmentId: row.id,
      recordingId: row.recording_id,
      recordingTitle: recording?.title ?? 'Unknown Recording',
      templateId: recording?.template_id ?? null,
      recordingNotes: recording?.notes ?? null,
      recordingTags: JSON.parse(recording?.tags ?? '[]') as string[],
      text: row.text,
      speakerName: row.speaker_name,
      timestampStart: row.timestamp_start,
      timestampEnd: row.timestamp_end,
      score,
      matchType,
      snippet
    }
  }

  /** Search recordings whose notes or tags contain any query term; returns one representative segment per match. */
  private notesAndTagsSearch(query: SearchQuery, limit: number): SearchResult[] {
    const STOP_WORDS = new Set([
      'a','an','and','any','are','around','as','at','be','been','being','but','by','can',
      'centered','could','did','do','does','doing','for','from','had','has','have','having',
      'he','her','here','him','his','how','i','if','in','into','is','it','its','just','like',
      'me','my','no','not','of','on','or','our','out','over','please','should','so','some',
      'such','than','that','the','their','them','then','there','these','they','this','those',
      'to','too','under','up','was','we','were','what','when','where','which','while','who',
      'why','will','with','would','you','your'
    ])
    const allTerms = query.query
      .toLowerCase()
      .replace(/['"*]/g, '')
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]+/g, ''))
      .filter(Boolean)
    const terms = allTerms.filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    if (terms.length === 0) return []

    const notesConds = terms.map(() => 'LOWER(r.notes) LIKE ?').join(' OR ')
    const tagsConds = terms.map(() => 'LOWER(r.tags) LIKE ?').join(' OR ')
    const params = terms.map((w) => `%${w.toLowerCase()}%`)

    const matchingIds = this.db
      .prepare<unknown[], { recording_id: string }>(
        `SELECT DISTINCT r.id as recording_id
         FROM recordings r
         WHERE (r.notes IS NOT NULL AND r.notes != '' AND (${notesConds}))
            OR (r.tags IS NOT NULL AND r.tags != '[]' AND (${tagsConds}))
         LIMIT ?`
      )
      .all([...params, ...params, limit])

    const results: SearchResult[] = []
    for (const { recording_id } of matchingIds) {
      const row = this.db
        .prepare<string, FtsRow & { recording_id: string }>(
          `SELECT ts.id, ts.recording_id, ts.text, ts.speaker_name,
                  ts.timestamp_start, ts.timestamp_end, 0 as rank
           FROM transcript_segments ts
           WHERE ts.recording_id = ?
           ORDER BY ts.timestamp_start ASC
           LIMIT 1`
        )
        .get(recording_id)
      if (row) {
        const r = this.rowToResult(row, 0.5, 'keyword')
        if (this.matchesFilters(r, query)) results.push(r)
      }
    }
    return results
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
