import type { CompletionRequest, CompletionResponse, LLMModel } from '@shared/types'
import type { LLMProvider } from './LLMProvider'

interface OllamaTagsResponse {
  models: Array<{
    name: string
    details?: { parameter_size?: string; family?: string }
  }>
}

interface OllamaChatResponse {
  message: { content: string }
  model: string
  eval_count?: number
}

interface OllamaChatChunk {
  message: { content: string }
  done: boolean
}

interface OllamaEmbedResponse {
  embedding: number[]
}

const DEFAULT_CONTEXT_WINDOW = 8192

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'llama3.2': 128000,
  'llama3.1': 128000,
  'llama3': 8192,
  'mistral': 32768,
  'qwen2.5': 32768,
  'nomic-embed-text': 8192,
  'mxbai-embed-large': 512
}

function guessContextWindow(modelName: string): number {
  const base = modelName.split(':')[0]
  for (const [key, size] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
    if (base.toLowerCase().includes(key)) return size
  }
  return DEFAULT_CONTEXT_WINDOW
}

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama'
  readonly name = 'Ollama (Local)'
  readonly type = 'local' as const

  constructor(private readonly baseUrl = 'http://localhost:11434') {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch {
      return false
    }
  }

  async listModels(): Promise<LLMModel[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`)
    if (!res.ok) throw new Error(`Ollama /api/tags failed: ${res.status}`)
    const data = (await res.json()) as OllamaTagsResponse
    return data.models.map((m) => ({
      id: m.name,
      name: m.name,
      contextWindow: guessContextWindow(m.name),
      supportsEmbeddings: m.name.includes('embed'),
      provider: 'ollama' as const
    }))
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = request.systemPrompt
      ? [{ role: 'system', content: request.systemPrompt }, ...request.messages]
      : request.messages

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens
        }
      })
    })
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`)
    const data = (await res.json()) as OllamaChatResponse
    return {
      text: data.message.content,
      model: data.model,
      provider: 'ollama',
      tokensUsed: data.eval_count
    }
  }

  async *stream(request: CompletionRequest): AsyncGenerator<string> {
    const messages = request.systemPrompt
      ? [{ role: 'system', content: request.systemPrompt }, ...request.messages]
      : request.messages

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages,
        stream: true,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.maxTokens
        }
      })
    })
    if (!res.ok) throw new Error(`Ollama stream failed: ${res.status}`)
    if (!res.body) throw new Error('No response body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value)
      for (const line of text.split('\n').filter((l) => l.trim())) {
        try {
          const chunk = JSON.parse(line) as OllamaChatChunk
          if (chunk.message?.content) yield chunk.message.content
          if (chunk.done) return
        } catch {
          // Partial line — fine, will be in next read
        }
      }
    }
  }

  async embed(texts: string[], model = 'nomic-embed-text'): Promise<number[][]> {
    const results: number[][] = []
    // Ollama embeds one text at a time
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text })
      })
      if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`)
      const data = (await res.json()) as OllamaEmbedResponse
      results.push(data.embedding)
    }
    return results
  }
}
