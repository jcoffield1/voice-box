import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { SpeakerProfile } from '@shared/types'

interface SpeakerRow {
  id: string
  name: string
  voice_embedding: Buffer | null
  embedding_dim: number
  embedding_samples: number
  confidence_threshold: number
  recording_count: number
  created_at: number
  last_seen_at: number | null
  notes: string | null
  is_owner: number
}

function rowToSpeaker(row: SpeakerRow): SpeakerProfile {
  let voiceEmbedding: number[] | null = null
  if (row.voice_embedding) {
    // Node.js Buffer.buffer returns the pool-sized ArrayBuffer, not the slice.
    // Must pass byteOffset + length so Float32Array reads only the stored bytes.
    const buf = row.voice_embedding
    const floatArray = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    voiceEmbedding = Array.from(floatArray)
  }
  return {
    id: row.id,
    name: row.name,
    voiceEmbedding,
    embeddingSamples: row.embedding_samples ?? 0,
    recordingCount: row.recording_count,
    firstSeenAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? row.created_at,
    notes: row.notes
  }
}

export class SpeakerRepository {
  constructor(private readonly db: Database.Database) {}

  create(name: string, voiceEmbedding?: number[], isOwner = false): SpeakerProfile {
    const id = randomUUID()
    const now = Date.now()
    let embeddingBuffer: Buffer | null = null
    if (voiceEmbedding) {
      embeddingBuffer = Buffer.from(new Float32Array(voiceEmbedding).buffer)
    }
    this.db
      .prepare(
        `INSERT INTO speaker_profiles
           (id, name, voice_embedding, created_at, last_seen_at, is_owner)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, name, embeddingBuffer, now, now, isOwner ? 1 : 0)
    return this.findById(id)!
  }

  findById(id: string): SpeakerProfile | null {
    const row = this.db
      .prepare<string, SpeakerRow>(
        `SELECT sp.*,
                (SELECT COUNT(DISTINCT ts.recording_id)
                 FROM transcript_segments ts
                 WHERE ts.speaker_id = sp.id) AS recording_count
         FROM speaker_profiles sp
         WHERE sp.id = ?`
      )
      .get(id)
    return row ? rowToSpeaker(row) : null
  }

  findByName(name: string): SpeakerProfile | null {
    const row = this.db
      .prepare<string, SpeakerRow>(`SELECT * FROM speaker_profiles WHERE name = ?`)
      .get(name)
    return row ? rowToSpeaker(row) : null
  }

  findAll(): SpeakerProfile[] {
    const rows = this.db
      .prepare<[], SpeakerRow>(
        `SELECT sp.*,
                (SELECT COUNT(DISTINCT ts.recording_id)
                 FROM transcript_segments ts
                 WHERE ts.speaker_id = sp.id) AS recording_count
         FROM speaker_profiles sp
         ORDER BY recording_count DESC, sp.name ASC`
      )
      .all()
    return rows.map(rowToSpeaker)
  }

  /** Find all speakers that have a stored voice embedding */
  findWithEmbeddings(): Array<SpeakerProfile & { voiceEmbedding: number[] }> {
    const rows = this.db
      .prepare<[], SpeakerRow>(
        `SELECT * FROM speaker_profiles WHERE voice_embedding IS NOT NULL`
      )
      .all()
    return rows.map(rowToSpeaker).filter(
      (s): s is SpeakerProfile & { voiceEmbedding: number[] } => s.voiceEmbedding !== null
    )
  }

  rename(id: string, name: string): SpeakerProfile | null {
    this.db.prepare(`UPDATE speaker_profiles SET name = ? WHERE id = ?`).run(name, id)
    return this.findById(id)
  }

  updateVoiceEmbedding(id: string, embedding: number[], samples: number): void {
    const buf = Buffer.from(new Float32Array(embedding).buffer)
    this.db
      .prepare(`UPDATE speaker_profiles SET voice_embedding = ?, embedding_samples = ? WHERE id = ?`)
      .run(buf, samples, id)
  }

  resetVoiceEmbedding(id: string): void {
    this.db
      .prepare(`UPDATE speaker_profiles SET voice_embedding = NULL, embedding_samples = 0 WHERE id = ?`)
      .run(id)
  }

  incrementRecordingCount(id: string): void {
    this.db
      .prepare(`UPDATE speaker_profiles SET recording_count = recording_count + 1, last_seen_at = ? WHERE id = ?`)
      .run(Date.now(), id)
  }

  updateNotes(id: string, notes: string | null): SpeakerProfile | null {
    this.db.prepare(`UPDATE speaker_profiles SET notes = ? WHERE id = ?`).run(notes, id)
    return this.findById(id)
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM speaker_profiles WHERE id = ?`).run(id)
  }

  /** Reassign all segments from sourceId to targetId (merge) */
  merge(sourceId: string, targetId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE transcript_segments SET speaker_id = ? WHERE speaker_id = ?`
        )
        .run(targetId, sourceId)
      this.db.prepare(`DELETE FROM speaker_profiles WHERE id = ?`).run(sourceId)
    })()
  }
}
