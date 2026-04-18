/**
 * template.ipc.ts handler tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import * as fsModule from 'fs'

// Mock fs so tests never touch the real filesystem
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => '{}'),
      writeFile: vi.fn(async () => undefined)
    }
  }
})
import { IPC } from '@shared/ipc-types'
import { registerTemplateIpc } from '@main/ipc/template.ipc'
import type { IpcMainInvokeEvent } from 'electron'
import type { SummaryTemplate } from '@shared/types'

const evt = {} as IpcMainInvokeEvent

// ─── Helpers ─────────────────────────────────────────────────────────────────

function captureHandlers() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers[channel as string] = handler as (...args: unknown[]) => unknown
    return ipcMain
  })
  return handlers
}

function makeTemplate(overrides: Partial<SummaryTemplate> = {}): SummaryTemplate {
  return {
    id: 'tpl-1',
    name: 'Sales Call',
    systemPrompt: 'You are a sales analyst.',
    userPromptTemplate: 'Summarize "{{title}}":\n\n{{transcript}}',
    isDefault: false,
    createdAt: 1_000_000,
    updatedAt: 1_001_000,
    ...overrides
  }
}

function makeDeps() {
  const templateRepo = {
    findAll: vi.fn(() => [makeTemplate()]),
    findById: vi.fn((id: string) => (id === 'tpl-1' ? makeTemplate() : null)),
    findDefault: vi.fn(() => makeTemplate({ id: 'built-in-default', isDefault: true })),
    create: vi.fn((fields: Pick<SummaryTemplate, 'name' | 'systemPrompt' | 'userPromptTemplate'>) =>
      makeTemplate({ ...fields })
    ),
    update: vi.fn((id: string, fields: Partial<SummaryTemplate>) => makeTemplate({ id, ...fields })),
    delete: vi.fn()
  }
  return { templateRepo }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('registerTemplateIpc', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset()
    deps = makeDeps()
    handlers = captureHandlers()
    registerTemplateIpc(deps)
  })

  // ── getAll ────────────────────────────────────────────────────────────────

  it('getAll returns all templates', async () => {
    const result = await handlers[IPC.template.getAll](evt)
    expect(deps.templateRepo.findAll).toHaveBeenCalled()
    expect(result).toEqual({ templates: [makeTemplate()] })
  })

  // ── get ───────────────────────────────────────────────────────────────────

  it('get returns a template by id', async () => {
    const result = await handlers[IPC.template.get](evt, { templateId: 'tpl-1' })
    expect(deps.templateRepo.findById).toHaveBeenCalledWith('tpl-1')
    expect((result as { template: SummaryTemplate }).template.id).toBe('tpl-1')
  })

  it('get returns null for unknown id', async () => {
    const result = await handlers[IPC.template.get](evt, { templateId: 'nope' })
    expect((result as { template: null }).template).toBeNull()
  })

  // ── create ────────────────────────────────────────────────────────────────

  it('create stores and returns new template', async () => {
    const args = {
      name: 'Investor Update',
      systemPrompt: 'You are an investor relations analyst.',
      userPromptTemplate: 'Summarize "{{title}}":\n\n{{transcript}}'
    }
    const result = await handlers[IPC.template.create](evt, args)
    expect(deps.templateRepo.create).toHaveBeenCalledWith(args)
    expect((result as { template: SummaryTemplate }).template.name).toBe('Investor Update')
  })

  // ── clone ─────────────────────────────────────────────────────────────────

  it('clone creates a copy prefixed with "Copy of"', async () => {
    const result = await handlers[IPC.template.clone](evt, { templateId: 'tpl-1' })
    expect(deps.templateRepo.findById).toHaveBeenCalledWith('tpl-1')
    expect(deps.templateRepo.create).toHaveBeenCalledWith({
      name: 'Copy of Sales Call',
      systemPrompt: 'You are a sales analyst.',
      userPromptTemplate: 'Summarize "{{title}}":\n\n{{transcript}}'
    })
    expect((result as { template: SummaryTemplate }).template).toBeDefined()
  })

  it('clone throws when the source template is not found', async () => {
    await expect(
      handlers[IPC.template.clone](evt, { templateId: 'missing' })
    ).rejects.toThrow('Template not found: missing')
  })

  // ── update ────────────────────────────────────────────────────────────────

  it('update calls repo.update and returns updated template', async () => {
    const args = {
      templateId: 'tpl-1',
      name: 'Renamed',
      systemPrompt: 'Updated system prompt',
      userPromptTemplate: '{{title}}\n{{transcript}}'
    }
    const result = await handlers[IPC.template.update](evt, args)
    expect(deps.templateRepo.update).toHaveBeenCalledWith('tpl-1', {
      name: 'Renamed',
      systemPrompt: 'Updated system prompt',
      userPromptTemplate: '{{title}}\n{{transcript}}'
    })
    expect((result as { template: SummaryTemplate }).template.id).toBe('tpl-1')
  })

  // ── delete ────────────────────────────────────────────────────────────────

  it('delete calls repo.delete', async () => {
    await handlers[IPC.template.delete](evt, { templateId: 'tpl-1' })
    expect(deps.templateRepo.delete).toHaveBeenCalledWith('tpl-1')
  })

  it('delete propagates error if repo throws (e.g. cannot delete default)', async () => {
    deps.templateRepo.delete.mockImplementation(() => {
      throw new Error('Cannot delete the default template')
    })
    await expect(handlers[IPC.template.delete](evt, { templateId: 'built-in-default' })).rejects.toThrow(
      'Cannot delete the default template'
    )
  })

  // ── import ────────────────────────────────────────────────────────────────

  it('import cancels if dialog is cancelled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handlers[IPC.template.import](evt)).rejects.toThrow('Import cancelled')
  })

  it('import throws on invalid JSON', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/some/file.json'] })
    vi.mocked(fsModule.promises.readFile).mockResolvedValue('not json' as unknown as Buffer)
    await expect(handlers[IPC.template.import](evt)).rejects.toThrow('not valid JSON')
  })

  it('import throws when required fields are missing', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/some/file.json'] })
    vi.mocked(fsModule.promises.readFile).mockResolvedValue(
      JSON.stringify({ name: 'Missing prompts' }) as unknown as Buffer
    )
    await expect(handlers[IPC.template.import](evt)).rejects.toThrow('expected { name, systemPrompt, userPromptTemplate }')
  })

  it('import creates template from valid JSON', async () => {
    const payload = {
      name: 'Imported',
      systemPrompt: 'System text',
      userPromptTemplate: 'User {{title}} {{transcript}}'
    }
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/some/file.json'] })
    vi.mocked(fsModule.promises.readFile).mockResolvedValue(JSON.stringify(payload) as unknown as Buffer)
    const result = await handlers[IPC.template.import](evt)
    expect(deps.templateRepo.create).toHaveBeenCalledWith(payload)
    expect((result as { template: SummaryTemplate }).template).toBeDefined()
  })

  // ── export ────────────────────────────────────────────────────────────────

  it('export does nothing if dialog is cancelled', async () => {
    deps.templateRepo.findById.mockReturnValue(makeTemplate())
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: undefined })
    await expect(handlers[IPC.template.export](evt, { templateId: 'tpl-1' })).resolves.toBeUndefined()
    expect(fsModule.promises.writeFile).not.toHaveBeenCalled()
  })

  it('export throws when template is not found', async () => {
    deps.templateRepo.findById.mockReturnValue(null)
    await expect(handlers[IPC.template.export](evt, { templateId: 'unknown' })).rejects.toThrow(
      'Template not found'
    )
  })

  it('export writes JSON to chosen path', async () => {
    const tpl = makeTemplate()
    deps.templateRepo.findById.mockReturnValue(tpl)
    vi.mocked(app.getPath).mockReturnValue('/Users/test/Downloads')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: '/Users/test/Downloads/Sales Call.json'
    })
    vi.mocked(fsModule.promises.writeFile).mockResolvedValue()
    await handlers[IPC.template.export](evt, { templateId: 'tpl-1' })
    expect(fsModule.promises.writeFile).toHaveBeenCalledWith(
      '/Users/test/Downloads/Sales Call.json',
      expect.stringContaining('"name"'),
      'utf-8'
    )
  })

  // ── test ─────────────────────────────────────────────────────────────────

  it('test throws when LLM deps are missing', async () => {
    // Re-register without optional deps
    vi.mocked(ipcMain.handle).mockReset()
    const sparseHandlers = captureHandlers()
    registerTemplateIpc({ templateRepo: deps.templateRepo })
    await expect(
      sparseHandlers[IPC.template.test](evt, {
        systemPrompt: 'sys',
        userPromptTemplate: '{{title}}\n{{transcript}}',
        recordingId: 'rec-1',
        model: 'gpt-4o',
        provider: 'openai'
      })
    ).rejects.toThrow('missing service dependencies')
  })

  it('test throws when recording is not found', async () => {
    const recordingRepo = {
      findById: vi.fn(() => null)
    }
    const transcriptRepo = {
      findByRecordingId: vi.fn(() => [])
    }
    const llm = {
      complete: vi.fn()
    }
    vi.mocked(ipcMain.handle).mockReset()
    const fullHandlers = captureHandlers()
    registerTemplateIpc({
      templateRepo: deps.templateRepo,
      recordingRepo: recordingRepo as never,
      transcriptRepo: transcriptRepo as never,
      llm: llm as never
    })
    await expect(
      fullHandlers[IPC.template.test](evt, {
        systemPrompt: 'sys',
        userPromptTemplate: '{{title}}\n{{transcript}}',
        recordingId: 'missing',
        model: 'gpt-4o',
        provider: 'openai'
      })
    ).rejects.toThrow('Recording not found')
  })

  it('test substitutes placeholders and calls LLM', async () => {
    const recordingRepo = {
      findById: vi.fn(() => ({ id: 'rec-1', title: 'My Meeting' }))
    }
    const transcriptRepo = {
      findByRecordingId: vi.fn(() => [
        { timestampStart: 5, speakerName: 'Alice', text: 'Hello there' }
      ])
    }
    const llm = {
      complete: vi.fn(async () => ({ text: 'Great meeting!', model: 'gpt-4o', provider: 'openai' }))
    }
    vi.mocked(ipcMain.handle).mockReset()
    const fullHandlers = captureHandlers()
    registerTemplateIpc({
      templateRepo: deps.templateRepo,
      recordingRepo: recordingRepo as never,
      transcriptRepo: transcriptRepo as never,
      llm: llm as never
    })
    const result = await fullHandlers[IPC.template.test](evt, {
      systemPrompt: 'You are a helpful assistant.',
      userPromptTemplate: 'Summarize "{{title}}":\n\n{{transcript}}',
      recordingId: 'rec-1',
      model: 'gpt-4o',
      provider: 'openai'
    })
    expect(llm.complete).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        systemPrompt: 'You are a helpful assistant.',
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('My Meeting')
          })
        ]
      })
    )
    expect((result as { result: string }).result).toBe('Great meeting!')
  })
})
