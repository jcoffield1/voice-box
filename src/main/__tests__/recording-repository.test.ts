import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { RecordingRepository } from '@main/services/storage/repositories/RecordingRepository'

describe('RecordingRepository', () => {
  let repo: RecordingRepository

  beforeEach(() => {
    initDatabase(':memory:')
    repo = new RecordingRepository(getDatabase())
  })

  afterEach(() => {
    closeDatabase()
  })

  it('creates a recording and returns it', () => {
    const r = repo.create('Test Call')
    expect(r.id).toBeTruthy()
    expect(r.title).toBe('Test Call')
    expect(r.status).toBe('recording')
    expect(r.tags).toEqual([])
    expect(typeof r.createdAt).toBe('number')
  })

  it('finds a recording by id', () => {
    const created = repo.create('Find Me')
    const found = repo.findById(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
  })

  it('returns null for unknown id', () => {
    expect(repo.findById('non-existent-id')).toBeNull()
  })

  it('finds all recordings ordered by created_at desc', () => {
    repo.create('First')
    repo.create('Second')
    const all = repo.findAll()
    expect(all.length).toBeGreaterThanOrEqual(2)
    // Most recent first
    expect(all[0].createdAt).toBeGreaterThanOrEqual(all[1].createdAt)
  })

  it('updates recording fields', () => {
    const r = repo.create('Original')
    const updated = repo.update(r.id, { title: 'Updated', notes: 'some notes', status: 'complete' })
    expect(updated).not.toBeNull()
    expect(updated!.title).toBe('Updated')
    expect(updated!.notes).toBe('some notes')
    expect(updated!.status).toBe('complete')
  })

  it('update with no fields returns recording unchanged', () => {
    const r = repo.create('No Change')
    const result = repo.update(r.id, {})
    expect(result!.title).toBe('No Change')
  })

  it('deletes a recording', () => {
    const r = repo.create('Delete Me')
    repo.delete(r.id)
    expect(repo.findById(r.id)).toBeNull()
  })

  it('counts recordings correctly', () => {
    const initial = repo.count()
    repo.create('A')
    repo.create('B')
    expect(repo.count()).toBe(initial + 2)
  })

  // ── Gap coverage ──────────────────────────────────────────────────────────

  it('updates and retrieves tags correctly', () => {
    const r = repo.create('Tagged')
    const updated = repo.update(r.id, { tags: ['meeting', 'q2', 'sales'] })
    expect(updated!.tags).toEqual(['meeting', 'q2', 'sales'])
    const reloaded = repo.findById(r.id)
    expect(reloaded!.tags).toEqual(['meeting', 'q2', 'sales'])
  })

  it('clears tags with an empty array', () => {
    const r = repo.create('Tagged')
    repo.update(r.id, { tags: ['foo'] })
    repo.update(r.id, { tags: [] })
    expect(repo.findById(r.id)!.tags).toEqual([])
  })

  it('updates summary, summaryModel, and summaryAt', () => {
    const r = repo.create('Summary Test')
    const now = Date.now()
    const updated = repo.update(r.id, {
      summary: 'Key points: ...',
      summaryModel: 'llama3',
      summaryAt: now
    })
    expect(updated!.summary).toBe('Key points: ...')
    expect(updated!.summaryModel).toBe('llama3')
    expect(updated!.summaryAt).toBe(now)
  })

  it('updates debrief and debriefAt', () => {
    const r = repo.create('Debrief Test')
    const now = Date.now()
    const updated = repo.update(r.id, { debrief: '## Executive Summary\n\nFull debrief text.', debriefAt: now })
    expect(updated!.debrief).toBe('## Executive Summary\n\nFull debrief text.')
    expect(updated!.debriefAt).toBe(now)
  })

  it('new recording has null debrief and debriefAt', () => {
    const r = repo.create('Fresh')
    expect(r.debrief).toBeNull()
    expect(r.debriefAt).toBeNull()
  })

  it('updates audioPath and duration', () => {
    const r = repo.create('Audio Test')
    const updated = repo.update(r.id, { audioPath: '/recordings/test.wav', duration: 182 })
    expect(updated!.audioPath).toBe('/recordings/test.wav')
    expect(updated!.duration).toBe(182)
  })

  it('returns null when updating unknown id', () => {
    const result = repo.update('non-existent', { title: 'Ghost' })
    expect(result).toBeNull()
  })

  it('delete is idempotent — deleting twice does not throw', () => {
    const r = repo.create('Twice Delete')
    repo.delete(r.id)
    expect(() => repo.delete(r.id)).not.toThrow()
  })
})
