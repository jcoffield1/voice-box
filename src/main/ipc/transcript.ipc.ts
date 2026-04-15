import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { IPC } from '@shared/ipc-types'
import type {
  GetTranscriptArgs,
  GetTranscriptResult,
  UpdateSegmentArgs,
  AssignSpeakerArgs,
  AssignSpeakerResult,
  RankSpeakersArgs,
  RankSpeakersResult,
  SweepSpeakersArgs,
  SweepSpeakersResult
} from '@shared/ipc-types'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { SpeakerRepository } from '../services/storage/repositories/SpeakerRepository'
import type { RecordingRepository } from '../services/storage/repositories/RecordingRepository'
import type { SpeakerIdentificationService } from '../services/ai/SpeakerIdentificationService'

const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85

interface TranscriptIpcDeps {
  transcriptRepo: TranscriptRepository
  speakerRepo: SpeakerRepository
  recordingRepo: RecordingRepository
  speakerIdService: SpeakerIdentificationService
  getWebContents: () => WebContents | null
  audio: { saveSnapshot: (path: string) => void } | null
}

export function registerTranscriptIpc(deps: TranscriptIpcDeps): void {
  const { transcriptRepo, speakerRepo, recordingRepo, speakerIdService, getWebContents, audio } = deps

  // Prevent concurrent sweeps for the same recording — avoids duplicate DB writes
  // and double-counting of speakerRepo.incrementRecordingCount.
  const sweepingRecordings = new Set<string>()

  /**
   * After a speaker embedding is learned, sweep all unresolved SPEAKER_XX clusters in
   * the recording and auto-assign any that match a stored voice embedding with
   * confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD.  Runs fully in the background.
   */
  async function sweepUnresolvedClusters(recordingId: string, audioPath: string): Promise<number> {
    if (sweepingRecordings.has(recordingId)) {
      console.debug(`[SweepSpeakers] Sweep already in progress for ${recordingId} — skipping`)
      return 0
    }
    sweepingRecordings.add(recordingId)
    try {
      return await _doSweep(recordingId, audioPath)
    } finally {
      sweepingRecordings.delete(recordingId)
    }
  }

  async function _doSweep(recordingId: string, audioPath: string): Promise<number> {
    // ── SPEAKER_XX clusters (from diarization) ──────────────────────────────
    const unresolvedClusters = transcriptRepo.findUnresolvedSpeakerClusters(recordingId)
    const nullSegments = transcriptRepo.findNullSpeakerSegments(recordingId)

    if (unresolvedClusters.length === 0 && nullSegments.length === 0) return 0

    let updatedCount = 0

    if (unresolvedClusters.length > 0) {
      const batchInput = unresolvedClusters.map((c) => ({
        id: c.rawLabel,
        segments: c.segments.map((s) => ({ start: s.timestampStart, end: s.timestampEnd })),
      }))

      const resultsMap = await speakerIdService.identifyBatch(audioPath, batchInput)

      for (const cluster of unresolvedClusters) {
        const candidates = resultsMap.get(cluster.rawLabel)
        const best = candidates?.[0]
        if (best && best.confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
          const n = transcriptRepo.assignSpeakerByRawIdWithConfidence(
            recordingId,
            cluster.rawLabel,
            best.speakerId,
            best.speakerName,
            best.confidence
          )
          updatedCount += n
          speakerRepo.incrementRecordingCount(best.speakerId)
          console.log(
            `[SpeakerID] ${cluster.rawLabel} → "${best.speakerName}" (${Math.round(best.confidence * 100)}%)`
          )
        }
      }
    }

    // ── NULL-speaker segments (no diarization label at all) ─────────────────
    if (nullSegments.length > 0) {
      const batchInput = nullSegments.map((s) => ({
        id: s.id,
        segments: [{ start: s.timestampStart, end: s.timestampEnd }],
      }))
      const resultsMap = await speakerIdService.identifyBatch(audioPath, batchInput)

      for (const seg of nullSegments) {
        const candidates = resultsMap.get(seg.id)
        const best = candidates?.[0]
        if (best && best.confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
          transcriptRepo.assignSpeakerToSegmentWithConfidence(
            seg.id,
            best.speakerId,
            best.speakerName,
            best.confidence
          )
          updatedCount++
          speakerRepo.incrementRecordingCount(best.speakerId)
          console.log(
            `[SpeakerID] null seg ${seg.id} → "${best.speakerName}" (${Math.round(best.confidence * 100)}%)`
          )
        }
      }
    }

    // Push fresh segments to the renderer so it updates without polling
    if (updatedCount > 0) {
      const segments = transcriptRepo.findByRecordingId(recordingId)
      getWebContents()?.send(IPC.transcript.speakersSwept, { recordingId, segments })
    }

    return updatedCount
  }

  ipcMain.handle(IPC.transcript.get, async (_event, args: GetTranscriptArgs): Promise<GetTranscriptResult> => {
    return { segments: transcriptRepo.findByRecordingId(args.recordingId) }
  })

  ipcMain.handle(IPC.transcript.updateSegment, async (_event, args: UpdateSegmentArgs): Promise<void> => {
    transcriptRepo.updateText(args.segmentId, args.text)
  })

  ipcMain.handle(
    IPC.transcript.assignSpeaker,
    async (_event, args: AssignSpeakerArgs): Promise<AssignSpeakerResult> => {
      // Resolve the speaker profile — prefer explicit profileId over name lookup
      let speaker
      if (args.profileId) {
        speaker = speakerRepo.findById(args.profileId) ?? speakerRepo.create(args.speakerName)
      } else {
        speaker = speakerRepo.findByName(args.speakerName) ?? speakerRepo.create(args.speakerName)
      }

      // Only do a bulk-by-label update when speakerId is a raw diarization label
      // (SPEAKER_00, SPEAKER_01, …). If it's already a resolved profile UUID or null,
      // update just the specific segment.
      const isRawLabel = args.speakerId != null && /^SPEAKER_\d+$/.test(args.speakerId)

      let updated: number
      if (isRawLabel) {
        updated = transcriptRepo.assignSpeakerByRawId(
          args.recordingId, args.speakerId!, speaker.id, speaker.name
        )
        // Count this recording appearance for the speaker (manual confirmation)
        if (updated > 0) {
          speakerRepo.incrementRecordingCount(speaker.id)
        }

        // ── Learn embedding then sweep unresolved clusters — fully async ─────
        // The DB assignment above is already persisted; return to the renderer
        // immediately so the modal closes.
        const recording = recordingRepo.findById(args.recordingId)
        if (updated > 0 && (recording?.audioPath || audio)) {
          void (async () => {
            // Use the persisted audio file when available; fall back to a live snapshot
            let audioPath = recording?.audioPath ?? null
            let isSnapshot = false
            if (!audioPath && audio) {
              const snapshotPath = join(tmpdir(), `vb-snapshot-${args.recordingId}.wav`)
              try {
                audio.saveSnapshot(snapshotPath)
                audioPath = snapshotPath
                isSnapshot = true
              } catch (err) {
                console.warn('[SpeakerID] Could not save audio snapshot:', (err as Error).message)
              }
            }
            if (!audioPath) return
            const timeRanges = transcriptRepo.findTimeRangesForProfile(args.recordingId, speaker.id)
            if (timeRanges.length > 0) {
              try {
                await speakerIdService.learnSpeaker(speaker.id, audioPath, timeRanges)
                console.log(`[SpeakerID] Voice embedding learned for "${speaker.name}" (${timeRanges.length} segment${timeRanges.length !== 1 ? 's' : ''})`)
              } catch (err) {
                console.error('[SpeakerID] learnSpeaker failed (embedding not stored):', (err as Error).message)
                if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
                return // can't sweep without an embedding
              }
            }
            // Sweep after embedding is stored so the new speaker is included in matching
            try {
              await sweepUnresolvedClusters(args.recordingId, audioPath)
            } catch (err) {
              console.warn('[SpeakerID] Cross-cluster sweep failed:', (err as Error).message)
            }
            if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
          })()
        }
      } else {
        transcriptRepo.updateSpeakerForSegment(args.segmentId, speaker.id, speaker.name)
        updated = 1
        // Increment recording count only on the speaker's first appearance in this recording
        const existing = transcriptRepo.findTimeRangesForProfile(args.recordingId, speaker.id)
        if (existing.length === 1) {
          speakerRepo.incrementRecordingCount(speaker.id)
        }
        // Learn embedding then sweep — must not block the IPC response.
        const recording = recordingRepo.findById(args.recordingId)
        if (recording?.audioPath || audio) {
          const segment = transcriptRepo.findByRecordingId(args.recordingId)
            .find((s) => s.id === args.segmentId)
          if (segment) {
            void (async () => {
              let audioPath = recording?.audioPath ?? null
              let isSnapshot = false
              if (!audioPath && audio) {
                const snapshotPath = join(tmpdir(), `vb-snapshot-${args.recordingId}.wav`)
                try {
                  audio.saveSnapshot(snapshotPath)
                  audioPath = snapshotPath
                  isSnapshot = true
                } catch (err) {
                  console.warn('[SpeakerID] Could not save audio snapshot:', (err as Error).message)
                }
              }
              if (!audioPath) return
              try {
                await speakerIdService.learnSpeaker(speaker.id, audioPath, [
                  { start: segment.timestampStart, end: segment.timestampEnd }
                ])
                console.log(`[SpeakerID] Voice embedding learned for "${speaker.name}" (1 segment)`)
              } catch (err) {
                console.error('[SpeakerID] learnSpeaker (single segment) failed (embedding not stored):', (err as Error).message)
                if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
                return
              }
              // Sweep all unresolved clusters now that a new embedding is stored
              try {
                await sweepUnresolvedClusters(args.recordingId, audioPath)
              } catch (err) {
                console.warn('[SpeakerID] Cross-cluster sweep failed:', (err as Error).message)
              }
              if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
            })()
          }
        }
      }

      return { updatedSegments: updated }
    }
  )

  ipcMain.handle(
    IPC.transcript.rankSpeakers,
    async (_event, args: RankSpeakersArgs): Promise<RankSpeakersResult> => {
      const recording = recordingRepo.findById(args.recordingId)

      const segment = transcriptRepo.findByRecordingId(args.recordingId)
        .find((s) => s.id === args.segmentId)
      if (!segment) return { candidates: [] }

      // Speakers manually confirmed elsewhere in this recording (real profile UUID, not SPEAKER_XX)
      const confirmedInRecording = transcriptRepo.findByRecordingId(args.recordingId)
        .filter((s) => s.speakerId && !/^SPEAKER_\d+$/.test(s.speakerId) && s.id !== args.segmentId)
        .reduce((map, s) => {
          if (s.speakerId && !map.has(s.speakerId)) {
            map.set(s.speakerId, s.speakerName ?? s.speakerId)
          }
          return map
        }, new Map<string, string>())

      if (recording?.audioPath) {
        try {
          const all = await speakerIdService.identifyFromAudio(recording.audioPath, [
            { start: segment.timestampStart, end: segment.timestampEnd }
          ])

          const voiceMatchIds = new Set(all.map((c) => c.speakerId))
          const extraCandidates = Array.from(confirmedInRecording.entries())
            .filter(([id]) => !voiceMatchIds.has(id))
            .map(([id, name]) => ({
              speakerId: id,
              speakerName: name,
              confidence: 0,
              isVoiceMatch: false,
            }))

          if (all.length > 0 || extraCandidates.length > 0) {
            return {
              candidates: [
                ...all.map((c) => ({ ...c, isVoiceMatch: true })),
                ...extraCandidates,
              ]
            }
          }
          console.debug('[RankSpeakers] no stored voice embeddings yet — falling back to recent speakers')
        } catch (err) {
          console.error('[RankSpeakers] voice matching failed:', (err as Error).message)
        }
      }

      // No audio file (live recording) or no voice embeddings — show confirmed-in-recording
      // speakers first, then pad with recently-active speakers.
      const recentAll = speakerRepo.findAll().sort((a, b) => b.lastSeenAt - a.lastSeenAt)

      // Confirmed speakers in this recording go first (no voice score, but user already knows them)
      const confirmedCandidates = Array.from(confirmedInRecording.entries()).map(([id, name]) => ({
        speakerId: id,
        speakerName: name,
        confidence: 0,
        isVoiceMatch: false,
      }))
      const confirmedIds = new Set(confirmedInRecording.keys())

      // Fill remaining slots from recent speakers not already in the confirmed list
      const recentCandidates = recentAll
        .filter((s) => !confirmedIds.has(s.id))
        .slice(0, Math.max(0, 5 - confirmedCandidates.length))
        .map((s) => ({ speakerId: s.id, speakerName: s.name, confidence: 0, isVoiceMatch: false }))

      return { candidates: [...confirmedCandidates, ...recentCandidates] }
    }
  )

  ipcMain.handle(
    IPC.transcript.sweepSpeakers,
    async (_event, args: SweepSpeakersArgs): Promise<SweepSpeakersResult> => {
      const recording = recordingRepo.findById(args.recordingId)
      if (!recording?.audioPath) return { updatedCount: 0 }
      try {
        const updatedCount = await sweepUnresolvedClusters(args.recordingId, recording.audioPath)
        return { updatedCount }
      } catch (err) {
        console.warn('[SweepSpeakers] sweep failed:', (err as Error).message)
        return { updatedCount: 0 }
      }
    }
  )
}
