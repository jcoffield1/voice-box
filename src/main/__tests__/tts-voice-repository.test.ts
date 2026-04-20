import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { TtsVoiceRepository } from '@main/services/storage/repositories/TtsVoiceRepository'

/** Insert a minimal recording row so FK constraints on source_recording_id pass. */
function insertRecording(id: string) {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(
    `INSERT INTO recordings (id, title, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?)`
  ).run(id, 'Test Recording', now, now, 'complete')
}

describe('TtsVoiceRepository', () => {
  let repo: TtsVoiceRepository

  beforeEach(() => {
    initDatabase(':memory:')
    repo = new TtsVoiceRepository(getDatabase())
  })

  afterEach(() => {
    closeDatabase()
  })

  // ─── Voice CRUD ────────────────────────────────────────────────────────────

  describe('create / findAll / findById', () => {
    it('creates a voice and returns it', () => {
      const voice = repo.create('Alice')
      expect(voice.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(voice.name).toBe('Alice')
      expect(voice.description).toBeNull()
      expect(voice.sampleCount).toBe(0)
      expect(typeof voice.createdAt).toBe('number')
      expect(typeof voice.updatedAt).toBe('number')
    })

    it('trims whitespace from name on create', () => {
      const voice = repo.create('  Bob  ')
      expect(voice.name).toBe('Bob')
    })

    it('stores optional description', () => {
      const voice = repo.create('Carol', 'Sales calls voice')
      expect(voice.description).toBe('Sales calls voice')
    })

    it('stores optional voiceDesignPrompt', () => {
      const voice = repo.create('DesignVoice', undefined, 'A warm British male voice')
      expect(voice.voiceDesignPrompt).toBe('A warm British male voice')
    })

    it('findAll returns voices ordered by name case-insensitively', () => {
      repo.create('Zelda')
      repo.create('alice')
      repo.create('Bob')
      const all = repo.findAll()
      expect(all.map((v) => v.name)).toEqual(['alice', 'Bob', 'Zelda'])
    })

    it('findAll returns sampleCount = 0 when no samples exist', () => {
      repo.create('Empty')
      const [v] = repo.findAll()
      expect(v.sampleCount).toBe(0)
    })

    it('findAll includes sampleCount', () => {
      const voice = repo.create('WithSamples')
      repo.addSample(voice.id, '/path/a.wav')
      repo.addSample(voice.id, '/path/b.wav')
      const found = repo.findAll().find((v) => v.id === voice.id)!
      expect(found.sampleCount).toBe(2)
    })

    it('findById returns the voice', () => {
      const voice = repo.create('Dave')
      const found = repo.findById(voice.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Dave')
    })

    it('findById returns null for unknown id', () => {
      expect(repo.findById('non-existent-id')).toBeNull()
    })
  })

  describe('update', () => {
    it('renames a voice', () => {
      const voice = repo.create('Old Name')
      const updated = repo.update(voice.id, 'New Name')
      expect(updated!.name).toBe('New Name')
    })

    it('updates description to empty string stores null', () => {
      const voice = repo.create('Voice', 'original desc')
      const updated = repo.update(voice.id, undefined, '')
      expect(updated!.description).toBeNull()
    })

    it('updates voiceDesignPrompt', () => {
      const voice = repo.create('Voice')
      const updated = repo.update(voice.id, undefined, undefined, 'Deep narrator voice')
      expect(updated!.voiceDesignPrompt).toBe('Deep narrator voice')
    })

    it('clears voiceDesignPrompt when set to empty string', () => {
      const voice = repo.create('Voice', undefined, 'Old prompt')
      const updated = repo.update(voice.id, undefined, undefined, '')
      expect(updated!.voiceDesignPrompt).toBeNull()
    })

    it('update bumps updatedAt', async () => {
      const voice = repo.create('Timely')
      await new Promise((r) => setTimeout(r, 5))
      const updated = repo.update(voice.id, 'Timely2')
      expect(updated!.updatedAt).toBeGreaterThan(voice.updatedAt)
    })

    it('returns null when voice id not found', () => {
      const result = repo.update('bad-id', 'X')
      expect(result).toBeNull()
    })
  })

  describe('delete', () => {
    it('deletes a voice', () => {
      const voice = repo.create('ToDelete')
      repo.delete(voice.id)
      expect(repo.findById(voice.id)).toBeNull()
    })

    it('does not throw when deleting a non-existent id', () => {
      expect(() => repo.delete('ghost-id')).not.toThrow()
    })
  })

  // ─── Sample CRUD ──────────────────────────────────────────────────────────

  describe('addSample / findSamplesByVoiceId / findSampleById', () => {
    it('adds a sample and returns it', () => {
      const voice = repo.create('Speaker')
      const sample = repo.addSample(voice.id, '/audio/clip.wav', {
        transcript: 'Hello world',
        durationSec: 4.5,
      })
      expect(sample.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(sample.voiceId).toBe(voice.id)
      expect(sample.audioPath).toBe('/audio/clip.wav')
      expect(sample.transcript).toBe('Hello world')
      expect(sample.durationSec).toBe(4.5)
      expect(sample.sourceRecordingId).toBeNull()
    })

    it('sample with source recording id is stored', () => {
      const voice = repo.create('Speaker')
      insertRecording('rec-abc')
      const sample = repo.addSample(voice.id, '/audio/clip.wav', {
        sourceRecordingId: 'rec-abc',
      })
      expect(sample.sourceRecordingId).toBe('rec-abc')
    })

    it('addSample increments voice sampleCount', () => {
      const voice = repo.create('Speaker')
      repo.addSample(voice.id, '/a.wav')
      repo.addSample(voice.id, '/b.wav')
      const found = repo.findById(voice.id)!
      expect(found.sampleCount).toBe(2)
    })

    it('addSample bumps voice updatedAt', async () => {
      const voice = repo.create('Time')
      await new Promise((r) => setTimeout(r, 5))
      repo.addSample(voice.id, '/x.wav')
      const found = repo.findById(voice.id)!
      expect(found.updatedAt).toBeGreaterThan(voice.updatedAt)
    })

    it('findSamplesByVoiceId returns samples ordered by created_at asc', async () => {
      const voice = repo.create('Ordered')
      const s1 = repo.addSample(voice.id, '/first.wav')
      await new Promise((r) => setTimeout(r, 5))
      const s2 = repo.addSample(voice.id, '/second.wav')
      const samples = repo.findSamplesByVoiceId(voice.id)
      expect(samples.map((s) => s.id)).toEqual([s1.id, s2.id])
    })

    it('findSamplesByVoiceId returns [] for voice with no samples', () => {
      const voice = repo.create('Empty')
      expect(repo.findSamplesByVoiceId(voice.id)).toEqual([])
    })

    it('findSampleById returns the sample', () => {
      const voice = repo.create('Speaker')
      const sample = repo.addSample(voice.id, '/audio/clip.wav')
      const found = repo.findSampleById(sample.id)
      expect(found).not.toBeNull()
      expect(found!.audioPath).toBe('/audio/clip.wav')
    })

    it('findSampleById returns null for unknown id', () => {
      expect(repo.findSampleById('ghost')).toBeNull()
    })
  })

  describe('findLatestSample', () => {
    it('returns the most recently added sample', async () => {
      const voice = repo.create('Speaker')
      repo.addSample(voice.id, '/old.wav')
      await new Promise((r) => setTimeout(r, 5))
      const latest = repo.addSample(voice.id, '/new.wav')
      const found = repo.findLatestSample(voice.id)
      expect(found!.id).toBe(latest.id)
    })

    it('returns null when no samples exist', () => {
      const voice = repo.create('Empty')
      expect(repo.findLatestSample(voice.id)).toBeNull()
    })
  })

  describe('deleteSample', () => {
    it('removes a sample', () => {
      const voice = repo.create('Speaker')
      const sample = repo.addSample(voice.id, '/a.wav')
      repo.deleteSample(sample.id)
      expect(repo.findSampleById(sample.id)).toBeNull()
    })

    it('decrements voice sampleCount', () => {
      const voice = repo.create('Speaker')
      const s1 = repo.addSample(voice.id, '/a.wav')
      repo.addSample(voice.id, '/b.wav')
      repo.deleteSample(s1.id)
      expect(repo.findById(voice.id)!.sampleCount).toBe(1)
    })

    it('does not throw for unknown sample id', () => {
      expect(() => repo.deleteSample('ghost')).not.toThrow()
    })
  })

  // ─── Cascade delete ───────────────────────────────────────────────────────

  it('deleting a voice cascade-deletes its samples', () => {
    const voice = repo.create('Speaker')
    const sample = repo.addSample(voice.id, '/a.wav')
    repo.delete(voice.id)
    expect(repo.findSampleById(sample.id)).toBeNull()
  })

  // ─── Migration check ──────────────────────────────────────────────────────

  it('both tts tables are created by migrations', () => {
    const db = getDatabase()
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('tts_voices')
    expect(tables).toContain('tts_voice_samples')
  })
})
