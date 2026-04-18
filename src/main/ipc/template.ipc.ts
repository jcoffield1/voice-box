import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc-types'
import type {
  GetTemplatesResult,
  GetTemplateArgs,
  GetTemplateResult,
  CreateTemplateArgs,
  CreateTemplateResult,
  CloneTemplateArgs,
  CloneTemplateResult,
  UpdateTemplateArgs,
  UpdateTemplateResult,
  DeleteTemplateArgs,
  ImportTemplateResult,
  ExportTemplateArgs,
  TestTemplateArgs,
  TestTemplateResult
} from '@shared/ipc-types'
import type { SummaryTemplateRepository } from '../services/storage/repositories/SummaryTemplateRepository'
import type { RecordingRepository } from '../services/storage/repositories/RecordingRepository'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { LLMService } from '../services/llm/LLMService'
import type { TranscriptSegment } from '@shared/types'

function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const ts = `${Math.floor(s.timestampStart / 60)}:${String(Math.floor(s.timestampStart % 60)).padStart(2, '0')}`
      const speaker = s.speakerName ?? 'Unknown'
      return `[${ts}] ${speaker}: ${s.text}`
    })
    .join('\n')
}

interface TemplateIpcDeps {
  templateRepo: SummaryTemplateRepository
  recordingRepo?: RecordingRepository
  transcriptRepo?: TranscriptRepository
  llm?: LLMService
}

export function registerTemplateIpc(deps: TemplateIpcDeps): void {
  const { templateRepo, recordingRepo, transcriptRepo, llm } = deps

  ipcMain.handle(IPC.template.getAll, async (): Promise<GetTemplatesResult> => {
    return { templates: templateRepo.findAll() }
  })

  ipcMain.handle(IPC.template.get, async (_event, args: GetTemplateArgs): Promise<GetTemplateResult> => {
    return { template: templateRepo.findById(args.templateId) }
  })

  ipcMain.handle(IPC.template.create, async (_event, args: CreateTemplateArgs): Promise<CreateTemplateResult> => {
    const template = templateRepo.create({
      name: args.name,
      systemPrompt: args.systemPrompt,
      userPromptTemplate: args.userPromptTemplate
    })
    return { template }
  })

  ipcMain.handle(IPC.template.clone, async (_event, args: CloneTemplateArgs): Promise<CloneTemplateResult> => {
    const source = templateRepo.findById(args.templateId)
    if (!source) throw new Error(`Template not found: ${args.templateId}`)
    const template = templateRepo.create({
      name: `Copy of ${source.name}`,
      systemPrompt: source.systemPrompt,
      userPromptTemplate: source.userPromptTemplate
    })
    return { template }
  })

  ipcMain.handle(IPC.template.update, async (_event, args: UpdateTemplateArgs): Promise<UpdateTemplateResult> => {
    const template = templateRepo.update(args.templateId, {
      name: args.name,
      systemPrompt: args.systemPrompt,
      userPromptTemplate: args.userPromptTemplate
    })
    return { template }
  })

  ipcMain.handle(IPC.template.delete, async (_event, args: DeleteTemplateArgs): Promise<void> => {
    templateRepo.delete(args.templateId)
  })

  // ─── Import from JSON file ────────────────────────────────────────────────

  ipcMain.handle(IPC.template.import, async (_event): Promise<ImportTemplateResult> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Summary Template',
      properties: ['openFile'],
      filters: [{ name: 'JSON Template', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('Import cancelled')
    }

    const raw = await fs.readFile(result.filePaths[0], 'utf-8')

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Invalid template file: not valid JSON')
    }

    const p = parsed as Record<string, unknown>
    if (
      typeof p['name'] !== 'string' ||
      typeof p['systemPrompt'] !== 'string' ||
      typeof p['userPromptTemplate'] !== 'string'
    ) {
      throw new Error(
        'Invalid template file: expected { name, systemPrompt, userPromptTemplate } string fields'
      )
    }

    const template = templateRepo.create({
      name: p['name'] as string,
      systemPrompt: p['systemPrompt'] as string,
      userPromptTemplate: p['userPromptTemplate'] as string
    })
    return { template }
  })

  // ─── Export to JSON file ──────────────────────────────────────────────────

  ipcMain.handle(IPC.template.export, async (_event, args: ExportTemplateArgs): Promise<void> => {
    const template = templateRepo.findById(args.templateId)
    if (!template) throw new Error(`Template not found: ${args.templateId}`)

    const win = BrowserWindow.getFocusedWindow()
    const safeFilename = template.name.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim() || 'template'
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Summary Template',
      defaultPath: join(app.getPath('downloads'), `${safeFilename}.json`),
      filters: [{ name: 'JSON Template', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return

    await fs.writeFile(
      result.filePath,
      JSON.stringify(
        {
          name: template.name,
          systemPrompt: template.systemPrompt,
          userPromptTemplate: template.userPromptTemplate
        },
        null,
        2
      ),
      'utf-8'
    )
  })

  // ─── Test template against a real recording ──────────────────────────────

  ipcMain.handle(IPC.template.test, async (_event, args: TestTemplateArgs): Promise<TestTemplateResult> => {
    if (!llm || !recordingRepo || !transcriptRepo) {
      throw new Error('Template test is not available (missing service dependencies)')
    }

    const recording = recordingRepo.findById(args.recordingId)
    if (!recording) throw new Error(`Recording not found: ${args.recordingId}`)

    const segments = transcriptRepo.findByRecordingId(args.recordingId)
    const transcriptText = formatTranscript(segments)

    const userMessage = args.userPromptTemplate
      .replace(/\{\{title\}\}/g, recording.title)
      .replace(/\{\{transcript\}\}/g, transcriptText)

    const response = await llm.complete(args.provider, {
      systemPrompt: args.systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      model: args.model || undefined
    })

    return { result: response.text, model: response.model, provider: response.provider }
  })
}
