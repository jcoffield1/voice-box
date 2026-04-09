/**
 * IntentClassifier — parses a user message to detect actionable labeling intents.
 * If a labeling intent is detected, the chat handler executes it directly instead
 * of (or before) routing to the LLM.
 *
 * Supported patterns:
 *   "Speaker 1 is Jon Smith"
 *   "speaker two is Sarah"
 *   "that's Jon" / "this is Sarah"
 *   "rename speaker 1 to Sarah"
 *   "Speaker_00 is Jon"
 *   "call speaker 2 Sarah"
 */

export interface LabelSpeakerIntent {
  type: 'label_speaker'
  /** The raw reference used in the message: "1", "two", "Speaker 1", "SPEAKER_00", etc. */
  speakerRef: string
  /** The human name to assign */
  name: string
}

export type Intent = LabelSpeakerIntent

// ─── Patterns ────────────────────────────────────────────────────────────────

const WORD_TO_NUM: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
}

function normaliseRef(raw: string): string {
  const word = raw.trim().toLowerCase()
  if (word in WORD_TO_NUM) return String(WORD_TO_NUM[word])
  return raw.trim()
}

/**
 * The patterns below deliberately ignore case and leading/trailing whitespace.
 * Each pattern must capture:
 *   group 1 → speaker reference (number, word-number, or raw SPEAKER_XX string)
 *   group 2 → the human name to assign
 */
const NAME_PAT = '([A-Z][a-zA-Z]+(?:\\s+(?!(?:and|or|the|in|to|is|at|of|for|with|from|not|but|so)\\b)[a-zA-Z]+)?)'

const LABEL_PATTERNS: RegExp[] = [
  // "SPEAKER_00 is Jon" (more specific format – must come before the generic numeric pattern)
  new RegExp(`\\b(SPEAKER_\\d+)\\b\\s+is\\s+${NAME_PAT}`, 'i'),
  // "speaker 1 is Jon Smith"
  new RegExp(`\\bspeaker[_ ]?(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\\b\\s+is\\s+${NAME_PAT}`, 'i'),
  // "rename speaker 1 to Sarah"
  new RegExp(`\\brename\\s+speaker[_ ]?(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\\b\\s+to\\s+${NAME_PAT}`, 'i'),
  // "call speaker 2 Sarah"
  new RegExp(`\\bcall\\s+speaker[_ ]?(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\\b\\s+${NAME_PAT}`, 'i'),
  // "speaker 3 = Jon" / "speaker 3: Jon"
  new RegExp(`\\bspeaker[_ ]?(\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\\b\\s*[=:]\\s*${NAME_PAT}`, 'i')
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a user message for labeling intents.
 * Returns the first detected intent or null if no match.
 */
export function classifyIntent(message: string): Intent | null {
  for (const pattern of LABEL_PATTERNS) {
    const match = message.match(pattern)
    if (match) {
      const rawRef = match[1].trim()
      const name = match[2].trim().replace(/\s+/g, ' ')
      // Only accept reasonable names (2–40 chars)
      if (name.length < 2 || name.length > 40) continue
      return {
        type: 'label_speaker',
        speakerRef: normaliseRef(rawRef),
        name
      }
    }
  }
  return null
}

/**
 * Build a canonical "SPEAKER_XX" lookup key from the detected reference.
 * Whisper/pyannote typically emits "SPEAKER_00", "SPEAKER_01", etc.
 * If the user says "speaker 1", we map to "SPEAKER_01" (zero-padded).
 */
export function refToSpeakerLabel(speakerRef: string): string {
  // Already in SPEAKER_XX format
  if (/^SPEAKER_\d+$/i.test(speakerRef)) return speakerRef.toUpperCase()
  // Numeric: "1" → "SPEAKER_01"
  const n = parseInt(speakerRef, 10)
  if (!isNaN(n)) return `SPEAKER_${String(n).padStart(2, '0')}`
  return speakerRef.toUpperCase()
}
