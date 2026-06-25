#!/usr/bin/env node
/**
 * Fetches current Ollama model rankings and rewrites src/renderer/src/data/modelHints.ts.
 *
 * Sources (both SSR pages with parseable content):
 *   General:    https://www.morphllm.com/best-ollama-models
 *   Embeddings: https://www.morphllm.com/ollama-embedding-models
 *
 * Run:  node scripts/update-model-hints.mjs
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT  = join(ROOT, 'src/renderer/src/data/modelHints.ts')

const SOURCES = {
  general:    'https://www.morphllm.com/best-ollama-models',
  embeddings: 'https://www.morphllm.com/ollama-embedding-models',
}

// ─── Fetch + strip HTML ────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  const html = await res.text()

  // Try __NEXT_DATA__ first — structured JSON, avoids HTML noise
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (m) {
    try { return extractStrings(JSON.parse(m[1])).join(' ') } catch { /* fall through */ }
  }

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function extractStrings(obj, out = []) {
  if (typeof obj === 'string' && obj.length > 10) out.push(obj)
  else if (Array.isArray(obj)) obj.forEach(v => extractStrings(v, out))
  else if (obj && typeof obj === 'object') Object.values(obj).forEach(v => extractStrings(v, out))
  return out
}

// ─── Model name validation ─────────────────────────────────────────────────────

// Known Ollama model family prefixes
const KNOWN_FAMILIES = /^(qwen|llama|mistral|gemma|phi|deepseek|nomic|mxbai|bge|snowflake|tinyllama|smollm|all-minilm|vicuna|orca|falcon|codellama|starcoder|dolphin|solar|openchat|wizard|nous|yi)/

// Quantization-only tokens that look like model names but aren't (q4_k_m, q8_0, f16, etc.)
const QUANT_ONLY = /^(q\d+(_k_[ms]|_\d+)?|f16|fp16|int8|int4)$/

// Tags that are just port numbers or version strings with no letters
const INVALID_TAG = /^\d+$/ // e.g. :11434, :8080

function isValidModel(raw) {
  const name = raw.toLowerCase()
  if (name.length < 5) return false
  if (QUANT_ONLY.test(name)) return false

  if (name.includes(':')) {
    const [base, tag] = name.split(':')
    if (INVALID_TAG.test(tag)) return false        // port number
    if (!/[a-z]/i.test(tag)) return false          // tag must have a letter
    if (!KNOWN_FAMILIES.test(base)) return false   // base must be a known family
  } else {
    // Untagged: must match a known family
    if (!KNOWN_FAMILIES.test(name)) return false
  }

  return true
}

// Extract all valid model names from a text segment
function extractModels(text) {
  const found = []
  // Match word:word and plain words
  for (const m of text.matchAll(/\b([a-z][a-z0-9._-]*(?::[a-z0-9._-]+)?)\b/g)) {
    if (isValidModel(m[1])) found.push(m[1].toLowerCase())
  }
  return [...new Set(found)]
}

// Return unique models found within `windowChars` chars after any occurrence of any keyword
function modelsNearKeyword(text, keywords, windowChars = 600) {
  const lower = text.toLowerCase()
  const hits = []
  for (const kw of keywords) {
    let idx = 0
    while ((idx = lower.indexOf(kw.toLowerCase(), idx)) !== -1) {
      hits.push(...extractModels(text.slice(idx, idx + windowChars)))
      idx++
    }
  }
  return [...new Set(hits)]
}

// ─── Embedding table parsing ───────────────────────────────────────────────────

// The morphllm embedding page has a markdown table:
//   | model-name | params | dims | context | MTEB | size |
// We scan for valid model names followed (within ~120 chars) by a decimal MTEB score (40–85).
function parseEmbeddingTable(text) {
  const rows = []
  // Match model-name followed by a decimal number that looks like an MTEB score
  const re = /([a-z][a-z0-9._:-]+)\b(.{0,120}?)(\d{2}\.\d{2})/gs
  for (const m of text.matchAll(re)) {
    if (!isValidModel(m[1])) continue
    const score = parseFloat(m[3])
    if (score < 40 || score > 85) continue
    // The intervening text should be short/table-like (no long prose between name and score)
    const between = m[2].replace(/\s+/g, ' ').trim()
    if (between.split(' ').length > 12) continue  // too much text between name and score
    rows.push({ model: m[1].toLowerCase(), mteb: score })
  }

  // Deduplicate — keep highest MTEB per model
  const best = new Map()
  for (const r of rows) {
    if (!best.has(r.model) || best.get(r.model).mteb < r.mteb) best.set(r.model, r)
  }

  return [...best.values()]
    .filter(r => r.model !== 'localhost' && !r.model.startsWith('morph'))
    .sort((a, b) => b.mteb - a.mteb)
    .slice(0, 5)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Extract the parameter count in billions from a model name tag (e.g. qwen3:8b → 8, gemma4:26b → 26)
function modelSizeB(name) {
  const m = name.match(/:(\d+(?:\.\d+)?)(b)/i)
  return m ? parseFloat(m[1]) : null
}

// Strip quantization suffix from a tag so e.g. qwen3-embedding:8b-q8_0 → qwen3-embedding:8b
function baseModelName(name) {
  return name.replace(/:[^:]*/, tag => tag.replace(/-(q\d+[\w]*|fp16|f16|int\d+)$/i, ''))
}

// ─── Build hint strings ────────────────────────────────────────────────────────

function buildHints(generalText, embeddingText) {
  const chat = modelsNearKeyword(generalText, ['general purpose', 'chat', 'instruction follow', 'qwen3', 'best overall'])
    .filter(m => !m.includes('embed') && !m.includes('coder') && !m.startsWith('deepseek-r1'))
    .slice(0, 2)

  const sum = modelsNearKeyword(generalText, ['128k', '128,000', 'long context', 'summariz'])
    .filter(m => !m.includes('embed') && !m.includes('coder'))
    .slice(0, 2)

  // Intent needs small models only — filter anything >= 10B parameters
  const intent = modelsNearKeyword(generalText, ['phi4-mini', 'phi-4 mini', 'phi4', '3b', '1b', 'classif', 'small fast'])
    .filter(m => {
      if (m.includes('embed') || m.includes('coder')) return false
      const size = modelSizeB(m)
      return size === null || size < 10 // reject 10B+ models for intent slot
    })
    .slice(0, 2)

  // Deduplicate embedding rows by base model name (remove quant variants like -q8_0, -fp16)
  const rawEmbedRows = parseEmbeddingTable(embeddingText)
  const seenBase = new Set()
  const embedRows = rawEmbedRows.filter(r => {
    const base = baseModelName(r.model)
    if (seenBase.has(base)) return false
    seenBase.add(base)
    return true
  })

  const refine = modelsNearKeyword(generalText, ['instruction follow', 'general purpose', 'named entity', 'correction'])
    .filter(m => !m.includes('embed') && !m.includes('coder'))
    .slice(0, 2)

  // Grammar-safe formatter
  const fmt = (models, fallback) => {
    if (!models.length) return fallback
    return models.length === 1 ? models[0] : models.join(' or ')
  }

  const sumList = fmt(sum, 'qwen2.5:7b or mistral-nemo')
  const sumSuffix = sum.length === 2 ? ' both support 128K tokens.' : ' supports 128K tokens.'

  return {
    conversation:
      `Best local: ${fmt(chat, 'qwen3:8b or llama3.1:8b')} (strong reasoning + instruction following). With 32GB+ RAM: llama3.3:70b.`,

    summarization:
      `Long context matters — meeting transcripts run long. ${sumList}${sumSuffix}`,

    intent:
      `Simple classification — prioritize speed. ${fmt(intent, 'phi4-mini:3.8b or llama3.2:3b')} — a small fast model is all you need here.`,

    embeddings: embedRows.length >= 3
      ? `Always use a dedicated embedding model, never a chat model. ` +
        embedRows.slice(0, 3).map(r => `${baseModelName(r.model)} (MTEB ${r.mteb})`).join(', ') + `.`
      : `Always use a dedicated embedding model. nomic-embed-text (274MB, MTEB 62.3, 8K context) or qwen3-embedding:0.6b (639MB, MTEB 64.3, 32K context).`,

    'transcript-refinement':
      `Corrects Whisper errors in proper nouns and speaker names — needs precise instruction following. ${fmt(refine, 'qwen3:8b or llama3.1:8b')} ${refine.length === 1 ? 'works' : 'work'} well. Leave unset to skip this pass.`,
  }
}

// ─── Write output ──────────────────────────────────────────────────────────────

function writeHints(hints, recommended) {
  const date = new Date().toISOString().slice(0, 10)
  const out = `// Model recommendation hints per LLM feature.
// Run \`node scripts/update-model-hints.mjs\` to refresh from live rankings.
// Last updated: ${date}
// Sources:
//   ${SOURCES.general}
//   ${SOURCES.embeddings}

// The single model to suggest pulling per feature (shown in the Pull button).
export const MODEL_RECOMMENDED: Record<string, string> = {
  conversation:            ${JSON.stringify(recommended.conversation)},
  summarization:           ${JSON.stringify(recommended.summarization)},
  intent:                  ${JSON.stringify(recommended.intent)},
  embeddings:              ${JSON.stringify(recommended.embeddings)},
  'transcript-refinement': ${JSON.stringify(recommended['transcript-refinement'])},
}

export const MODEL_HINTS: Record<string, string> = {
  conversation:            ${JSON.stringify(hints.conversation)},
  summarization:           ${JSON.stringify(hints.summarization)},
  intent:                  ${JSON.stringify(hints.intent)},
  embeddings:              ${JSON.stringify(hints.embeddings)},
  'transcript-refinement': ${JSON.stringify(hints['transcript-refinement'])},
}
`
  writeFileSync(OUT, out, 'utf8')
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching model rankings...')
  console.log(`  ${SOURCES.general}`)
  console.log(`  ${SOURCES.embeddings}`)

  let generalText, embeddingText
  try {
    ;[generalText, embeddingText] = await Promise.all([
      fetchText(SOURCES.general),
      fetchText(SOURCES.embeddings),
    ])
    console.log(`  ✓ general:    ${generalText.length.toLocaleString()} chars`)
    console.log(`  ✓ embeddings: ${embeddingText.length.toLocaleString()} chars`)
  } catch (err) {
    console.error('\nFetch failed:', err.message)
    console.error('Keeping existing hints unchanged.')
    process.exit(1)
  }

  const hints = buildHints(generalText, embeddingText)

  // Derive recommended model from the first model name in each hint (fallback to known good)
  const FALLBACK_RECOMMENDED = {
    conversation: 'llama3.1:8b', summarization: 'llama3.1:8b',
    intent: 'phi4-mini', embeddings: 'nomic-embed-text', 'transcript-refinement': 'llama3.1:8b',
  }
  const recommended = Object.fromEntries(
    Object.entries(hints).map(([k, v]) => {
      const m = v.match(/\b([a-z][a-z0-9._-]+:[a-z0-9._-]+)\b/)
      return [k, m ? m[1] : FALLBACK_RECOMMENDED[k]]
    })
  )

  console.log('\nHints:')
  for (const [k, v] of Object.entries(hints)) {
    console.log(`  [${k}] pull: ${recommended[k]}\n    ${v}\n`)
  }

  writeHints(hints, recommended)
  console.log(`Written → ${OUT.replace(ROOT + '/', '')}`)
}

main().catch(err => { console.error(err); process.exit(1) })
