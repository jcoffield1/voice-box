import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  GetTranscriptArgs,
  GetTranscriptResult,
  UpdateSegmentArgs,
  AssignSpeakerArgs,
  AssignSpeakerResult
} from '@shared/ipc-types'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { SpeakerRepository } from '../services/storage/repositories/SpeakerRepository'

interface TranscriptIpcDeps {
  transcriptRepo: TranscriptRepository
  speakerRepo: SpeakerRepository
}

export function registerTranscriptIpc(deps: TranscriptIpcDeps): void {
  const { transcriptRepo, speakerRepo } = deps

  ipcMain.handle(IPC.transcript.get, async (_event, args: GetTranscriptArgs): Promise<GetTranscriptResult> => {
    return { segments: transcriptRepo.findByRecordingId(args.recordingId) }
  })

  ipcMain.handle(IPC.transcript.updateSegment, async (_event, args: UpdateSegmentArgs): Promise<void> => {
    transcriptRepo.updateText(args.segmentId, args.text)
  })

  ipcMain.handle(
    IPC.transcript.assignSpeaker,
    async (_event, args: AssignSpeakerArgs): Promise<AssignSpeakerResult> => {
      // Ensure speaker profile exists — look up by name first (speakerId is a
      // raw diarization label like SPEAKER_00, not a profile UUID)
      const speaker = speakerRepo.findByName(args.speakerName) ?? speakerRepo.create(args.speakerName)

      // If speakerId is null/empty, no diarization ran — assign to all un-labelled segments
      const updated = args.speakerId
        ? transcriptRepo.assignSpeakerByRawId(args.recordingId, args.speakerId, speaker.id, args.speakerName)
        : transcriptRepo.assignSpeakerToNullSegments(args.recordingId, speaker.id, args.speakerName)

      return { updatedSegments: updated }
    }
  )
}
