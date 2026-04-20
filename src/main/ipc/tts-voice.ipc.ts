import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  GetTtsVoicesResult,
  GetTtsVoiceArgs,
  GetTtsVoiceResult,
  CreateTtsVoiceArgs,
  CreateTtsVoiceResult,
  RenameTtsVoiceArgs,
  RenameTtsVoiceResult,
  DeleteTtsVoiceArgs,
  GetTtsVoiceSamplesArgs,
  GetTtsVoiceSamplesResult,
  AddTtsVoiceSampleArgs,
  AddTtsVoiceSampleResult,
  AddTtsVoiceSampleFromRecordingArgs,
  AddTtsVoiceSamplesFromSpeakerArgs,
  AddTtsVoiceSamplesFromSpeakerResult,
  DeleteTtsVoiceSampleArgs,
  Qwen3ModelStatusResult,
  TtsSynthesizeArgs,
  TtsSynthesizeResult,
  TtsDownloadProgressPayload,
  TtsVoiceCreationProgressPayload,
} from '@shared/ipc-types'
import type { TtsVoiceRepository } from '../services/storage/repositories/TtsVoiceRepository'
import type { TTSCloningService } from '../services/audio/TTSCloningService'
import type { WebContents } from 'electron'

interface TtsVoiceIpcDeps {
  ttsVoiceRepo: TtsVoiceRepository
  ttsCloningService: TTSCloningService
  getWebContents: () => WebContents | null
}

export function registerTtsVoiceIpc(deps: TtsVoiceIpcDeps): void {
  const { ttsVoiceRepo, ttsCloningService, getWebContents } = deps

  // Forward download progress events to the renderer
  ttsCloningService.on('download:progress', (payload: TtsDownloadProgressPayload) => {
    getWebContents()?.send(IPC.ttsVoice.downloadProgress, payload)
  })

  // Forward voice-creation progress events to the renderer
  ttsCloningService.on('voice-creation:progress', (payload: TtsVoiceCreationProgressPayload) => {
    getWebContents()?.send(IPC.ttsVoice.voiceCreationProgress, payload)
  })

  // ─── Voice CRUD ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.ttsVoice.getAll, async (): Promise<GetTtsVoicesResult> => {
    return { voices: ttsVoiceRepo.findAll() }
  })

  ipcMain.handle(IPC.ttsVoice.get, async (_event, args: GetTtsVoiceArgs): Promise<GetTtsVoiceResult> => {
    return { voice: ttsVoiceRepo.findById(args.voiceId) }
  })

  ipcMain.handle(IPC.ttsVoice.create, async (_event, args: CreateTtsVoiceArgs): Promise<CreateTtsVoiceResult> => {
    const voice = ttsVoiceRepo.create(args.name, args.description, args.voiceDesignPrompt)
    return { voice }
  })

  ipcMain.handle(IPC.ttsVoice.rename, async (_event, args: RenameTtsVoiceArgs): Promise<RenameTtsVoiceResult> => {
    const voice = ttsVoiceRepo.update(args.voiceId, args.name, args.description, args.voiceDesignPrompt)
    return { voice }
  })

  ipcMain.handle(IPC.ttsVoice.delete, async (_event, args: DeleteTtsVoiceArgs): Promise<void> => {
    ttsVoiceRepo.delete(args.voiceId)
  })

  // ─── Samples ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.ttsVoice.getSamples, async (_event, args: GetTtsVoiceSamplesArgs): Promise<GetTtsVoiceSamplesResult> => {
    return { samples: ttsVoiceRepo.findSamplesByVoiceId(args.voiceId) }
  })

  ipcMain.handle(IPC.ttsVoice.addSample, async (_event, args: AddTtsVoiceSampleArgs): Promise<AddTtsVoiceSampleResult> => {
    const sample = await ttsCloningService.addSampleFromFile(args.voiceId, {
      filePath: args.filePath,
      transcript: args.transcript,
    })
    return { sample }
  })

  ipcMain.handle(
    IPC.ttsVoice.addSampleFromRecording,
    async (_event, args: AddTtsVoiceSampleFromRecordingArgs): Promise<AddTtsVoiceSampleResult> => {
      const sample = await ttsCloningService.addSampleFromRecording(args.voiceId, args.recordingId, {
        startSec: args.startSec,
        endSec: args.endSec,
        transcript: args.transcript,
      })
      return { sample }
    }
  )

  ipcMain.handle(IPC.ttsVoice.deleteSample, async (_event, args: DeleteTtsVoiceSampleArgs): Promise<void> => {
    ttsVoiceRepo.deleteSample(args.sampleId)
  })

  ipcMain.handle(
    IPC.ttsVoice.addSamplesFromSpeaker,
    async (_event, args: AddTtsVoiceSamplesFromSpeakerArgs): Promise<AddTtsVoiceSamplesFromSpeakerResult> => {
      try {
        const samples = await ttsCloningService.addSamplesFromSpeaker(args.voiceId, args.speakerId)
        return { addedCount: samples.length, samples }
      } catch (err) {
        getWebContents()?.send(IPC.ttsVoice.voiceCreationProgress, {
          voiceId: args.voiceId,
          percent: 0,
          message: (err as Error).message,
          done: true,
          error: (err as Error).message,
        } satisfies TtsVoiceCreationProgressPayload)
        throw err
      }
    }
  )

  // ─── Model management ────────────────────────────────────────────────────

  ipcMain.handle(IPC.ttsVoice.modelStatus, async (): Promise<Qwen3ModelStatusResult> => {
    const status = await ttsCloningService.checkModelStatus()
    return { status }
  })

  ipcMain.handle(IPC.ttsVoice.downloadModel, async (): Promise<Qwen3ModelStatusResult> => {
    await ttsCloningService.downloadModel()
    return { status: ttsCloningService.modelStatus }
  })

  // ─── Synthesis ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.ttsVoice.synthesize, async (_event, args: TtsSynthesizeArgs): Promise<TtsSynthesizeResult> => {
    const audioPath = await ttsCloningService.synthesize(args.voiceId, args.text, args.sampleId)
    return { audioPath }
  })
}
