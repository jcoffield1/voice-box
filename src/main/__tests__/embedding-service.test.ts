import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmbeddingService } from '@main/services/llm/EmbeddingService'
import type { LLMService } from '@main/services/llm/LLMService'
import type { TranscriptRepository } from '@main/services/storage/repositories/TranscriptRepository'
import type { SettingsRepository } from '@main/services/storage/repositories/SettingsRepository'

const segContext = {
  recordingTitle: 'Test Call',
  speakerName: 'Alice',
  timestampStart: 5.0,
  createdAt: Date.now()
}

describe('EmbeddingService', () => {
  let mockLLM: LLMService
  let mockTranscriptRepo: TranscriptRepository
  let mockSettings: SettingsRepository
  let svc: EmbeddingService

  beforeEach(() => {
    mockLLM = {
      embed: vi.fn(async (texts: string[]) =>
        texts.map(() => Array.from({ length: 768 }, (_, i) => i * 0.001))
      )
    } as unknown as LLMService

    mockTranscriptRepo = {
      saveEmbedding: vi.fn()
    } as unknown as TranscriptRepository

    mockSettings = {
      get: vi.fn(),
      getJson: vi.fn()
    } as unknown as SettingsRepository

    svc = new EmbeddingService(mockLLM, mockTranscriptRepo, mockSettings)
  })

  it('queues and processes an embedding job', async () => {
    svc.enqueue('seg-1', 'We closed the deal.', segContext)
    // Give the async processQueue a tick to complete
    await new Promise((r) => setTimeout(r, 10))
    expect(mockLLM.embed).toHaveBeenCalled()
    expect(mockTranscriptRepo.saveEmbedding).toHaveBeenCalledWith(
      'seg-1',
      expect.any(Array)
    )
  })

  it('does not throw when embedding fails', async () => {
    vi.mocked(mockLLM.embed).mockRejectedValueOnce(new Error('Network error'))
    svc.enqueue('seg-err', 'Error text', segContext)
    await new Promise((r) => setTimeout(r, 10))
    // No uncaught error; service continues
    expect(mockLLM.embed).toHaveBeenCalled()
  })

  it('does not enqueue when disabled', () => {
    svc.setEnabled(false)
    svc.enqueue('seg-x', 'text', segContext)
    expect(svc.getQueueLength()).toBe(0)
  })

  it('enriches text with speaker and recording context', async () => {
    svc.enqueue('seg-2', 'Revenue is up.', segContext)
    await new Promise((r) => setTimeout(r, 10))
    const [texts] = vi.mocked(mockLLM.embed).mock.calls[0]
    expect(texts[0]).toContain('Alice')
    expect(texts[0]).toContain('Revenue is up.')
    expect(texts[0]).toContain('Test Call')
  })
})
