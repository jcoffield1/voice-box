import type Database from 'better-sqlite3'

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db
      .prepare<string, { value: string }>(`SELECT value FROM app_settings WHERE key = ?`)
      .get(key)
    return row ? row.value : null
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, Date.now())
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value))
  }

  getAll(): Record<string, string> {
    const rows = this.db
      .prepare<[], { key: string; value: string }>(`SELECT key, value FROM app_settings`)
      .all()
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }
}
