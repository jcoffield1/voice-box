// Model recommendation hints per LLM feature.
// Run `node scripts/update-model-hints.mjs` to refresh from live rankings.
// Last updated: 2026-06-25
// Sources:
//   https://www.morphllm.com/best-ollama-models
//   https://www.morphllm.com/ollama-embedding-models

// The single model to suggest pulling per feature (shown in the Pull button).
export const MODEL_RECOMMENDED: Record<string, string> = {
  conversation:            'llama3.1:8b',
  summarization:           'llama3.1:8b',
  intent:                  'phi4-mini',
  embeddings:              'nomic-embed-text',
  'transcript-refinement': 'llama3.1:8b',
}

export const MODEL_HINTS: Record<string, string> = {
  conversation:            "Best local: llama3.1:8b (strong reasoning + instruction following). With 32GB+ RAM: llama3.3:70b.",
  summarization:           "Long context matters — meeting transcripts run long. llama3.1:8b supports 128K tokens.",
  intent:                  "Simple classification — prioritize speed. phi4-mini — a small fast model is all you need here.",
  embeddings:              "Always use a dedicated embedding model. nomic-embed-text (274MB, MTEB 62.3, 8K context) or qwen3-embedding:0.6b (639MB, MTEB 64.3, 32K context).",
  'transcript-refinement': "Corrects Whisper errors in proper nouns and speaker names — needs precise instruction following. llama3.1:8b works well. Leave unset to skip this pass.",
}
