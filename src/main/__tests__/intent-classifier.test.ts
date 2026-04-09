import { describe, it, expect } from 'vitest'
import { classifyIntent, refToSpeakerLabel } from '@main/services/ai/IntentClassifier'

describe('classifyIntent', () => {
  // ─── Positive matches ─────────────────────────────────────────────────────

  it('matches "Speaker 1 is Jon Smith"', () => {
    const intent = classifyIntent('Speaker 1 is Jon Smith')
    expect(intent).not.toBeNull()
    expect(intent!.type).toBe('label_speaker')
    expect(intent!.speakerRef).toBe('1')
    expect(intent!.name).toBe('Jon Smith')
  })

  it('matches lowercase "speaker 2 is sarah"', () => {
    const intent = classifyIntent('speaker 2 is Sarah')
    expect(intent).not.toBeNull()
    expect(intent!.name).toBe('Sarah')
  })

  it('matches word-number "speaker two is Alice Brown"', () => {
    const intent = classifyIntent('speaker two is Alice Brown')
    expect(intent).not.toBeNull()
    expect(intent!.speakerRef).toBe('2')
    expect(intent!.name).toBe('Alice Brown')
  })

  it('matches SPEAKER_00 format', () => {
    const intent = classifyIntent('SPEAKER_00 is Jon Smith')
    expect(intent).not.toBeNull()
    expect(intent!.speakerRef).toBe('SPEAKER_00')
    expect(intent!.name).toBe('Jon Smith')
  })

  it('matches "rename speaker 3 to Carol"', () => {
    const intent = classifyIntent('rename speaker 3 to Carol')
    expect(intent).not.toBeNull()
    expect(intent!.speakerRef).toBe('3')
    expect(intent!.name).toBe('Carol')
  })

  it('matches "call speaker 2 Sarah"', () => {
    const intent = classifyIntent('call speaker 2 Sarah')
    expect(intent).not.toBeNull()
    expect(intent!.speakerRef).toBe('2')
    expect(intent!.name).toBe('Sarah')
  })

  it('matches "speaker 1 = Jon"', () => {
    const intent = classifyIntent('speaker 1 = Jon')
    expect(intent).not.toBeNull()
    expect(intent!.name).toBe('Jon')
  })

  it('matches "speaker 1: Jon"', () => {
    const intent = classifyIntent('speaker 1: Jon')
    expect(intent).not.toBeNull()
    expect(intent!.name).toBe('Jon')
  })

  it('handles mixed case in surrounding sentence', () => {
    const intent = classifyIntent('The person speaking — Speaker 1 is Jon Smith — is our CEO.')
    expect(intent).not.toBeNull()
    expect(intent!.name).toBe('Jon Smith')
  })

  // ─── Negative matches ─────────────────────────────────────────────────────

  it('returns null for unrelated text', () => {
    expect(classifyIntent('What was discussed in the meeting?')).toBeNull()
  })

  it('returns null for name too short (single char)', () => {
    // "speaker 1 is J" — name 'J' is 1 char, should be rejected
    expect(classifyIntent('speaker 1 is J')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(classifyIntent('')).toBeNull()
  })

  it('returns null for summarize request', () => {
    expect(classifyIntent('Can you summarize this call?')).toBeNull()
  })

  it('returns null when no speaker reference', () => {
    expect(classifyIntent('This is Jon Smith speaking')).toBeNull()
  })

  // ─── Multiple patterns in sentence ───────────────────────────────────────

  it('returns the first detected intent when multiple patterns could match', () => {
    const intent = classifyIntent('speaker 1 is Jon and speaker 2 is Alice')
    // Only the first match is returned
    expect(intent).not.toBeNull()
    expect(intent!.speakerRef).toBe('1')
    expect(intent!.name).toBe('Jon')
  })
})

describe('refToSpeakerLabel', () => {
  it('converts numeric "1" to "SPEAKER_01"', () => {
    expect(refToSpeakerLabel('1')).toBe('SPEAKER_01')
  })

  it('converts numeric "10" to "SPEAKER_10"', () => {
    expect(refToSpeakerLabel('10')).toBe('SPEAKER_10')
  })

  it('passes SPEAKER_00 through unchanged (uppercased)', () => {
    expect(refToSpeakerLabel('SPEAKER_00')).toBe('SPEAKER_00')
  })

  it('uppercases lowercase SPEAKER_xx', () => {
    expect(refToSpeakerLabel('speaker_02')).toBe('SPEAKER_02')
  })

  it('returns uppercase for unrecognised refs', () => {
    expect(refToSpeakerLabel('unknown')).toBe('UNKNOWN')
  })
})
