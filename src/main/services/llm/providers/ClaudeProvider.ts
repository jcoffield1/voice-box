import Anthropic from '@anthropic-ai/sdk'
import type { CompletionRequest, CompletionResponse, LLMModel } from '@shared/types'
import type { LLMProvider } from './LLMProvider'

const CLAUDE_MODELS: LLMModel[] = [
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    contextWindow: 200000,
    supportsEmbeddings: false,
    provider: 'claude'
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200000,
    supportsEmbeddings: false,
    provider: 'claude'
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    contextWindow: 200000,
    supportsEmbeddings: false,
    provider: 'claude'
  }
]

export class ClaudeProvider implements LLMProvider {
  readonly id = 'claude'
  readonly name = 'Claude (Anthropic)'
  readonly type = 'remote' as const
  private client: Anthropic | null = null

  constructor(private apiKey: string) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey })
    }
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
    this.client = new Anthropic({ apiKey })
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey || !this.client) return false
    try {
      // Light check — attempt a minimal models list
      await this.client.models.list({ limit: 1 })
      return true
    } catch {
      return false
    }
  }

  async listModels(): Promise<LLMModel[]> {
    return CLAUDE_MODELS
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.client) throw new Error('Claude API key not configured')

    const userMessages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: userMessages
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return {
      text: textBlock?.type === 'text' ? textBlock.text : '',
      model: response.model,
      provider: 'claude',
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens
    }
  }

  async *stream(request: CompletionRequest): AsyncGenerator<string> {
    if (!this.client) throw new Error('Claude API key not configured')

    const userMessages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const stream = await this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: userMessages
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield event.delta.text
      }
    }
  }

  async embed(_texts: string[]): Promise<number[][]> {
    // Anthropic does not currently offer a standalone embeddings API.
    // Callers should fall back to Ollama or OpenAI for embeddings.
    throw new Error('Claude does not support text embeddings. Use Ollama or OpenAI instead.')
  }
}
