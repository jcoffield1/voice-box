import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'

let _db: Database.Database | null = null

export function getDbPath(): string {
  const userData = app.getPath('userData')
  return join(userData, 'callTranscriber.db')
}

export function getDatabase(): Database.Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return _db
}

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? getDbPath()

  // Ensure directory exists
  const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })

  const db = new Database(resolvedPath)

  // Load sqlite-vec extension for vector similarity search.
  // require.resolve() returns a path inside app.asar which dlopen() cannot
  // open (asar is a single-file archive). For packaged builds we remap to the
  // real filesystem copy in app.asar.unpacked, which electron-builder places
  // there because we listed "**/sqlite-vec-*/**" in asarUnpack.
  const rawVecPath = sqliteVec.getLoadablePath()
  const vecPath = app.isPackaged
    ? rawVecPath.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    : rawVecPath
  db.loadExtension(vecPath)

  // Performance settings
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('cache_size = -64000') // 64 MB cache

  runMigrations(db)

  _db = db
  return db
}

export function closeDatabase(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ─── Migrations ───────────────────────────────────────────────────────────────

interface Migration {
  version: number
  name: string
  up: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_schema_version',
    up: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version    INTEGER NOT NULL,
        name       TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'create_recordings',
    up: `
      CREATE TABLE IF NOT EXISTS recordings (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        duration      INTEGER,
        audio_path    TEXT,
        status        TEXT NOT NULL DEFAULT 'recording',
        summary       TEXT,
        summary_model TEXT,
        summary_at    INTEGER,
        notes         TEXT,
        tags          TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC);
    `
  },
  {
    version: 3,
    name: 'create_speaker_profiles',
    up: `
      CREATE TABLE IF NOT EXISTS speaker_profiles (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        voice_embedding      BLOB,
        embedding_dim        INTEGER DEFAULT 256,
        confidence_threshold REAL DEFAULT 0.75,
        recording_count      INTEGER DEFAULT 0,
        created_at           INTEGER NOT NULL,
        last_seen_at         INTEGER,
        notes                TEXT,
        is_owner             INTEGER DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_name ON speaker_profiles(name);
    `
  },
  {
    version: 4,
    name: 'create_transcript_segments',
    up: `
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id                  TEXT PRIMARY KEY,
        recording_id        TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        text                TEXT NOT NULL,
        speaker_id          TEXT REFERENCES speaker_profiles(id) ON DELETE SET NULL,
        speaker_name        TEXT,
        speaker_confidence  REAL,
        timestamp_start     REAL NOT NULL,
        timestamp_end       REAL NOT NULL,
        whisper_confidence  REAL,
        is_edited           INTEGER DEFAULT 0,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_recording
        ON transcript_segments(recording_id);
      CREATE INDEX IF NOT EXISTS idx_segments_speaker
        ON transcript_segments(speaker_name);
      CREATE INDEX IF NOT EXISTS idx_segments_timestamp
        ON transcript_segments(recording_id, timestamp_start);
    `
  },
  {
    version: 5,
    name: 'create_transcript_fts',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        text,
        speaker_name,
        content='transcript_segments',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS segments_ai
        AFTER INSERT ON transcript_segments BEGIN
          INSERT INTO transcript_fts(rowid, text, speaker_name)
          VALUES (new.rowid, new.text, new.speaker_name);
        END;

      CREATE TRIGGER IF NOT EXISTS segments_au
        AFTER UPDATE ON transcript_segments BEGIN
          INSERT INTO transcript_fts(transcript_fts, rowid, text, speaker_name)
          VALUES ('delete', old.rowid, old.text, old.speaker_name);
          INSERT INTO transcript_fts(rowid, text, speaker_name)
          VALUES (new.rowid, new.text, new.speaker_name);
        END;

      CREATE TRIGGER IF NOT EXISTS segments_ad
        AFTER DELETE ON transcript_segments BEGIN
          INSERT INTO transcript_fts(transcript_fts, rowid, text, speaker_name)
          VALUES ('delete', old.rowid, old.text, old.speaker_name);
        END;
    `
  },
  {
    version: 6,
    name: 'create_transcript_embeddings',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_embeddings USING vec0(
        segment_id TEXT PRIMARY KEY,
        embedding  FLOAT[768]
      );

      CREATE TABLE IF NOT EXISTS embedding_metadata (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id   TEXT NOT NULL,
        provider   TEXT NOT NULL,
        dimension  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        is_active  INTEGER DEFAULT 1
      );
    `
  },
  {
    version: 7,
    name: 'create_conversation_tables',
    up: `
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id           TEXT PRIMARY KEY,
        recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
        title        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        input_mode TEXT DEFAULT 'text',
        provider   TEXT,
        model      TEXT,
        tokens_used INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON conversation_messages(session_id, created_at);
    `
  },
  {
    version: 8,
    name: 'create_search_history',
    up: `
      CREATE TABLE IF NOT EXISTS search_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        query        TEXT NOT NULL,
        result_count INTEGER,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_search_created
        ON search_history(created_at DESC);
    `
  },
  {
    version: 9,
    name: 'create_app_settings',
    up: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Default settings
      INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES
        ('llm.summarization.provider',  '"ollama"',          ${Date.now()}),
        ('llm.summarization.model',     '"llama3.2:8b"',     ${Date.now()}),
        ('llm.conversation.provider',   '"ollama"',          ${Date.now()}),
        ('llm.conversation.model',      '"llama3.2:8b"',     ${Date.now()}),
        ('llm.embeddings.provider',     '"ollama"',          ${Date.now()}),
        ('llm.embeddings.model',        '"nomic-embed-text"',${Date.now()}),
        ('llm.intent.provider',         '"ollama"',          ${Date.now()}),
        ('llm.intent.model',            '"llama3.2:3b"',     ${Date.now()}),
        ('ui.voiceOutputEnabled',       'false',             ${Date.now()}),
        ('ui.autoSummarize',            'false',             ${Date.now()}),
        ('ui.theme',                    '"dark"',            ${Date.now()}),
        ('audio.inputDevice',           '"default"',         ${Date.now()}),
        ('audio.systemAudioEnabled',    'false',            ${Date.now()});
    `
  },
  {
    version: 10,
    name: 'add_debrief_to_recordings',
    up: `
      ALTER TABLE recordings ADD COLUMN debrief TEXT;
      ALTER TABLE recordings ADD COLUMN debrief_at INTEGER;
    `
  }
]

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists before anything else
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const getCurrentVersion = db.prepare<[], { v: number | null }>(
    `SELECT MAX(version) as v FROM schema_version`
  )
  const row = getCurrentVersion.get()
  const currentVersion = row?.v ?? 0

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion)

  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      db.exec(migration.up)
      db.prepare(`INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)`).run(
        migration.version,
        migration.name,
        Date.now()
      )
    })
    applyMigration()
  }
}
