import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'

describe('Database', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  afterEach(() => {
    closeDatabase()
  })

  it('initialises and returns a database instance', () => {
    const db = getDatabase()
    expect(db).toBeDefined()
    expect(db.open).toBe(true)
  })

  it('runs all migrations successfully', () => {
    const db = getDatabase()
    const version = db
      .prepare<[], { version: number }>('SELECT MAX(version) as version FROM schema_version')
      .get()
    expect(version).toBeDefined()
    expect(typeof version!.version).toBe('number')
    expect(version!.version).toBeGreaterThanOrEqual(7)
  })

  it('creates all expected tables', () => {
    const db = getDatabase()
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)

    expect(tables).toContain('recordings')
    expect(tables).toContain('transcript_segments')
    expect(tables).toContain('speaker_profiles')
    expect(tables).toContain('conversation_sessions')
    expect(tables).toContain('app_settings')
    expect(tables).toContain('schema_version')
  })

  it('enables foreign keys', () => {
    const db = getDatabase()
    const result = db.prepare<[], { foreign_keys: number }>('PRAGMA foreign_keys').get()
    expect(result?.foreign_keys).toBe(1)
  })

  it('is idempotent — running init twice does not throw', () => {
    expect(() => {
      closeDatabase()
      initDatabase(':memory:')
    }).not.toThrow()
  })

  it('throws if getDatabase called before init', () => {
    closeDatabase()
    expect(() => getDatabase()).toThrow('Database not initialized')
  })
})
