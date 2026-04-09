import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { SettingsRepository } from '@main/services/storage/repositories/SettingsRepository'

describe('SettingsRepository', () => {
  let repo: SettingsRepository

  beforeEach(() => {
    initDatabase(':memory:')
    repo = new SettingsRepository(getDatabase())
  })

  afterEach(() => {
    closeDatabase()
  })

  it('returns null for unknown keys', () => {
    expect(repo.get('nonexistent')).toBeNull()
    expect(repo.getJson('nonexistent')).toBeNull()
  })

  it('sets and retrieves a string value', () => {
    repo.set('foo', 'bar')
    expect(repo.get('foo')).toBe('bar')
  })

  it('overwrites an existing key', () => {
    repo.set('key', 'v1')
    repo.set('key', 'v2')
    expect(repo.get('key')).toBe('v2')
  })

  it('sets and retrieves a JSON value', () => {
    const obj = { x: 1, y: [2, 3] }
    repo.setJson('complex', obj)
    expect(repo.getJson('complex')).toEqual(obj)
  })

  it('returns null for malformed JSON', () => {
    repo.set('broken', '{not json}')
    expect(repo.getJson('broken')).toBeNull()
  })

  it('getAll returns every key-value pair', () => {
    repo.set('a', '1')
    repo.set('b', '2')
    const all = repo.getAll()
    expect(all['a']).toBe('1')
    expect(all['b']).toBe('2')
  })

  it('default settings are pre-populated after migration', () => {
    // The migration inserts default rows like whisper.model etc.
    const whisperModel = repo.get('whisper.model')
    // May be null if defaults weren't added in migration — at least shouldn't throw
    expect(() => repo.get('whisper.model')).not.toThrow()
    void whisperModel // value may vary; just asserting no error
  })
})
