import type { LLMProvider } from './providers/LLMProvider'
import { OllamaProvider } from './providers/OllamaProvider'
import { ClaudeProvider } from './providers/ClaudeProvider'
import { OpenAIProvider } from './providers/OpenAIProvider'
import type { CompletionRequest, CompletionResponse, LLMModel, LLMProviderType, LLMFeature } from '@shared/types'
import type { SettingsRepository } from '../storage/repositories/SettingsRepository'
import { estimateTokens } from './providers/LLMProvider'

const FEATURE_CONTEXT_HEADROOM = 0.85 // Use max 85% of context window

export class LLMService {
  private providers: Map<LLMProviderType, LLMProvider> = new Map()

  constructor(private readonly settings: SettingsRepository) {
    this.providers.set('ollama', new OllamaProvider())
    this.providers.set('claude', new ClaudeProvider(''))
    this.providers.set('openai', new OpenAIProvider(''))
  }

  /**
   * Update an API key for a remote provider.
   * Called when user saves settings.
   */
  setApiKey(providerType: LLMProviderType, key: string): void {
    const provider = this.providers.get(providerType)
    if (!provider) return
    if (provider instanceof ClaudeProvider) provider.setApiKey(key)
    if (provider instanceof OpenAIProvider) provider.setApiKey(key)
  }

  getProvider(type: LLMProviderType): LLMProvider {
    const p = this.providers.get(type)
    if (!p) throw new Error(`Unknown LLM provider: ${type}`)
    return p
  }

  getProviderForFeature(feature: LLMFeature): { provider: LLMProvider; model: string } {
    const providerType = this.settings.getJson<LLMProviderType>(`llm.${feature}.provider`) ?? 'ollama'
    const model = this.settings.getJson<string>(`llm.${feature}.model`) ?? 'llama3.2:8b'
    return { provider: this.getProvider(providerType), model }
  }

  async complete(feature: LLMFeature, request: Omit<CompletionRequest, 'model'>): Promise<CompletionResponse> {
    const { provider, model } = this.getProviderForFeature(feature)
    return provider.complete({ ...request, model })
  }

  async *stream(feature: LLMFeature, request: Omit<CompletionRequest, 'model'>): AsyncGenerator<string> {
    const { provider, model } = this.getProviderForFeature(feature)
    yield* provider.stream({ ...request, model })
  }

  async embed(texts: string[]): Promise<number[][]> {
    const { provider, model } = this.getProviderForFeature('embeddings')
    if (provider instanceof OllamaProvider) {
      return provider.embed(texts, model)
    }
    return provider.embed(texts)
  }

  async listModels(type: LLMProviderType): Promise<LLMModel[]> {
    return this.getProvider(type).listModels()
  }

  async isAvailable(type: LLMProviderType): Promise<boolean> {
    return this.getProvider(type).isAvailable()
  }

  /**
   * Check if a given context exceeds the model's context window.
   * If so, caller should use RAG instead of full context injection.
   */
  exceedsContextWindow(feature: LLMFeature, text: string): boolean {
    const { model } = this.getProviderForFeature(feature)
    // Simple heuristic — estimate tokens and check against known window sizes
    const tokens = estimateTokens(text)
    // Pull context window from model list if available (best-effort)
    const limit = this.getContextWindowForModel(model)
    return tokens > limit * FEATURE_CONTEXT_HEADROOM
  }

  private getContextWindowForModel(modelId: string): number {
    // Lookup from Ollama known sizes or defaults
    const known: Record<string, number> = {
      'llama3.2': 128000,
      'llama3.1': 128000,
      'claude': 200000,
      'gpt-4o': 128000,
      'gpt-4': 128000,
      'mistral': 32768
    }
    for (const [key, size] of Object.entries(known)) {
      if (modelId.toLowerCase().includes(key)) return size
    }
    return 8192
  }
}
