import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { RecordingRepository } from '@main/services/storage/repositories/RecordingRepository'
import { TranscriptRepository } from '@main/services/storage/repositories/TranscriptRepository'
import { SpeakerRepository } from '@main/services/storage/repositories/SpeakerRepository'

describe('TranscriptRepository', () => {
  let repo: TranscriptRepository
  let recordingId: string

  beforeEach(() => {
    initDatabase(':memory:')
    const db = getDatabase()
    const recRepo = new RecordingRepository(db)
    const recording = recRepo.create('Test Recording')
    recordingId = recording.id
    repo = new TranscriptRepository(db)
  })

  afterEach(() => {
    closeDatabase()
  })

  it('creates a segment and returns it', () => {
    const seg = repo.create({
      recordingId,
      text: 'Hello world',
      timestampStart: 0.5,
      timestampEnd: 2.5
    })
    expect(seg.id).toBeTruthy()
    expect(seg.text).toBe('Hello world')
    expect(seg.recordingId).toBe(recordingId)
    expect(seg.timestampStart).toBeCloseTo(0.5)
  })

  it('finds segment by id', () => {
    const seg = repo.create({ recordingId, text: 'Findable', timestampStart: 1, timestampEnd: 2 })
    const found = repo.findById(seg.id)
    expect(found).not.toBeNull()
    expect(found!.text).toBe('Findable')
  })

  it('returns null for unknown segment id', () => {
    expect(repo.findById('unknown')).toBeNull()
  })

  it('finds all segments for a recording', () => {
    repo.create({ recordingId, text: 'A', timestampStart: 0, timestampEnd: 1 })
    repo.create({ recordingId, text: 'B', timestampStart: 1, timestampEnd: 2 })
    const segments = repo.findByRecordingId(recordingId)
    expect(segments.length).toBe(2)
    expect(segments[0].timestampStart).toBeLessThanOrEqual(segments[1].timestampStart)
  })

  it('updates text and sets isEdited', () => {
    const seg = repo.create({ recordingId, text: 'Original', timestampStart: 0, timestampEnd: 1 })
    repo.updateText(seg.id, 'Corrected')
    const updated = repo.findById(seg.id)
    expect(updated!.text).toBe('Corrected')
    expect(updated!.isEdited).toBe(true)
  })

  it('assigns speaker to all segments with matching speakerId', () => {
    const db = getDatabase()
    const speakerRepo = new SpeakerRepository(db)
    const spk0 = speakerRepo.create('SPEAKER_00')
    const spk1 = speakerRepo.create('SPEAKER_01')

    repo.create({ recordingId, text: 'X', timestampStart: 0, timestampEnd: 1, speakerId: spk0.id })
    repo.create({ recordingId, text: 'Y', timestampStart: 1, timestampEnd: 2, speakerId: spk0.id })
    repo.create({ recordingId, text: 'Z', timestampStart: 2, timestampEnd: 3, speakerId: spk1.id })

    // assignSpeakerToRecording matches on speaker_id
    const updated = repo.assignSpeakerToRecording(recordingId, spk0.id, 'Alice')
    expect(updated).toBe(2)

    const segments = repo.findByRecordingId(recordingId)
    const aliased = segments.filter((s) => s.speakerName === 'Alice')
    expect(aliased.length).toBe(2)
  })

  // ── Gap coverage ──────────────────────────────────────────────────────────

  it('assignSpeakerByRawId matches segments with the raw diarization label', () => {
    const db = getDatabase()
    const speakerRepo = new SpeakerRepository(db)
    const profile = speakerRepo.create('Jon')

    repo.create({ recordingId, text: 'A', timestampStart: 0, timestampEnd: 1, speakerId: 'SPEAKER_00' })
    repo.create({ recordingId, text: 'B', timestampStart: 1, timestampEnd: 2, speakerId: 'SPEAKER_00' })
    repo.create({ recordingId, text: 'C', timestampStart: 2, timestampEnd: 3, speakerId: 'SPEAKER_01' })

    const count = repo.assignSpeakerByRawId(recordingId, 'SPEAKER_00', profile.id, 'Jon')
    expect(count).toBe(2)

    const segments = repo.findByRecordingId(recordingId)
    expect(segments.filter((s) => s.speakerName === 'Jon').length).toBe(2)
    expect(segments.find((s) => s.text === 'C')!.speakerName).toBeNull()
  })

  it('assignSpeakerToNullSegments assigns to segments where speaker_id is NULL', () => {
    const db = getDatabase()
    const speakerRepo = new SpeakerRepository(db)
    const profile = speakerRepo.create('Unknown Speaker')

    // Two segments with no speaker, one already labelled
    repo.create({ recordingId, text: 'No label 1', timestampStart: 0, timestampEnd: 1 })
    repo.create({ recordingId, text: 'No label 2', timestampStart: 1, timestampEnd: 2 })
    repo.create({ recordingId, text: 'Has label', timestampStart: 2, timestampEnd: 3, speakerId: profile.id, speakerName: 'Already' })

    const count = repo.assignSpeakerToNullSegments(recordingId, profile.id, 'Unknown Speaker')
    expect(count).toBe(2)

    const segments = repo.findByRecordingId(recordingId)
    const labeled = segments.filter((s) => s.speakerName === 'Unknown Speaker')
    expect(labeled.length).toBe(2)
    expect(segments.find((s) => s.text === 'Has label')!.speakerName).toBe('Already')
  })

  it('saveEmbedding stores a vector for a segment', () => {
    const seg = repo.create({ recordingId, text: 'Embeddable', timestampStart: 0, timestampEnd: 1 })
    const embedding = Array.from({ length: 768 }, (_, i) => i * 0.001)
    // Should not throw
    expect(() => repo.saveEmbedding(seg.id, embedding)).not.toThrow()
  })

  it('saveEmbedding is idempotent — second call replaces the first', () => {
    const seg = repo.create({ recordingId, text: 'Embed Again', timestampStart: 0, timestampEnd: 1 })
    const v1 = Array.from({ length: 768 }, () => 0.1)
    const v2 = Array.from({ length: 768 }, () => 0.9)
    repo.saveEmbedding(seg.id, v1)
    expect(() => repo.saveEmbedding(seg.id, v2)).not.toThrow()
  })

  it('updateText on unknown segment id does not throw', () => {
    expect(() => repo.updateText('non-existent-id', 'Some text')).not.toThrow()
  })

  it('stores and retrieves whisperConfidence', () => {
    const seg = repo.create({ recordingId, text: 'Confident', timestampStart: 0, timestampEnd: 1, whisperConfidence: 0.92 })
    const found = repo.findById(seg.id)
    expect(found!.whisperConfidence).toBeCloseTo(0.92)
  })

  it('findAllWithContext returns recording title alongside segments', () => {
    repo.create({ recordingId, text: 'Context test', timestampStart: 0, timestampEnd: 1 })
    const results = repo.findAllWithContext(recordingId)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].recordingTitle).toBeTruthy()
  })
})
