import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Recording, RecordingStatus } from '@shared/types'

interface RecordingRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  duration: number | null
  audio_path: string | null
  status: string
  summary: string | null
  summary_model: string | null
  summary_at: number | null
  debrief: string | null
  debrief_at: number | null
  notes: string | null
  tags: string
  template_id: string | null
}

function rowToRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    duration: row.duration,
    audioPath: row.audio_path,
    status: row.status as RecordingStatus,
    summary: row.summary,
    summaryModel: row.summary_model,
    summaryAt: row.summary_at,
    debrief: row.debrief,
    debriefAt: row.debrief_at,
    notes: row.notes,
    tags: JSON.parse(row.tags) as string[],
    templateId: row.template_id
  }
}

export class RecordingRepository {
  constructor(private readonly db: Database.Database) {}

  create(title: string): Recording {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO recordings (id, title, created_at, updated_at, status, tags)
         VALUES (?, ?, ?, ?, 'recording', '[]')`
      )
      .run(id, title, now, now)
    return this.findById(id)!
  }

  findById(id: string): Recording | null {
    const row = this.db
      .prepare<string, RecordingRow>(`SELECT * FROM recordings WHERE id = ?`)
      .get(id)
    return row ? rowToRecording(row) : null
  }

  findAll(): Recording[] {
    const rows = this.db
      .prepare<[], RecordingRow>(`SELECT * FROM recordings ORDER BY created_at DESC`)
      .all()
    return rows.map(rowToRecording)
  }

  update(
    id: string,
    fields: Partial<Pick<Recording, 'title' | 'notes' | 'tags' | 'status' | 'duration' | 'audioPath' | 'summary' | 'summaryModel' | 'summaryAt' | 'debrief' | 'debriefAt' | 'templateId'>>
  ): Recording | null {
    const updates: string[] = []
    const values: unknown[] = []

    if (fields.title !== undefined) { updates.push('title = ?'); values.push(fields.title) }
    if (fields.notes !== undefined) { updates.push('notes = ?'); values.push(fields.notes) }
    if (fields.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(fields.tags)) }
    if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status) }
    if (fields.duration !== undefined) { updates.push('duration = ?'); values.push(fields.duration) }
    if (fields.audioPath !== undefined) { updates.push('audio_path = ?'); values.push(fields.audioPath) }
    if (fields.summary !== undefined) { updates.push('summary = ?'); values.push(fields.summary) }
    if (fields.summaryModel !== undefined) { updates.push('summary_model = ?'); values.push(fields.summaryModel) }
    if (fields.summaryAt !== undefined) { updates.push('summary_at = ?'); values.push(fields.summaryAt) }
    if (fields.debrief !== undefined) { updates.push('debrief = ?'); values.push(fields.debrief) }
    if (fields.debriefAt !== undefined) { updates.push('debrief_at = ?'); values.push(fields.debriefAt) }
    if ('templateId' in fields) { updates.push('template_id = ?'); values.push(fields.templateId ?? null) }

    if (updates.length === 0) return this.findById(id)

    updates.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)

    this.db.prepare(`UPDATE recordings SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    return this.findById(id)
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM recordings WHERE id = ?`).run(id)
  }

  count(): number {
    const row = this.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) as c FROM recordings`)
      .get()
    return row?.c ?? 0
  }
}
