import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { SearchService } from '@main/services/search/SearchService'
import type { LLMService } from '@main/services/llm/LLMService'

// Mock LLMService — return deterministic embeddings
function makeMockLLM(): LLMService {
  return {
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: 768 }, () => 0))
    )
  } as unknown as LLMService
}

describe('SearchService', () => {
  let svc: SearchService

  beforeEach(() => {
    initDatabase(':memory:')
    svc = new SearchService(getDatabase(), makeMockLLM())
  })

  afterEach(() => {
    closeDatabase()
  })

  it('returns empty results when corpus is empty', async () => {
    const results = await svc.query({ query: 'test' })
    expect(results).toEqual([])
  })

  it('performs keyword search and returns matching segments', async () => {
    const db = getDatabase()
    // Insert a recording and a segment so FTS has something to search
    const recId = 'rec-1'
    db.prepare(
      `INSERT INTO recordings (id, title, created_at, updated_at, status, tags)
       VALUES (?, ?, ?, ?, 'complete', '[]')`
    ).run(recId, 'Test Recording', Date.now(), Date.now())

    db.prepare(
      `INSERT INTO transcript_segments (id, recording_id, text, timestamp_start, timestamp_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('seg-1', recId, 'quarterly earnings report', 0.0, 5.0, Date.now())

    const results = await svc.query({ query: 'earnings' })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].text).toContain('earnings')
  })

  it('filters results by recordingId', async () => {
    const db = getDatabase()
    const now = Date.now()
    db.prepare(
      `INSERT INTO recordings (id, title, created_at, updated_at, status, tags) VALUES (?, ?, ?, ?, 'complete', '[]')`
    ).run('rec-a', 'Recording A', now, now)
    db.prepare(
      `INSERT INTO recordings (id, title, created_at, updated_at, status, tags) VALUES (?, ?, ?, ?, 'complete', '[]')`
    ).run('rec-b', 'Recording B', now, now)
    db.prepare(
      `INSERT INTO transcript_segments (id, recording_id, text, timestamp_start, timestamp_end, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('s1', 'rec-a', 'budget meeting notes', 0, 2, now)
    db.prepare(
      `INSERT INTO transcript_segments (id, recording_id, text, timestamp_start, timestamp_end, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('s2', 'rec-b', 'budget review session', 0, 2, now)

    const results = await svc.query({ query: 'budget', recordingId: 'rec-a' })
    expect(results.every((r) => r.recordingId === 'rec-a')).toBe(true)
  })

  it('respects limit parameter', async () => {
    const db = getDatabase()
    const now = Date.now()
    db.prepare(
      `INSERT INTO recordings (id, title, created_at, updated_at, status, tags) VALUES (?, ?, ?, ?, 'complete', '[]')`
    ).run('rec-lim', 'Limit Test', now, now)

    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO transcript_segments (id, recording_id, text, timestamp_start, timestamp_end, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`seg-lim-${i}`, 'rec-lim', `revenue discussion part ${i}`, i, i + 1, now)
    }

    const results = await svc.query({ query: 'revenue', limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
