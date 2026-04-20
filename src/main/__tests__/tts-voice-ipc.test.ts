/**
 * tts-voice.ipc.ts handler tests
 *
 * Strategy: capture ipcMain.handle calls via the test-setup mock, then invoke
 * the captured handlers directly — no real Electron process needed.
 *
 * Handlers covered:
 *   ttsVoice.getAll              — returns all voices from repo
 *   ttsVoice.get                 — returns single voice or null
 *   ttsVoice.create              — creates voice and returns it
 *   ttsVoice.rename              — updates voice name/description
 *   ttsVoice.delete              — deletes voice
 *   ttsVoice.getSamples          — returns samples for a voice
 *   ttsVoice.addSample           — delegates to TTSCloningService.addSampleFromFile
 *   ttsVoice.addSampleFromRecording — delegates to TTSCloningService.addSampleFromRecording
 *   ttsVoice.deleteSample        — deletes a sample from repo
 *   ttsVoice.modelStatus         — queries model status via service
 *   ttsVoice.downloadModel       — triggers download, returns status
 *   ttsVoice.synthesize          — delegates synthesis to service, returns audioPath
 *   download:progress forwarding — forwards service events to renderer via webContents.send
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { EventEmitter } from 'events'
import { IPC } from '@shared/ipc-types'
import { registerTtsVoiceIpc } from '@main/ipc/tts-voice.ipc'
import type { IpcMainInvokeEvent } from 'electron'
import type { TtsVoiceRepository } from '@main/services/storage/repositories/TtsVoiceRepository'
import type { TTSCloningService } from '@main/services/audio/TTSCloningService'
import type { TtsVoice, TtsVoiceSample } from '@shared/types'

const evt = {} as IpcMainInvokeEvent

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeVoice(overrides?: Partial<TtsVoice>): TtsVoice {
  return {
    id: 'voice-uuid-1',
    name: 'Alice',
    description: null,
    voiceDesignPrompt: null,
    sampleCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makeSample(overrides?: Partial<TtsVoiceSample>): TtsVoiceSample {
  return {
    id: 'sample-uuid-1',
    voiceId: 'voice-uuid-1',
    audioPath: '/tts-samples/voice-uuid-1/clip.wav',
    transcript: 'Hello world',
    durationSec: 5.0,
    sourceRecordingId: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function captureHandlers() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
    handlers[channel as string] = handler as (...args: unknown[]) => unknown
    return ipcMain
  })
  return handlers
}

// ─── mock deps ───────────────────────────────────────────────────────────────

class FakeEventEmitter extends EventEmitter {}

function makeDeps(overrides: {
  repoFindAll?: ReturnType<typeof vi.fn>
  repoFindById?: ReturnType<typeof vi.fn>
  repoCreate?: ReturnType<typeof vi.fn>
  repoUpdate?: ReturnType<typeof vi.fn>
  repoDelete?: ReturnType<typeof vi.fn>
  repoFindSamples?: ReturnType<typeof vi.fn>
  repoDeleteSample?: ReturnType<typeof vi.fn>
  serviceCheckModelStatus?: ReturnType<typeof vi.fn>
  serviceDownloadModel?: ReturnType<typeof vi.fn>
  serviceSynthesize?: ReturnType<typeof vi.fn>
  serviceAddSampleFromFile?: ReturnType<typeof vi.fn>
  serviceAddSampleFromRecording?: ReturnType<typeof vi.fn>
  serviceAddSamplesFromSpeaker?: ReturnType<typeof vi.fn>
  modelStatus?: string
  webContents?: { send: ReturnType<typeof vi.fn> } | null
} = {}) {
  const send = overrides.webContents?.send ?? vi.fn()
  const emitter = new FakeEventEmitter()

  const ttsVoiceRepo = {
    findAll: overrides.repoFindAll ?? vi.fn(() => [makeVoice()]),
    findById: overrides.repoFindById ?? vi.fn(() => makeVoice()),
    create: overrides.repoCreate ?? vi.fn(() => makeVoice()),
    update: overrides.repoUpdate ?? vi.fn(() => makeVoice()),
    delete: overrides.repoDelete ?? vi.fn(),
    findSamplesByVoiceId: overrides.repoFindSamples ?? vi.fn(() => [makeSample()]),
    deleteSample: overrides.repoDeleteSample ?? vi.fn(),
  } as unknown as TtsVoiceRepository

  const ttsCloningService = Object.assign(emitter, {
    modelStatus: (overrides.modelStatus ?? 'not_downloaded') as any,
    checkModelStatus: overrides.serviceCheckModelStatus ?? vi.fn(async () => 'not_downloaded'),
    downloadModel: overrides.serviceDownloadModel ?? vi.fn(async () => undefined),
    synthesize: overrides.serviceSynthesize ?? vi.fn(async () => '/out/synth.wav'),
    addSampleFromFile: overrides.serviceAddSampleFromFile ?? vi.fn(async () => makeSample()),
    addSampleFromRecording:
      overrides.serviceAddSampleFromRecording ?? vi.fn(async () => makeSample()),
    addSamplesFromSpeaker:
      overrides.serviceAddSamplesFromSpeaker ?? vi.fn(async () => [makeSample()]),
  }) as unknown as TTSCloningService

  return {
    ttsVoiceRepo,
    ttsCloningService,
    getWebContents: () => (overrides.webContents === null ? null : ({ send } as any)),
    send,
    emitter,
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('tts-voice IPC handlers', () => {
  // ─── Voice CRUD ─────────────────────────────────────────────────────────

  describe('IPC.ttsVoice.getAll', () => {
    it('returns all voices from repo', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.getAll](evt)
      expect(result).toEqual({ voices: [makeVoice()] })
    })
  })

  describe('IPC.ttsVoice.get', () => {
    it('returns the voice by id', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.get](evt, { voiceId: 'voice-uuid-1' })
      expect(result).toEqual({ voice: makeVoice() })
      expect(deps.ttsVoiceRepo.findById).toHaveBeenCalledWith('voice-uuid-1')
    })

    it('returns { voice: null } when repo returns null', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps({ repoFindById: vi.fn(() => null) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.get](evt, { voiceId: 'missing' })
      expect(result).toEqual({ voice: null })
    })
  })

  describe('IPC.ttsVoice.create', () => {
    it('calls repo.create and returns the voice', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const voice = makeVoice({ name: 'NewVoice' })
      const deps = makeDeps({ repoCreate: vi.fn(() => voice) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.create](evt, { name: 'NewVoice' })
      expect(result).toEqual({ voice })
      expect(deps.ttsVoiceRepo.create).toHaveBeenCalledWith('NewVoice', undefined, undefined)
    })

    it('passes description when provided', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      await handlers[IPC.ttsVoice.create](evt, { name: 'V', description: 'Sales' })
      expect(deps.ttsVoiceRepo.create).toHaveBeenCalledWith('V', 'Sales', undefined)
    })

    it('passes voiceDesignPrompt when provided', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      await handlers[IPC.ttsVoice.create](evt, {
        name: 'V',
        description: 'Sales',
        voiceDesignPrompt: 'A warm male voice',
      })
      expect(deps.ttsVoiceRepo.create).toHaveBeenCalledWith('V', 'Sales', 'A warm male voice')
    })
  })

  describe('IPC.ttsVoice.rename', () => {
    it('calls repo.update and returns the voice', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const renamed = makeVoice({ name: 'Renamed' })
      const deps = makeDeps({ repoUpdate: vi.fn(() => renamed) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.rename](evt, {
        voiceId: 'voice-uuid-1',
        name: 'Renamed',
      })
      expect(result).toEqual({ voice: renamed })
      expect(deps.ttsVoiceRepo.update).toHaveBeenCalledWith('voice-uuid-1', 'Renamed', undefined, undefined)
    })

    it('passes voiceDesignPrompt to repo.update when provided', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      await handlers[IPC.ttsVoice.rename](evt, {
        voiceId: 'voice-uuid-1',
        name: 'Renamed',
        description: 'Updated desc',
        voiceDesignPrompt: 'A bright female voice',
      })
      expect(deps.ttsVoiceRepo.update).toHaveBeenCalledWith(
        'voice-uuid-1',
        'Renamed',
        'Updated desc',
        'A bright female voice',
      )
    })
  })

  describe('IPC.ttsVoice.delete', () => {
    it('calls repo.delete', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      await handlers[IPC.ttsVoice.delete](evt, { voiceId: 'voice-uuid-1' })
      expect(deps.ttsVoiceRepo.delete).toHaveBeenCalledWith('voice-uuid-1')
    })
  })

  // ─── Samples ─────────────────────────────────────────────────────────────

  describe('IPC.ttsVoice.getSamples', () => {
    it('returns samples from repo', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.getSamples](evt, { voiceId: 'voice-uuid-1' })
      expect(result).toEqual({ samples: [makeSample()] })
    })
  })

  describe('IPC.ttsVoice.addSample', () => {
    it('delegates to ttsCloningService.addSampleFromFile and returns sample', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const sample = makeSample()
      const deps = makeDeps({ serviceAddSampleFromFile: vi.fn(async () => sample) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.addSample](evt, {
        voiceId: 'voice-uuid-1',
        filePath: '/path/to/audio.wav',
        transcript: 'Test',
      })
      expect(result).toEqual({ sample })
      expect(deps.ttsCloningService.addSampleFromFile).toHaveBeenCalledWith('voice-uuid-1', {
        filePath: '/path/to/audio.wav',
        transcript: 'Test',
      })
    })
  })

  describe('IPC.ttsVoice.addSampleFromRecording', () => {
    it('delegates to ttsCloningService.addSampleFromRecording', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const sample = makeSample()
      const deps = makeDeps({ serviceAddSampleFromRecording: vi.fn(async () => sample) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.addSampleFromRecording](evt, {
        voiceId: 'voice-uuid-1',
        recordingId: 'rec-abc',
        startSec: 10,
        endSec: 20,
        transcript: 'Segment text',
      })
      expect(result).toEqual({ sample })
      expect(deps.ttsCloningService.addSampleFromRecording).toHaveBeenCalledWith(
        'voice-uuid-1',
        'rec-abc',
        { startSec: 10, endSec: 20, transcript: 'Segment text' }
      )
    })
  })

  describe('IPC.ttsVoice.deleteSample', () => {
    it('calls repo.deleteSample', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      await handlers[IPC.ttsVoice.deleteSample](evt, { sampleId: 'sample-uuid-1' })
      expect(deps.ttsVoiceRepo.deleteSample).toHaveBeenCalledWith('sample-uuid-1')
    })
  })

  describe('IPC.ttsVoice.addSamplesFromSpeaker', () => {
    it('delegates to ttsCloningService.addSamplesFromSpeaker and returns samples', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const samples = [makeSample(), makeSample({ id: 'sample-uuid-2' })]
      const deps = makeDeps({ serviceAddSamplesFromSpeaker: vi.fn(async () => samples) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.addSamplesFromSpeaker](evt, {
        voiceId: 'voice-uuid-1',
        speakerId: 'speaker-abc',
      })
      expect(result).toEqual({ addedCount: 2, samples })
      expect(deps.ttsCloningService.addSamplesFromSpeaker).toHaveBeenCalledWith(
        'voice-uuid-1',
        'speaker-abc',
      )
    })

    it('returns addedCount 0 when no samples extracted', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps({ serviceAddSamplesFromSpeaker: vi.fn(async () => []) })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.addSamplesFromSpeaker](evt, {
        voiceId: 'voice-uuid-1',
        speakerId: 'speaker-abc',
      })
      expect(result).toEqual({ addedCount: 0, samples: [] })
    })
  })

  // ─── Model lifecycle ──────────────────────────────────────────────────────

  describe('IPC.ttsVoice.modelStatus', () => {
    it('returns the current model status', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps({
        serviceCheckModelStatus: vi.fn(async () => 'ready'),
      })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.modelStatus](evt)
      expect(result).toEqual({ status: 'ready' })
    })
  })

  describe('IPC.ttsVoice.downloadModel', () => {
    it('triggers download and returns status', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps({
        serviceDownloadModel: vi.fn(async () => undefined),
        modelStatus: 'ready',
      })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.downloadModel](evt)
      expect(deps.ttsCloningService.downloadModel).toHaveBeenCalledOnce()
      expect(result).toEqual({ status: 'ready' })
    })
  })

  // ─── Synthesis ────────────────────────────────────────────────────────────

  describe('IPC.ttsVoice.synthesize', () => {
    it('returns audioPath from ttsCloningService.synthesize', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps({
        serviceSynthesize: vi.fn(async () => '/out/synth-abc.wav'),
      })
      registerTtsVoiceIpc(deps)

      const result = await handlers[IPC.ttsVoice.synthesize](evt, {
        voiceId: 'voice-uuid-1',
        text: 'Hello there',
      })
      expect(result).toEqual({ audioPath: '/out/synth-abc.wav' })
      expect(deps.ttsCloningService.synthesize).toHaveBeenCalledWith(
        'voice-uuid-1',
        'Hello there',
        undefined
      )
    })

    it('passes sampleId when provided', async () => {
      vi.clearAllMocks()
      const handlers = captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      await handlers[IPC.ttsVoice.synthesize](evt, {
        voiceId: 'voice-uuid-1',
        text: 'Test',
        sampleId: 'sample-uuid-1',
      })
      expect(deps.ttsCloningService.synthesize).toHaveBeenCalledWith(
        'voice-uuid-1',
        'Test',
        'sample-uuid-1'
      )
    })
  })

  // ─── download:progress forwarding ────────────────────────────────────────

  describe('download:progress event forwarding', () => {
    it('forwards progress events to renderer via webContents.send', () => {
      vi.clearAllMocks()
      captureHandlers()
      const deps = makeDeps()
      registerTtsVoiceIpc(deps)

      deps.emitter.emit('download:progress', { progress: 42, status: 'downloading' })
      expect(deps.send).toHaveBeenCalledWith(IPC.ttsVoice.downloadProgress, {
        progress: 42,
        status: 'downloading',
      })
    })

    it('does not throw when getWebContents() returns null', () => {
      vi.clearAllMocks()
      captureHandlers()
      const deps = makeDeps({ webContents: null })
      registerTtsVoiceIpc(deps)

      expect(() =>
        deps.emitter.emit('download:progress', { progress: 10, status: 'downloading' })
      ).not.toThrow()
    })
  })
})
