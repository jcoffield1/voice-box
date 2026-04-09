import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { ConversationThread, ConversationMessage } from '@shared/types'

interface SessionRow {
  id: string
  recording_id: string | null
  title: string | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  input_mode: string
  provider: string | null
  model: string | null
  tokens_used: number | null
  created_at: number
}

function rowToThread(row: SessionRow): ConversationThread {
  return {
    id: row.id,
    recordingId: row.recording_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title
  }
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    threadId: row.session_id,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    createdAt: row.created_at,
    model: row.model,
    provider: row.provider
  }
}

export class ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  createThread(recordingId: string | null, title?: string): ConversationThread {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO conversation_sessions (id, recording_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, recordingId, title ?? null, now, now)
    return this.findThreadById(id)!
  }

  findThreadById(id: string): ConversationThread | null {
    const row = this.db
      .prepare<string, SessionRow>(`SELECT * FROM conversation_sessions WHERE id = ?`)
      .get(id)
    return row ? rowToThread(row) : null
  }

  findThreadsByRecording(recordingId: string): ConversationThread[] {
    const rows = this.db
      .prepare<string, SessionRow>(
        `SELECT * FROM conversation_sessions
         WHERE recording_id = ? ORDER BY updated_at DESC`
      )
      .all(recordingId)
    return rows.map(rowToThread)
  }

  findAllThreads(limit = 50): ConversationThread[] {
    const rows = this.db
      .prepare<[number], SessionRow>(
        `SELECT * FROM conversation_sessions ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit)
    return rows.map(rowToThread)
  }

  updateTitle(id: string, title: string): void {
    this.db
      .prepare(`UPDATE conversation_sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), id)
  }

  addMessage(
    threadId: string,
    role: 'user' | 'assistant',
    content: string,
    options?: { provider?: string; model?: string; tokensUsed?: number; inputMode?: string }
  ): ConversationMessage {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO conversation_messages
           (id, session_id, role, content, input_mode, provider, model, tokens_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        threadId,
        role,
        content,
        options?.inputMode ?? 'text',
        options?.provider ?? null,
        options?.model ?? null,
        options?.tokensUsed ?? null,
        now
      )
    this.db
      .prepare(`UPDATE conversation_sessions SET updated_at = ? WHERE id = ?`)
      .run(now, threadId)
    return this.findMessageById(id)!
  }

  findMessageById(id: string): ConversationMessage | null {
    const row = this.db
      .prepare<string, MessageRow>(`SELECT * FROM conversation_messages WHERE id = ?`)
      .get(id)
    return row ? rowToMessage(row) : null
  }

  findMessagesByThread(threadId: string): ConversationMessage[] {
    const rows = this.db
      .prepare<string, MessageRow>(
        `SELECT * FROM conversation_messages
         WHERE session_id = ? ORDER BY created_at ASC`
      )
      .all(threadId)
    return rows.map(rowToMessage)
  }

  deleteThread(id: string): void {
    this.db.prepare(`DELETE FROM conversation_sessions WHERE id = ?`).run(id)
  }
}
