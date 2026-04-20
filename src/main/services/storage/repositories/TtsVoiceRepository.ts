import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { TtsVoice, TtsVoiceSample } from '@shared/types'

// ─── Row types (SQLite column names → camelCase) ──────────────────────────────

interface TtsVoiceRow {
  id: string
  name: string
  description: string | null
  voice_design_prompt: string | null
  sample_count: number
  created_at: number
  updated_at: number
}

interface TtsVoiceSampleRow {
  id: string
  voice_id: string
  audio_path: string
  transcript: string | null
  duration_sec: number | null
  source_recording_id: string | null
  created_at: number
}

function rowToVoice(row: TtsVoiceRow): TtsVoice {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    voiceDesignPrompt: row.voice_design_prompt,
    sampleCount: row.sample_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSample(row: TtsVoiceSampleRow): TtsVoiceSample {
  return {
    id: row.id,
    voiceId: row.voice_id,
    audioPath: row.audio_path,
    transcript: row.transcript,
    durationSec: row.duration_sec,
    sourceRecordingId: row.source_recording_id,
    createdAt: row.created_at,
  }
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class TtsVoiceRepository {
  constructor(private readonly db: Database.Database) {}

  // ─── Voices ──────────────────────────────────────────────────────────────

  findAll(): TtsVoice[] {
    const rows = this.db
      .prepare<
        [],
        TtsVoiceRow
      >(
        `SELECT v.id, v.name, v.description, v.voice_design_prompt, v.created_at, v.updated_at,
                (SELECT COUNT(*) FROM tts_voice_samples s WHERE s.voice_id = v.id) AS sample_count
         FROM tts_voices v
         ORDER BY v.name COLLATE NOCASE ASC`
      )
      .all()
    return rows.map(rowToVoice)
  }

  findById(id: string): TtsVoice | null {
    const row = this.db
      .prepare<
        [string],
        TtsVoiceRow
      >(
        `SELECT v.id, v.name, v.description, v.voice_design_prompt, v.created_at, v.updated_at,
                (SELECT COUNT(*) FROM tts_voice_samples s WHERE s.voice_id = v.id) AS sample_count
         FROM tts_voices v
         WHERE v.id = ?`
      )
      .get(id)
    return row ? rowToVoice(row) : null
  }

  create(name: string, description?: string, voiceDesignPrompt?: string): TtsVoice {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO tts_voices (id, name, description, voice_design_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, name.trim(), description?.trim() ?? null, voiceDesignPrompt?.trim() ?? null, now, now)
    return this.findById(id)!
  }

  update(id: string, name?: string, description?: string, voiceDesignPrompt?: string): TtsVoice | null {
    const now = Date.now()
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now]
    if (name !== undefined) { sets.push('name = ?'); params.push(name.trim()) }
    if (description !== undefined) { sets.push('description = ?'); params.push(description.trim() || null) }
    if (voiceDesignPrompt !== undefined) { sets.push('voice_design_prompt = ?'); params.push(voiceDesignPrompt.trim() || null) }
    params.push(id)
    this.db.prepare(`UPDATE tts_voices SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.findById(id)
  }

  delete(id: string): void {
    // Samples are cascade-deleted via FK
    this.db.prepare(`DELETE FROM tts_voices WHERE id = ?`).run(id)
  }

  // ─── Samples ─────────────────────────────────────────────────────────────

  findSamplesByVoiceId(voiceId: string): TtsVoiceSample[] {
    const rows = this.db
      .prepare<[string], TtsVoiceSampleRow>(
        `SELECT id, voice_id, audio_path, transcript, duration_sec,
                source_recording_id, created_at
         FROM tts_voice_samples
         WHERE voice_id = ?
         ORDER BY created_at ASC`
      )
      .all(voiceId)
    return rows.map(rowToSample)
  }

  findSampleById(id: string): TtsVoiceSample | null {
    const row = this.db
      .prepare<[string], TtsVoiceSampleRow>(
        `SELECT id, voice_id, audio_path, transcript, duration_sec,
                source_recording_id, created_at
         FROM tts_voice_samples WHERE id = ?`
      )
      .get(id)
    return row ? rowToSample(row) : null
  }

  /** Returns the most recently added sample for a given voice (used as default reference). */
  findLatestSample(voiceId: string): TtsVoiceSample | null {
    const row = this.db
      .prepare<[string], TtsVoiceSampleRow>(
        `SELECT id, voice_id, audio_path, transcript, duration_sec,
                source_recording_id, created_at
         FROM tts_voice_samples
         WHERE voice_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(voiceId)
    return row ? rowToSample(row) : null
  }

  addSample(
    voiceId: string,
    audioPath: string,
    opts: {
      transcript?: string
      durationSec?: number
      sourceRecordingId?: string
    } = {}
  ): TtsVoiceSample {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO tts_voice_samples
           (id, voice_id, audio_path, transcript, duration_sec, source_recording_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        voiceId,
        audioPath,
        opts.transcript ?? null,
        opts.durationSec ?? null,
        opts.sourceRecordingId ?? null,
        now
      )
    // Bump the voice updated_at so callers see freshness
    this.db
      .prepare(`UPDATE tts_voices SET updated_at = ? WHERE id = ?`)
      .run(now, voiceId)
    return this.findSampleById(id)!
  }

  deleteSample(sampleId: string): void {
    const sample = this.findSampleById(sampleId)
    if (!sample) return
    this.db.prepare(`DELETE FROM tts_voice_samples WHERE id = ?`).run(sampleId)
    this.db
      .prepare(`UPDATE tts_voices SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), sample.voiceId)
  }
}
