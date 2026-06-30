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
  SweepSpeakersResult,
  CleanHallucinationsArgs,
  CleanHallucinationsResult
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
   * Re-evaluate segments that were auto-assigned below the high-confidence
   * threshold. Safe to call concurrently with sweepUnresolvedClusters because
   * it only upgrades (strictly-better guard) and never calls
   * speakerRepo.incrementRecordingCount, so duplicate runs are idempotent.
   *
   * Called standalone after every new embedding is learned so that segments
   * don't stay pinned to a lower-confidence speaker even when the main cluster
   * sweep is already running (and would be skipped by the mutex).
   */
  async function reEvaluateBelowThreshold(recordingId: string, audioPath: string): Promise<number> {
    const expectedSpeakerIds = recordingRepo.getExpectedSpeakerIds(recordingId)
    const speakerFilter = expectedSpeakerIds.length > 0 ? expectedSpeakerIds : undefined

    const belowThreshold = transcriptRepo.findBelowThresholdAssignedSegments(
      recordingId, AUTO_APPLY_CONFIDENCE_THRESHOLD
    )
    if (belowThreshold.length === 0) return 0

    const batchInput = belowThreshold.map((s) => ({
      id: s.id,
      segments: [{ start: s.timestampStart, end: s.timestampEnd }],
    }))
    const resultsMap = await speakerIdService.identifyBatch(audioPath, batchInput, speakerFilter)

    let upgradedCount = 0
    for (const seg of belowThreshold) {
      const candidates = resultsMap.get(seg.id)
      const best = candidates?.[0]
      if (!best) continue
      if (!speakerFilter?.length && best.confidence < AUTO_APPLY_CONFIDENCE_THRESHOLD) continue
      if (best.confidence <= seg.currentConfidence) continue
      transcriptRepo.assignSpeakerToSegmentWithConfidence(
        seg.id, best.speakerId, best.speakerName, best.confidence
      )
      upgradedCount++
      console.log(
        `[SpeakerID] Borderline upgrade: seg ${seg.id} → "${best.speakerName}" ${Math.round(seg.currentConfidence * 100)}% → ${Math.round(best.confidence * 100)}%`
      )
    }

    if (upgradedCount > 0) {
      const segments = transcriptRepo.findByRecordingId(recordingId)
      getWebContents()?.send(IPC.transcript.speakersSwept, { recordingId, segments })
    }

    return upgradedCount
  }

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
    // Load expected speakers for this recording (empty = match all)
    const expectedSpeakerIds = recordingRepo.getExpectedSpeakerIds(recordingId)
    const speakerFilter = expectedSpeakerIds.length > 0 ? expectedSpeakerIds : undefined

    let updatedCount = 0

    // ── SPEAKER_XX clusters (from diarization) ──────────────────────────────
    const unresolvedClusters = transcriptRepo.findUnresolvedSpeakerClusters(recordingId)
    if (unresolvedClusters.length > 0) {
      const batchInput = unresolvedClusters.map((c) => ({
        id: c.rawLabel,
        segments: c.segments.map((s) => ({ start: s.timestampStart, end: s.timestampEnd })),
      }))

      const resultsMap = await speakerIdService.identifyBatch(audioPath, batchInput, speakerFilter)

      for (const cluster of unresolvedClusters) {
        const candidates = resultsMap.get(cluster.rawLabel)
        const best = candidates?.[0]
        if (best && best.confidence >= (speakerFilter?.length ? 0.55 : AUTO_APPLY_CONFIDENCE_THRESHOLD)) {
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
    const nullSegments = transcriptRepo.findNullSpeakerSegments(recordingId)
    if (nullSegments.length > 0) {
      const batchInput = nullSegments.map((s) => ({
        id: s.id,
        segments: [{ start: s.timestampStart, end: s.timestampEnd }],
      }))
      const resultsMap = await speakerIdService.identifyBatch(audioPath, batchInput, speakerFilter)

      for (const seg of nullSegments) {
        const candidates = resultsMap.get(seg.id)
        const best = candidates?.[0]
        if (best && best.confidence >= (speakerFilter?.length ? 0.55 : AUTO_APPLY_CONFIDENCE_THRESHOLD)) {
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

    if (updatedCount > 0) {
      const segments = transcriptRepo.findByRecordingId(recordingId)
      getWebContents()?.send(IPC.transcript.speakersSwept, { recordingId, segments })
    }

    // ── Borderline re-evaluation (always — not gated on unresolved clusters) ─
    // This is extracted so the assignSpeaker handler can call it directly
    // after every new embedding, bypassing the sweep mutex.
    updatedCount += await reEvaluateBelowThreshold(recordingId, audioPath)

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

      // If this recording already has a constrained expected-speakers list, add the
      // newly resolved speaker to it so future sweeps include them.
      const existingExpected = recordingRepo.getExpectedSpeakerIds(args.recordingId)
      if (existingExpected.length > 0) {
        recordingRepo.addExpectedSpeaker(args.recordingId, speaker.id)
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
            // Always re-evaluate borderline segments after a new embedding — runs
            // even if sweepUnresolvedClusters was skipped by the mutex.
            try {
              await reEvaluateBelowThreshold(args.recordingId, audioPath)
            } catch (err) {
              console.warn('[SpeakerID] Borderline re-evaluation failed:', (err as Error).message)
            }
            if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
          })()
        }
      } else {
        // Check for a diarization cluster label — if this segment was stamped by
        // diarization, bulk-assign the whole cluster so all SPEAKER_00 siblings
        // get the correction, not just the one the user clicked.
        const diarizationLabel = transcriptRepo.getDiarizationLabel(args.segmentId)
        const isFirstAppearance = transcriptRepo.findTimeRangesForProfile(args.recordingId, speaker.id).length === 0
        if (diarizationLabel) {
          updated = transcriptRepo.assignSpeakerByDiarizationCluster(
            args.recordingId, diarizationLabel, speaker.id, speaker.name
          )
          console.log(
            `[SpeakerID] Cluster ${diarizationLabel} → "${speaker.name}" (${updated} segment${updated !== 1 ? 's' : ''})`
          )
        } else {
          transcriptRepo.updateSpeakerForSegment(args.segmentId, speaker.id, speaker.name)
          updated = 1
        }
        // Increment recording count only on the speaker's first appearance in this recording
        if (isFirstAppearance && updated > 0) {
          speakerRepo.incrementRecordingCount(speaker.id)
        }
        // Learn embedding then sweep — must not block the IPC response.
        const recording = recordingRepo.findById(args.recordingId)
        if (updated > 0 && (recording?.audioPath || audio)) {
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
            // Learn from all confirmed time ranges (cluster assignment may have
            // added several segments; use them all for a richer embedding).
            const timeRanges = transcriptRepo.findTimeRangesForProfile(args.recordingId, speaker.id)
            if (timeRanges.length > 0) {
              try {
                await speakerIdService.learnSpeaker(speaker.id, audioPath, timeRanges)
                console.log(`[SpeakerID] Voice embedding learned for "${speaker.name}" (${timeRanges.length} segment${timeRanges.length !== 1 ? 's' : ''})`)
              } catch (err) {
                console.error('[SpeakerID] learnSpeaker failed (embedding not stored):', (err as Error).message)
                if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
                return
              }
            }
            // Sweep unresolved clusters + borderline segments with the updated embedding
            try {
              await sweepUnresolvedClusters(args.recordingId, audioPath)
            } catch (err) {
              console.warn('[SpeakerID] Cross-cluster sweep failed:', (err as Error).message)
            }
            // Always re-evaluate borderline segments after a new embedding — runs
            // even if sweepUnresolvedClusters was skipped by the mutex.
            try {
              await reEvaluateBelowThreshold(args.recordingId, audioPath)
            } catch (err) {
              console.warn('[SpeakerID] Borderline re-evaluation failed:', (err as Error).message)
            }
            if (isSnapshot) try { unlinkSync(audioPath) } catch { /* ignore */ }
          })()
        }
      }

      // Immediately push the updated segment list to the renderer so
      // RecordingSpeakersBar refreshes allSpeakers (picks up newly created
      // profiles) and expectedIds (picks up addExpectedSpeaker above) without
      // having to wait for the background sweep to finish.
      const freshSegments = transcriptRepo.findByRecordingId(args.recordingId)
      getWebContents()?.send(IPC.transcript.speakersSwept, { recordingId: args.recordingId, segments: freshSegments })

      return { updatedSegments: updated }
    }
  )

  ipcMain.handle(
    IPC.transcript.rankSpeakers,
    async (_event, args: RankSpeakersArgs): Promise<RankSpeakersResult> => {
      const recording = recordingRepo.findById(args.recordingId)

      // Load expected speakers for this recording
      const expectedSpeakerIds = recordingRepo.getExpectedSpeakerIds(args.recordingId)
      const speakerFilter = expectedSpeakerIds.length > 0 ? expectedSpeakerIds : undefined

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
          ], speakerFilter)

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
    IPC.transcript.cleanHallucinations,
    (_event, args: CleanHallucinationsArgs): CleanHallucinationsResult => {
      const removedCount = transcriptRepo.deleteHallucinatedSegments(args.recordingId)
      const segments = transcriptRepo.findByRecordingId(args.recordingId)
      if (removedCount > 0) {
        getWebContents()?.send(IPC.transcript.speakersSwept, { recordingId: args.recordingId, segments })
      }
      return { removedCount, segments }
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
