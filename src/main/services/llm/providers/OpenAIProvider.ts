import OpenAI from 'openai'
import type { CompletionRequest, CompletionResponse, LLMModel } from '@shared/types'
import type { LLMProvider } from './LLMProvider'

const OPENAI_CHAT_MODELS: LLMModel[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    contextWindow: 128000,
    supportsEmbeddings: false,
    provider: 'openai'
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    contextWindow: 128000,
    supportsEmbeddings: false,
    provider: 'openai'
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    contextWindow: 128000,
    supportsEmbeddings: false,
    provider: 'openai'
  }
]

const OPENAI_EMBEDDING_MODELS: LLMModel[] = [
  {
    id: 'text-embedding-3-small',
    name: 'text-embedding-3-small',
    contextWindow: 8191,
    supportsEmbeddings: true,
    provider: 'openai'
  },
  {
    id: 'text-embedding-3-large',
    name: 'text-embedding-3-large',
    contextWindow: 8191,
    supportsEmbeddings: true,
    provider: 'openai'
  }
]

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai'
  readonly name = 'OpenAI'
  readonly type = 'remote' as const
  private client: OpenAI | null = null

  constructor(private apiKey: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey })
    }
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
    this.client = new OpenAI({ apiKey })
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey || !this.client) return false
    try {
      await this.client.models.list()
      return true
    } catch {
      return false
    }
  }

  async listModels(): Promise<LLMModel[]> {
    return [...OPENAI_CHAT_MODELS, ...OPENAI_EMBEDDING_MODELS]
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.client) throw new Error('OpenAI API key not configured')

    const messages = request.systemPrompt
      ? [{ role: 'system' as const, content: request.systemPrompt }, ...request.messages]
      : request.messages

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens
    })

    const choice = response.choices[0]
    return {
      text: choice.message.content ?? '',
      model: response.model,
      provider: 'openai',
      tokensUsed: response.usage ? response.usage.total_tokens : undefined
    }
  }

  async *stream(request: CompletionRequest): AsyncGenerator<string> {
    if (!this.client) throw new Error('OpenAI API key not configured')

    const messages = request.systemPrompt
      ? [{ role: 'system' as const, content: request.systemPrompt }, ...request.messages]
      : request.messages

    const stream = await this.client.chat.completions.create({
      model: request.model,
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens,
      stream: true
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) throw new Error('OpenAI API key not configured')

    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts
    })

    return response.data
      .sort((a, b) => a.index - b.index)
      .map((e) => e.embedding)
  }
}
