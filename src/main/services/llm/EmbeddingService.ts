import type { LLMService } from '../llm/LLMService'
import type { TranscriptRepository } from '../storage/repositories/TranscriptRepository'
import type { SettingsRepository } from '../storage/repositories/SettingsRepository'

interface EmbeddingJob {
  segmentId: string
  text: string
  enriched: string
}

/**
 * EmbeddingService — asynchronously embeds transcript segments in the background.
 * Never blocks the transcription pipeline.
 */
export class EmbeddingService {
  private queue: EmbeddingJob[] = []
  private processing = false
  private enabled = true

  constructor(
    private readonly llm: LLMService,
    private readonly transcriptRepo: TranscriptRepository,
    private readonly settings: SettingsRepository
  ) {}

  /**
   * Enqueue a segment for embedding. Non-blocking.
   */
  enqueue(
    segmentId: string,
    text: string,
    context: { recordingTitle: string; speakerName?: string | null; timestampStart: number; createdAt: number }
  ): void {
    if (!this.enabled) return
    const dateStr = new Date(context.createdAt).toISOString().split('T')[0]
    const enriched = [
      `[Recording: ${context.recordingTitle}, ${dateStr}]`,
      context.speakerName ? `[Speaker: ${context.speakerName}, ${this.formatTime(context.timestampStart)}]` : '',
      text
    ]
      .filter(Boolean)
      .join('\n')

    this.queue.push({ segmentId, text, enriched })
    this.processQueue()
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return
    this.processing = true

    while (this.queue.length > 0) {
      const job = this.queue.shift()!
      try {
        const embeddings = await this.llm.embed([job.enriched])
        if (embeddings.length > 0) {
          this.transcriptRepo.saveEmbedding(job.segmentId, embeddings[0])
        }
      } catch (err) {
        // Embedding failure is non-fatal — log and continue
        console.error('[EmbeddingService] Failed to embed segment', job.segmentId, err)
      }
    }

    this.processing = false
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  getQueueLength(): number {
    return this.queue.length
  }

  /**
   * Re-index all segments (or only those for a specific recording).
   * Flushes the existing queue, then enqueues every matching segment.
   * Returns the number of segments queued.
   */
  async indexAll(recordingId?: string): Promise<{ queued: number }> {
    // Clear any pending queue to avoid duplicates
    this.queue = []

    const segments = this.transcriptRepo.findAllWithContext(recordingId)
    for (const seg of segments) {
      const dateStr = new Date(seg.createdAt).toISOString().split('T')[0]
      const enriched = [
        `[Recording: ${seg.recordingTitle}, ${dateStr}]`,
        seg.speakerName ? `[Speaker: ${seg.speakerName}, ${this.formatTime(seg.timestampStart)}]` : '',
        seg.text
      ]
        .filter(Boolean)
        .join('\n')

      this.queue.push({ segmentId: seg.id, text: seg.text, enriched })
    }

    // Kick off processing (non-blocking)
    void this.processQueue()

    return { queued: segments.length }
  }

  private formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
}
