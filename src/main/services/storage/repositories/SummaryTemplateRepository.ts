import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { SummaryTemplate } from '@shared/types'

interface SummaryTemplateRow {
  id: string
  name: string
  system_prompt: string
  user_prompt_template: string
  is_default: number
  created_at: number
  updated_at: number
}

function rowToTemplate(row: SummaryTemplateRow): SummaryTemplate {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    userPromptTemplate: row.user_prompt_template,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class SummaryTemplateRepository {
  constructor(private readonly db: Database.Database) {}

  findAll(): SummaryTemplate[] {
    const rows = this.db
      .prepare<[], SummaryTemplateRow>(
        `SELECT * FROM summary_templates ORDER BY is_default DESC, created_at ASC`
      )
      .all()
    return rows.map(rowToTemplate)
  }

  findById(id: string): SummaryTemplate | null {
    const row = this.db
      .prepare<string, SummaryTemplateRow>(`SELECT * FROM summary_templates WHERE id = ?`)
      .get(id)
    return row ? rowToTemplate(row) : null
  }

  findDefault(): SummaryTemplate | null {
    const row = this.db
      .prepare<[], SummaryTemplateRow>(
        `SELECT * FROM summary_templates WHERE is_default = 1 LIMIT 1`
      )
      .get()
    return row ? rowToTemplate(row) : null
  }

  create(fields: {
    name: string
    systemPrompt: string
    userPromptTemplate: string
  }): SummaryTemplate {
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO summary_templates
           (id, name, system_prompt, user_prompt_template, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, fields.name, fields.systemPrompt, fields.userPromptTemplate, now, now)
    return this.findById(id)!
  }

  update(
    id: string,
    fields: Partial<{ name: string; systemPrompt: string; userPromptTemplate: string }>
  ): SummaryTemplate | null {
    const updates: string[] = []
    const values: unknown[] = []

    if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name) }
    if (fields.systemPrompt !== undefined) { updates.push('system_prompt = ?'); values.push(fields.systemPrompt) }
    if (fields.userPromptTemplate !== undefined) { updates.push('user_prompt_template = ?'); values.push(fields.userPromptTemplate) }

    if (updates.length === 0) return this.findById(id)

    updates.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)

    this.db
      .prepare(`UPDATE summary_templates SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values)
    return this.findById(id)
  }

  delete(id: string): void {
    const tpl = this.findById(id)
    if (!tpl) return
    if (tpl.isDefault) throw new Error('Cannot delete the built-in default template')
    this.db.prepare(`DELETE FROM summary_templates WHERE id = ?`).run(id)
    // Null out recordings that were using this template so they fall back to the default
    this.db
      .prepare(`UPDATE recordings SET template_id = NULL WHERE template_id = ?`)
      .run(id)
  }
}
