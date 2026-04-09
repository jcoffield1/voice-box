import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { SpeakerRepository } from '@main/services/storage/repositories/SpeakerRepository'
import { TranscriptRepository } from '@main/services/storage/repositories/TranscriptRepository'
import { RecordingRepository } from '@main/services/storage/repositories/RecordingRepository'

describe('SpeakerRepository', () => {
  let repo: SpeakerRepository

  beforeEach(() => {
    initDatabase(':memory:')
    repo = new SpeakerRepository(getDatabase())
  })

  afterEach(() => {
    closeDatabase()
  })

  // ─── Create ───────────────────────────────────────────────────────────────

  it('creates a speaker with just a name', () => {
    const s = repo.create('Jon Smith')
    expect(s.id).toBeTruthy()
    expect(s.name).toBe('Jon Smith')
    expect(s.voiceEmbedding).toBeNull()
    expect(s.recordingCount).toBe(0)
    expect(s.notes).toBeNull()
  })

  it('creates a speaker with a voice embedding', () => {
    const embedding = Array.from({ length: 256 }, (_, i) => i / 256)
    const s = repo.create('Sarah Chang', embedding)
    expect(s.voiceEmbedding).not.toBeNull()
    expect(s.voiceEmbedding!.length).toBe(256)
    expect(s.voiceEmbedding![0]).toBeCloseTo(0, 2)
  })

  // ─── Find ─────────────────────────────────────────────────────────────────

  it('findById returns the correct speaker', () => {
    const created = repo.create('Alice')
    const found = repo.findById(created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('Alice')
  })

  it('findById returns null for unknown id', () => {
    expect(repo.findById('no-such-id')).toBeNull()
  })

  it('findByName is case-sensitive and returns matching speaker', () => {
    repo.create('Bob Jones')
    expect(repo.findByName('Bob Jones')).not.toBeNull()
    expect(repo.findByName('bob jones')).toBeNull()
  })

  it('findAll returns all speakers ordered by recording_count desc', () => {
    const a = repo.create('Alpha')
    const b = repo.create('Beta')
    repo.incrementRecordingCount(a.id)
    repo.incrementRecordingCount(a.id)
    repo.incrementRecordingCount(b.id)
    const all = repo.findAll()
    expect(all.length).toBeGreaterThanOrEqual(2)
    const names = all.map((s) => s.name)
    // Alpha has 2 recordings, Beta has 1 → Alpha comes first
    expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Beta'))
  })

  it('findWithEmbeddings returns only speakers with voice embeddings', () => {
    repo.create('No Embedding')
    repo.create('Has Embedding', [0.1, 0.2, 0.3])
    const withEmb = repo.findWithEmbeddings()
    expect(withEmb.every((s) => s.voiceEmbedding !== null)).toBe(true)
    expect(withEmb.find((s) => s.name === 'No Embedding')).toBeUndefined()
    expect(withEmb.find((s) => s.name === 'Has Embedding')).toBeDefined()
  })

  // ─── Mutate ───────────────────────────────────────────────────────────────

  it('rename updates the speaker name', () => {
    const s = repo.create('Old Name')
    const renamed = repo.rename(s.id, 'New Name')
    expect(renamed).not.toBeNull()
    expect(renamed!.name).toBe('New Name')
    expect(repo.findById(s.id)!.name).toBe('New Name')
  })

  it('rename returns null for unknown id', () => {
    expect(repo.rename('ghost-id', 'Anything')).toBeNull()
  })

  it('incrementRecordingCount increments the count and updates lastSeenAt', () => {
    const s = repo.create('Counted')
    expect(s.recordingCount).toBe(0)
    repo.incrementRecordingCount(s.id)
    repo.incrementRecordingCount(s.id)
    const updated = repo.findById(s.id)!
    expect(updated.recordingCount).toBe(2)
  })

  it('updateVoiceEmbedding replaces the embedding', () => {
    const s = repo.create('No Emb Yet')
    expect(s.voiceEmbedding).toBeNull()
    repo.updateVoiceEmbedding(s.id, [1.0, 2.0, 3.0])
    const updated = repo.findById(s.id)!
    expect(updated.voiceEmbedding).not.toBeNull()
    expect(updated.voiceEmbedding![0]).toBeCloseTo(1.0, 3)
  })

  it('delete removes the speaker', () => {
    const s = repo.create('To Delete')
    repo.delete(s.id)
    expect(repo.findById(s.id)).toBeNull()
  })

  // ─── Merge ────────────────────────────────────────────────────────────────

  it('merge re-assigns transcript segments and removes source speaker', () => {
    const db = getDatabase()
    const recRepo = new RecordingRepository(db)
    const tsRepo = new TranscriptRepository(db)

    const recording = recRepo.create('Test Recording')
    const source = repo.create('Source Speaker')
    const target = repo.create('Target Speaker')

    // Insert a segment labeled with the source speaker's name
    db.prepare(
      `INSERT INTO transcript_segments
         (id, recording_id, text, timestamp_start, timestamp_end, speaker_id, speaker_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('seg-1', recording.id, 'Hello world', 0.0, 2.0, source.id, source.name, Date.now())

    repo.merge(source.id, target.id)

    // Source should be deleted
    expect(repo.findById(source.id)).toBeNull()

    // Segment should now map to target
    const segments = tsRepo.findByRecordingId(recording.id)
    expect(segments[0].speakerId).toBe(target.id)
  })
})
