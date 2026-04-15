import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  GetSpeakersResult,
  GetSpeakerArgs,
  GetSpeakerResult,
  RenameSpeakerArgs,
  DeleteSpeakerArgs,
  MergeSpeakersArgs,
  UpdateSpeakerNotesArgs,
  ResetVoiceArgs
} from '@shared/ipc-types'
import type { SpeakerRepository } from '../services/storage/repositories/SpeakerRepository'

interface SpeakerIpcDeps {
  speakerRepo: SpeakerRepository
}

export function registerSpeakerIpc(deps: SpeakerIpcDeps): void {
  const { speakerRepo } = deps

  ipcMain.handle(IPC.speaker.getAll, async (): Promise<GetSpeakersResult> => {
    return { speakers: speakerRepo.findAll() }
  })

  ipcMain.handle(IPC.speaker.get, async (_event, args: GetSpeakerArgs): Promise<GetSpeakerResult> => {
    return { speaker: speakerRepo.findById(args.speakerId) }
  })

  ipcMain.handle(IPC.speaker.rename, async (_event, args: RenameSpeakerArgs): Promise<GetSpeakerResult> => {
    const speaker = speakerRepo.rename(args.speakerId, args.name)
    return { speaker }
  })

  ipcMain.handle(IPC.speaker.delete, async (_event, args: DeleteSpeakerArgs): Promise<void> => {
    speakerRepo.delete(args.speakerId)
  })

  ipcMain.handle(IPC.speaker.merge, async (_event, args: MergeSpeakersArgs): Promise<void> => {
    speakerRepo.merge(args.sourceId, args.targetId)
  })

  ipcMain.handle(IPC.speaker.updateNotes, async (_event, args: UpdateSpeakerNotesArgs): Promise<GetSpeakerResult> => {
    const speaker = speakerRepo.updateNotes(args.speakerId, args.notes)
    return { speaker }
  })

  ipcMain.handle(IPC.speaker.resetVoice, async (_event, args: ResetVoiceArgs): Promise<GetSpeakerResult> => {
    speakerRepo.resetVoiceEmbedding(args.speakerId)
    return { speaker: speakerRepo.findById(args.speakerId) }
  })
}
