import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { TranscriptSegment } from '@shared/types'

interface SegmentRow {
  id: string
  recording_id: string
  text: string
  speaker_id: string | null
  speaker_name: string | null
  speaker_confidence: number | null
  timestamp_start: number
  timestamp_end: number
  whisper_confidence: number | null
  is_edited: number
  created_at: number
}

function rowToSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    recordingId: row.recording_id,
    text: row.text,
    speakerId: row.speaker_id,
    speakerName: row.speaker_name,
    speakerConfidence: row.speaker_confidence,
    timestampStart: row.timestamp_start,
    timestampEnd: row.timestamp_end,
    whisperConfidence: row.whisper_confidence,
    isEdited: row.is_edited === 1,
    createdAt: row.created_at
  }
}

export interface CreateSegmentInput {
  recordingId: string
  text: string
  speakerId?: string | null
  speakerName?: string | null
  speakerConfidence?: number | null
  timestampStart: number
  timestampEnd: number
  whisperConfidence?: number | null
}

export class TranscriptRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSegmentInput): TranscriptSegment {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO transcript_segments
           (id, recording_id, text, speaker_id, speaker_name, speaker_confidence,
            timestamp_start, timestamp_end, whisper_confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.recordingId,
        input.text,
        input.speakerId ?? null,
        input.speakerName ?? null,
        input.speakerConfidence ?? null,
        input.timestampStart,
        input.timestampEnd,
        input.whisperConfidence ?? null,
        now
      )
    return this.findById(id)!
  }

  findById(id: string): TranscriptSegment | null {
    const row = this.db
      .prepare<string, SegmentRow>(`SELECT * FROM transcript_segments WHERE id = ?`)
      .get(id)
    return row ? rowToSegment(row) : null
  }

  findByRecordingId(recordingId: string): TranscriptSegment[] {
    const rows = this.db
      .prepare<string, SegmentRow>(
        `SELECT * FROM transcript_segments
         WHERE recording_id = ?
         ORDER BY timestamp_start ASC`
      )
      .all(recordingId)
    return rows.map(rowToSegment)
  }

  updateText(id: string, text: string): TranscriptSegment | null {
    this.db
      .prepare(`UPDATE transcript_segments SET text = ?, is_edited = 1 WHERE id = ?`)
      .run(text, id)
    return this.findById(id)
  }

  /** Retroactively assign a speaker name to all segments with a given speakerId in a recording */
  assignSpeakerToRecording(recordingId: string, speakerId: string, speakerName: string): number {
    const result = this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?
         WHERE recording_id = ? AND speaker_id = ?`
      )
      .run(speakerId, speakerName, recordingId, speakerId)
    return result.changes
  }

  /** Assign speaker to all segments with NULL speaker_id in a recording (no diarization case) */
  assignSpeakerToNullSegments(recordingId: string, profileId: string, speakerName: string): number {
    const result = this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?
         WHERE recording_id = ? AND speaker_id IS NULL`
      )
      .run(profileId, speakerName, recordingId)
    return result.changes
  }

  /** Update speaker info by raw speaker_id string (before profile exists) */
  assignSpeakerByRawId(recordingId: string, rawSpeakerId: string, profileId: string, speakerName: string): number {
    const result = this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?
         WHERE recording_id = ? AND speaker_id = ?`
      )
      .run(profileId, speakerName, recordingId, rawSpeakerId)
    return result.changes
  }

  saveEmbedding(segmentId: string, embedding: number[]): void {
    const floatArray = new Float32Array(embedding)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO transcript_embeddings (segment_id, embedding)
         VALUES (?, ?)`
      )
      .run(segmentId, Buffer.from(floatArray.buffer))
  }

  /** Return all segments (optionally filtered by recording) with their recording title for enrichment. */
  findAllWithContext(recordingId?: string): Array<TranscriptSegment & { recordingTitle: string }> {
    const sql = recordingId
      ? `SELECT ts.*, r.title as recording_title
         FROM transcript_segments ts
         JOIN recordings r ON r.id = ts.recording_id
         WHERE ts.recording_id = ?
         ORDER BY ts.recording_id, ts.timestamp_start ASC`
      : `SELECT ts.*, r.title as recording_title
         FROM transcript_segments ts
         JOIN recordings r ON r.id = ts.recording_id
         ORDER BY ts.recording_id, ts.timestamp_start ASC`

    type Row = SegmentRow & { recording_title: string }
    const rows = recordingId
      ? this.db.prepare<string, Row>(sql).all(recordingId)
      : this.db.prepare<[], Row>(sql).all()

    return rows.map((row) => ({
      ...rowToSegment(row),
      recordingTitle: row.recording_title
    }))
  }

  deleteByRecordingId(recordingId: string): void {
    this.db
      .prepare(`DELETE FROM transcript_segments WHERE recording_id = ?`)
      .run(recordingId)
  }

  countByRecordingId(recordingId: string): number {
    const row = this.db
      .prepare<string, { c: number }>(
        `SELECT COUNT(*) as c FROM transcript_segments WHERE recording_id = ?`
      )
      .get(recordingId)
    return row?.c ?? 0
  }
}
