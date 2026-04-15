import type { PythonBridge } from '../../python/PythonBridge'
import type { SpeakerRepository } from '../storage/repositories/SpeakerRepository'

export interface SpeakerCandidate {
  speakerId: string
  speakerName: string
  confidence: number
}

interface EmbedSegmentsResult {
  embedding: number[]
  dim: number
}

interface EmbedSegmentsBatchResult {
  results: Array<{ id: string; embedding?: number[]; dim?: number; error?: string }>
}

/** Cosine similarity between two equal-length vectors. Returns 0 for zero-norm inputs. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Max number of samples used in the running-mean denominator.
 *  At saturation a new sample contributes 1/(N_CAP+1) ≈ 3% weight,
 *  so the model is stable but still adapts to gradual voice changes.
 *  Without a cap the original formula (old+new)/2 gives each new sample
 *  50% weight — after N updates the original embedding weight is 0.5^N,
 *  meaning hundreds of recordings worth of training are completely lost. */
const EMBEDDING_SAMPLE_CAP = 30

/**
 * SpeakerIdentificationService — compares voice embeddings of audio segments
 * against stored speaker profiles using Resemblyzer (via embed_voice.py).
 */
export class SpeakerIdentificationService {
  constructor(
    private readonly pythonBridge: PythonBridge,
    private readonly speakerRepo: SpeakerRepository
  ) {}

  /**
   * Extract a voice embedding from the given time-range segments of an audio
   * file, then rank all stored speaker profiles by cosine similarity.
   *
   * Similarity is computed in-process (TypeScript) — no extra IPC round-trips.
   * Returns an empty array when no speaker profiles with embeddings exist yet.
   */
  async identifyFromAudio(
    audioPath: string,
    segments: Array<{ start: number; end: number }>
  ): Promise<SpeakerCandidate[]> {
    const knownSpeakers = this.speakerRepo.findWithEmbeddings()
    if (knownSpeakers.length === 0) return []

    this.ensureRunning()

    const embedResult = await this.pythonBridge.send<EmbedSegmentsResult>(
      'embed_voice',
      'embed_segments',
      { audio_path: audioPath, segments }
    )

    // Python returns an empty embedding when the segments fall outside the audio duration
    if (!embedResult.embedding || embedResult.embedding.length === 0) return []

    const queryEmbedding = embedResult.embedding
    const candidates: SpeakerCandidate[] = knownSpeakers.map((speaker) => ({
      speakerId:  speaker.id,
      speakerName: speaker.name,
      confidence: cosineSimilarity(queryEmbedding, speaker.voiceEmbedding as number[]),
    }))

    return candidates.sort((a, b) => b.confidence - a.confidence)
  }

  /**
   * Embed multiple speaker clusters from the same audio file in a single
   * Python IPC call, then rank stored speakers for each cluster in TypeScript.
   *
   * Returns a map from cluster id → sorted SpeakerCandidate[].
   * Clusters that fail to embed are omitted from the result.
   */
  async identifyBatch(
    audioPath: string,
    clusters: Array<{ id: string; segments: Array<{ start: number; end: number }> }>
  ): Promise<Map<string, SpeakerCandidate[]>> {
    const result = new Map<string, SpeakerCandidate[]>()
    if (clusters.length === 0) return result

    const knownSpeakers = this.speakerRepo.findWithEmbeddings()
    if (knownSpeakers.length === 0) return result

    this.ensureRunning()

    const batchResult = await this.pythonBridge.send<EmbedSegmentsBatchResult>(
      'embed_voice',
      'embed_segments_batch',
      { audio_path: audioPath, groups: clusters.map((c) => ({ id: c.id, segments: c.segments })) }
    )

    for (const item of batchResult.results) {
      if (item.error || !item.embedding) continue
      const candidates: SpeakerCandidate[] = knownSpeakers.map((speaker) => ({
        speakerId:   speaker.id,
        speakerName: speaker.name,
        confidence:  cosineSimilarity(item.embedding!, speaker.voiceEmbedding as number[]),
      }))
      result.set(item.id, candidates.sort((a, b) => b.confidence - a.confidence))
    }

    return result
  }

  /**
   * a speaker profile so future recordings can be auto-identified.
   */
  async learnSpeaker(
    speakerId: string,
    audioPath: string,
    segments: Array<{ start: number; end: number }>
  ): Promise<void> {
    this.ensureRunning()

    const result = await this.pythonBridge.send<EmbedSegmentsResult>(
      'embed_voice',
      'embed_segments',
      { audio_path: audioPath, segments }
    )

    if (!result.embedding || result.embedding.length === 0) return

    // Proper running mean capped at EMBEDDING_SAMPLE_CAP.
    //
    // Old formula: (old + new) / 2
    //   Weight of original after N updates = 0.5^N
    //   After ~600 updates (hundreds of recordings) = essentially 0.
    //   The stored embedding had zero connection to any specific voice.
    //
    // New formula: (old * min(n, CAP) + new) / (min(n, CAP) + 1)
    //   At n=1: new sample has 50% weight (same as before — good for initial learning)
    //   At n=30+: new sample has 1/31 ≈ 3% weight (stable, noise-resistant)
    //   Old recordings are never discarded — they always sum to (n/(n+1)) weight.
    const existing = this.speakerRepo.findById(speakerId)
    const existingEmbedding = existing?.voiceEmbedding as number[] | null | undefined
    const currentSamples = existing?.embeddingSamples ?? 0
    let finalEmbedding = result.embedding
    let newSamples = 1
    if (existingEmbedding && existingEmbedding.length === result.embedding.length) {
      const weight = Math.min(currentSamples, EMBEDDING_SAMPLE_CAP)
      finalEmbedding = result.embedding.map((v, i) => (existingEmbedding[i] * weight + v) / (weight + 1))
      newSamples = weight + 1
    }

    this.speakerRepo.updateVoiceEmbedding(speakerId, finalEmbedding, newSamples)
  }

  private ensureRunning(): void {
    if (!this.pythonBridge.isRunning('embed_voice')) {
      this.pythonBridge.start('embed_voice')
    }
  }
}
