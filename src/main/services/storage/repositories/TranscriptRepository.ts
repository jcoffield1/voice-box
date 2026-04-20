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

  /** Update speaker on a single specific segment (manual/individual assignment). */
  updateSpeakerForSegment(segmentId: string, profileId: string, speakerName: string): void {
    this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?, speaker_confidence = NULL
         WHERE id = ?`
      )
      .run(profileId, speakerName, segmentId)
  }

  /** Return each distinct raw SPEAKER_XX label that still has no resolved profile in this recording.
   *  These are candidates for cross-cluster voice matching after a manual assignment. */
  findUnresolvedSpeakerClusters(recordingId: string): Array<{ rawLabel: string; segments: Array<{ id: string; timestampStart: number; timestampEnd: number }> }> {
    type Row = { speaker_id: string; id: string; timestamp_start: number; timestamp_end: number }
    type AllRow = { speaker_id: string | null; id: string; timestamp_start: number; timestamp_end: number }
    const rawRows = (this.db
      .prepare<string, AllRow>(
        `SELECT id, speaker_id, timestamp_start, timestamp_end
         FROM transcript_segments
         WHERE recording_id = ?
         ORDER BY timestamp_start ASC`
      )
      .all(recordingId) as AllRow[])
      .filter((r): r is Row => r.speaker_id != null && /^SPEAKER_\d+$/.test(r.speaker_id))

    const groups = new Map<string, Array<{ id: string; timestampStart: number; timestampEnd: number }>>()
    for (const row of rawRows) {
      const list = groups.get(row.speaker_id) ?? []
      list.push({ id: row.id, timestampStart: row.timestamp_start, timestampEnd: row.timestamp_end })
      groups.set(row.speaker_id, list)
    }

    return Array.from(groups.entries()).map(([rawLabel, segments]) => ({ rawLabel, segments }))
  }

  /** Return the time ranges for all segments of a given speaker profile in a recording. */
  findTimeRangesForProfile(recordingId: string, profileId: string): Array<{ start: number; end: number }> {
    type Row = { timestamp_start: number; timestamp_end: number }
    return this.db
      .prepare<[string, string], Row>(
        // Same trust filter as findManuallyConfirmedSpeakers: exclude borderline
        // auto-assignments so they don't contaminate the voice embedding.
        `SELECT timestamp_start, timestamp_end
         FROM transcript_segments
         WHERE recording_id = ? AND speaker_id = ?
           AND (speaker_confidence IS NULL OR speaker_confidence >= 0.85)
         ORDER BY timestamp_start ASC`
      )
      .all(recordingId, profileId)
      .map((r) => ({ start: r.timestamp_start, end: r.timestamp_end }))
  }

  /**
   * Return segments that were auto-assigned with borderline confidence (between
   * the live-ID threshold and the high-confidence cutoff).  After post-recording
   * learnSpeaker updates embeddings these segments should be re-identified against
   * the improved profiles using the full audio file.
   */
  findBorderlineAssignedSegments(
    recordingId: string,
    minConfidence: number,
    maxConfidence: number
  ): Array<{ id: string; timestampStart: number; timestampEnd: number }> {
    type Row = { id: string; timestamp_start: number; timestamp_end: number }
    return (this.db
      .prepare<[string, number, number], Row>(
        `SELECT id, timestamp_start, timestamp_end
         FROM transcript_segments
         WHERE recording_id = ?
           AND speaker_confidence >= ? AND speaker_confidence < ?
           AND speaker_id IS NOT NULL
           AND speaker_id NOT LIKE 'SPEAKER_%'
         ORDER BY timestamp_start ASC`
      )
      .all(recordingId, minConfidence, maxConfidence) as Row[])
      .map((r) => ({ id: r.id, timestampStart: r.timestamp_start, timestampEnd: r.timestamp_end }))
  }

  /** Return all segments with no speaker assigned (speaker_id IS NULL). */
  findNullSpeakerSegments(recordingId: string): Array<{ id: string; timestampStart: number; timestampEnd: number }> {
    type Row = { id: string; timestamp_start: number; timestamp_end: number }
    return (this.db
      .prepare<string, Row>(
        `SELECT id, timestamp_start, timestamp_end
         FROM transcript_segments
         WHERE recording_id = ? AND speaker_id IS NULL
         ORDER BY timestamp_start ASC`
      )
      .all(recordingId) as Row[])
      .map((r) => ({ id: r.id, timestampStart: r.timestamp_start, timestampEnd: r.timestamp_end }))
  }

  /**
   * Return speakers that were manually confirmed during live recording (non-SPEAKER_XX, non-null
   * speaker_id), grouped by profileId with their time ranges.  Used after recording stops to
   * learn voice embeddings that couldn't be created while the audio file was still open.
   */
  findManuallyConfirmedSpeakers(
    recordingId: string
  ): Array<{ speakerId: string; timeRanges: Array<{ start: number; end: number }> }> {
    type Row = { speaker_id: string; timestamp_start: number; timestamp_end: number }
    const rows = this.db
      .prepare<string, Row>(
        // Only feed trustworthy segments into learnSpeaker:
        //   - speaker_confidence IS NULL  → user manually confirmed (most trusted)
        //   - speaker_confidence >= 0.85  → high-confidence auto-assignment
        // Excluding low-confidence auto-assignments (0.75–0.84) prevents a
        // contamination loop where a misidentified segment corrupts the stored
        // embedding, making future misidentifications more likely.
        `SELECT speaker_id, timestamp_start, timestamp_end
         FROM transcript_segments
         WHERE recording_id = ?
           AND speaker_id IS NOT NULL
           AND speaker_id NOT LIKE 'SPEAKER_%'
           AND (speaker_confidence IS NULL OR speaker_confidence >= 0.85)
         ORDER BY timestamp_start ASC`
      )
      .all(recordingId) as Row[]

    const map = new Map<string, Array<{ start: number; end: number }>>()
    for (const row of rows) {
      const ranges = map.get(row.speaker_id) ?? []
      ranges.push({ start: row.timestamp_start, end: row.timestamp_end })
      map.set(row.speaker_id, ranges)
    }
    return Array.from(map.entries()).map(([speakerId, timeRanges]) => ({ speakerId, timeRanges }))
  }

  /** Assign a speaker to a single segment with a confidence score. */
  assignSpeakerToSegmentWithConfidence(
    segmentId: string,
    profileId: string,
    speakerName: string,
    confidence: number
  ): void {
    this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?, speaker_confidence = ?
         WHERE id = ?`
      )
      .run(profileId, speakerName, confidence, segmentId)
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

  /** Update speaker info by raw speaker_id string (before profile exists).
   *  Clears speakerConfidence — this path is for manual/user-confirmed assignments. */
  assignSpeakerByRawId(recordingId: string, rawSpeakerId: string, profileId: string, speakerName: string): number {
    const result = this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?, speaker_confidence = NULL
         WHERE recording_id = ? AND speaker_id = ?`
      )
      .run(profileId, speakerName, recordingId, rawSpeakerId)
    return result.changes
  }

  /** Assign speaker with auto-identification confidence (used during post-recording pipeline). */
  assignSpeakerByRawIdWithConfidence(
    recordingId: string,
    rawSpeakerId: string,
    profileId: string,
    speakerName: string,
    confidence: number
  ): number {
    const result = this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?, speaker_confidence = ?
         WHERE recording_id = ? AND speaker_id = ?`
      )
      .run(profileId, speakerName, confidence, recordingId, rawSpeakerId)
    return result.changes
  }

  /** Set the raw diarization label (e.g. SPEAKER_00) on a single segment. */
  setRawSpeakerId(segmentId: string, rawSpeakerId: string): void {
    this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_id = ?, speaker_name = ?
         WHERE id = ?
           AND (speaker_id IS NULL OR speaker_id LIKE 'SPEAKER_%')`
      )
      .run(rawSpeakerId, rawSpeakerId, segmentId)
  }

  saveEmbedding(segmentId: string, embedding: number[]): void {
    const floatArray = new Float32Array(embedding)
    const buf = Buffer.from(floatArray.buffer)
    // vec0 virtual tables do not support INSERT OR REPLACE — delete then insert.
    this.db.prepare(`DELETE FROM transcript_embeddings WHERE segment_id = ?`).run(segmentId)
    this.db
      .prepare(`INSERT INTO transcript_embeddings (segment_id, embedding) VALUES (?, ?)`)
      .run(segmentId, buf)
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

  /**
   * Find all segments attributed to a named speaker profile across all recordings.
   * Returns only segments with a resolved (non-raw) speakerId, ordered by recording
   * then timestamp so callers can group them into contiguous clips.
   *
   * Joins recordings to provide the audio path needed for clipping.
   */
  findBySpeakerId(speakerId: string): Array<TranscriptSegment & { recordingAudioPath: string | null }> {
    type JoinRow = SegmentRow & { recording_audio_path: string | null }
    const rows = this.db
      .prepare<string, JoinRow>(
        `SELECT ts.*, r.audio_path AS recording_audio_path
         FROM transcript_segments ts
         JOIN recordings r ON r.id = ts.recording_id
         WHERE ts.speaker_id = ?
           AND ts.speaker_id NOT LIKE 'SPEAKER_%'
         ORDER BY ts.recording_id, ts.timestamp_start ASC`
      )
      .all(speakerId)
    return rows.map((row) => ({
      ...rowToSegment(row),
      recordingAudioPath: row.recording_audio_path,
    }))
  }
}
