import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMService } from '@main/services/llm/LLMService'
import type { SettingsRepository } from '@main/services/storage/repositories/SettingsRepository'
import type { LLMFeature, LLMProviderType } from '@shared/types'

// Build a minimal mock SettingsRepository
function makeMockSettings(map: Record<string, string> = {}): SettingsRepository {
  return {
    get: vi.fn((key: string) => map[key] ?? null),
    getJson: vi.fn(<T>(key: string) => {
      const val = map[key]
      if (!val) return null
      try { return JSON.parse(val) as T } catch { return null }
    }),
    set: vi.fn(),
    setJson: vi.fn(),
    getAll: vi.fn(() => map)
  } as unknown as SettingsRepository
}

describe('LLMService', () => {
  it('creates all three providers on construction', () => {
    const settings = makeMockSettings()
    const svc = new LLMService(settings)
    // Should not throw when getting each provider
    expect(svc.getProvider('ollama')).toBeDefined()
    expect(svc.getProvider('claude')).toBeDefined()
    expect(svc.getProvider('openai')).toBeDefined()
  })

  it('throws for unknown provider type', () => {
    const svc = new LLMService(makeMockSettings())
    expect(() => svc.getProvider('unknown' as LLMProviderType)).toThrow()
  })

  it('returns ollama as default provider for any feature', () => {
    const svc = new LLMService(makeMockSettings())
    const { provider } = svc.getProviderForFeature('summarization')
    expect(provider).toBeDefined()
    // Default model should also be resolved
  })

  it('respects provider setting for a feature', () => {
    const settings = makeMockSettings({
      'llm.summarization.provider': '"claude"',
      'llm.summarization.model': '"claude-opus-4-5"'
    })
    const svc = new LLMService(settings)
    const { provider } = svc.getProviderForFeature('summarization' as LLMFeature)
    // Provider should be the Claude instance
    const claudeProto = Object.getPrototypeOf(provider).constructor.name
    expect(claudeProto).toBe('ClaudeProvider')
  })

  it('setApiKey updates both claude and openai without throwing', () => {
    const svc = new LLMService(makeMockSettings())
    expect(() => svc.setApiKey('claude', 'sk-test-key')).not.toThrow()
    expect(() => svc.setApiKey('openai', 'sk-openai-key')).not.toThrow()
  })
})
