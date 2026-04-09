import type { CompletionRequest, CompletionResponse, LLMModel, ChatMessage } from '@shared/types'

export interface LLMProvider {
  readonly id: string
  readonly name: string
  readonly type: 'local' | 'remote'

  isAvailable(): Promise<boolean>
  listModels(): Promise<LLMModel[]>
  complete(request: CompletionRequest): Promise<CompletionResponse>
  stream(request: CompletionRequest): AsyncGenerator<string>
  embed(texts: string[]): Promise<number[][]>
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token (works reasonably across providers)
  return Math.ceil(text.length / 4)
}

export function buildMessages(
  systemPrompt: string | undefined,
  messages: ChatMessage[]
): ChatMessage[] {
  if (!systemPrompt) return messages
  return [{ role: 'system', content: systemPrompt }, ...messages]
}
