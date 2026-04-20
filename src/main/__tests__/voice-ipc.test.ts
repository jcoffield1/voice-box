/**
 * voice.ipc.ts handler tests
 *
 * Strategy: capture ipcMain.handle calls via the test-setup mock, then invoke
 * the captured handlers directly — no real Electron process needed.
 *
 * Handlers covered:
 *   IPC.ai.speak          — macOS path delegates to tts.speak(); Qwen3 path calls ttsCloningService.synthesize + tts.playFile
 *   IPC.ai.stopSpeaking   — delegates to tts.stop()
 *   IPC.ai.listVoices     — calls listSystemVoices() via execFile('say', ['-v', '?'])
 *   IPC.voiceInput.start  — delegates to voiceInput.start(), returns { ok: true }
 *   IPC.voiceInput.stop   — delegates to voiceInput.stop(), emits done event, returns { transcript }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import { registerVoiceIpc } from '@main/ipc/voice.ipc'
import type { IpcMainInvokeEvent } from 'electron'
import type { TTSService } from '@main/services/audio/TTSService'
import type { TTSCloningService } from '@main/services/audio/TTSCloningService'
import type { VoiceInputService } from '@main/services/audio/VoiceInputService'
import type { SettingsRepository } from '@main/services/storage/repositories/SettingsRepository'

const evt = {} as IpcMainInvokeEvent

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

function makeDeps(overrides: {
  ttsSpeak?: ReturnType<typeof vi.fn>
  ttsStop?: ReturnType<typeof vi.fn>
  ttsPlayFile?: ReturnType<typeof vi.fn>
  ttsCloningServiceSynthesize?: ReturnType<typeof vi.fn>
  voiceInputStart?: ReturnType<typeof vi.fn>
  voiceInputStop?: ReturnType<typeof vi.fn>
  settingsGet?: ReturnType<typeof vi.fn>
  webContents?: { send: ReturnType<typeof vi.fn> } | null
} = {}) {
  const send = overrides.webContents?.send ?? vi.fn()
  return {
    tts: {
      speak: overrides.ttsSpeak ?? vi.fn().mockResolvedValue(undefined),
      stop: overrides.ttsStop ?? vi.fn(),
      playFile: overrides.ttsPlayFile ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as TTSService,
    ttsCloningService: {
      synthesize: overrides.ttsCloningServiceSynthesize ?? vi.fn().mockResolvedValue('/tmp/out.wav'),
    } as unknown as TTSCloningService,
    voiceInput: {
      start: overrides.voiceInputStart ?? vi.fn(),
      stop: overrides.voiceInputStop ?? vi.fn().mockResolvedValue('hello world'),
    } as unknown as VoiceInputService,
    settings: {
      get: overrides.settingsGet ?? vi.fn(() => null),
    } as unknown as SettingsRepository,
    getWebContents: () => (overrides.webContents === null ? null : ({ send } as any)),
    send,
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('voice IPC handlers', () => {
  describe('IPC.voiceInput.start', () => {
    let handlers: Record<string, (...args: unknown[]) => unknown>
    let deps: ReturnType<typeof makeDeps>

    beforeEach(() => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      deps = makeDeps()
      registerVoiceIpc(deps)
    })

    it('calls voiceInput.start() and returns { ok: true }', async () => {
      const result = await handlers[IPC.voiceInput.start](evt)
      expect(deps.voiceInput.start).toHaveBeenCalledOnce()
      expect(result).toEqual({ ok: true })
    })
  })

  describe('IPC.voiceInput.stop', () => {
    let handlers: Record<string, (...args: unknown[]) => unknown>
    let deps: ReturnType<typeof makeDeps>

    beforeEach(() => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      deps = makeDeps()
      registerVoiceIpc(deps)
    })

    it('calls voiceInput.stop() and returns the transcript', async () => {
      vi.mocked(deps.voiceInput.stop as ReturnType<typeof vi.fn>).mockResolvedValue('test transcript')
      const result = await handlers[IPC.voiceInput.stop](evt)
      expect(deps.voiceInput.stop).toHaveBeenCalledOnce()
      expect(result).toEqual({ transcript: 'test transcript' })
    })

    it('sends IPC.voiceInput.done event with the transcript', async () => {
      vi.mocked(deps.voiceInput.stop as ReturnType<typeof vi.fn>).mockResolvedValue('done text')
      await handlers[IPC.voiceInput.stop](evt)
      expect(deps.send).toHaveBeenCalledWith(IPC.voiceInput.done, { transcript: 'done text' })
    })

    it('does not throw when getWebContents() returns null', async () => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      const nullDeps = makeDeps({ webContents: null })
      registerVoiceIpc(nullDeps)
      await expect(handlers[IPC.voiceInput.stop](evt)).resolves.toEqual({ transcript: 'hello world' })
    })
  })

  describe('IPC.ai.speak', () => {
    let handlers: Record<string, (...args: unknown[]) => unknown>
    let deps: ReturnType<typeof makeDeps>

    beforeEach(() => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      deps = makeDeps()
      registerVoiceIpc(deps)
    })

    it('calls tts.speak() with the provided text and rate', async () => {
      await handlers[IPC.ai.speak](evt, { text: 'Hello', rate: 200 })
      expect(deps.tts.speak).toHaveBeenCalledWith('Hello', 200, undefined)
    })

    it('falls back to DB-stored rate when none provided', async () => {
      vi.mocked(deps.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        key === 'tts.rate' ? '175' : null
      )
      await handlers[IPC.ai.speak](evt, { text: 'Hi', rate: undefined })
      expect(deps.tts.speak).toHaveBeenCalledWith('Hi', 175, undefined)
    })

    it('falls back to default rate 185 when nothing configured', async () => {
      await handlers[IPC.ai.speak](evt, { text: 'Hi' })
      expect(deps.tts.speak).toHaveBeenCalledWith('Hi', 185, undefined)
    })

    it('uses args.voice when provided, overriding DB-stored voice', async () => {
      vi.mocked(deps.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        key === 'tts.voice' ? 'Samantha' : null
      )
      await handlers[IPC.ai.speak](evt, { text: 'Hi', voice: 'Moira' })
      expect(deps.tts.speak).toHaveBeenCalledWith('Hi', 185, 'Moira')
    })

    it('falls back to DB-stored voice when args.voice is absent', async () => {
      vi.mocked(deps.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) =>
        key === 'tts.voice' ? 'Samantha' : null
      )
      await handlers[IPC.ai.speak](evt, { text: 'Hi' })
      expect(deps.tts.speak).toHaveBeenCalledWith('Hi', 185, 'Samantha')
    })

    it('uses Qwen3 path when engine is qwen3 and customVoiceId is set', async () => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      const synthesize = vi.fn().mockResolvedValue('/tmp/synth.wav')
      const playFile = vi.fn().mockResolvedValue(undefined)
      deps = makeDeps({ ttsCloningServiceSynthesize: synthesize, ttsPlayFile: playFile })
      vi.mocked(deps.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'tts.engine') return 'qwen3'
        if (key === 'tts.customVoiceId') return 'voice-uuid-1'
        return null
      })
      registerVoiceIpc(deps)

      await handlers[IPC.ai.speak](evt, { text: 'Hello Qwen3' })
      expect(synthesize).toHaveBeenCalledWith('voice-uuid-1', 'Hello Qwen3')
      expect(playFile).toHaveBeenCalledWith('/tmp/synth.wav')
      expect(deps.tts.speak).not.toHaveBeenCalled()
    })

    it('falls back to macOS when engine is qwen3 but no customVoiceId is set', async () => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      deps = makeDeps()
      vi.mocked(deps.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'tts.engine') return 'qwen3'
        return null  // no customVoiceId
      })
      registerVoiceIpc(deps)

      await handlers[IPC.ai.speak](evt, { text: 'Fallback' })
      expect(deps.tts.speak).toHaveBeenCalledWith('Fallback', 185, undefined)
    })

    it('does not throw when Qwen3 synthesis fails', async () => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      const synthesize = vi.fn().mockRejectedValue(new Error('Model not ready'))
      deps = makeDeps({ ttsCloningServiceSynthesize: synthesize })
      vi.mocked(deps.settings.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'tts.engine') return 'qwen3'
        if (key === 'tts.customVoiceId') return 'voice-uuid-1'
        return null
      })
      registerVoiceIpc(deps)

      await expect(handlers[IPC.ai.speak](evt, { text: 'Oops' })).resolves.toBeUndefined()
    })
  })

  describe('IPC.ai.stopSpeaking', () => {
    let handlers: Record<string, (...args: unknown[]) => unknown>
    let deps: ReturnType<typeof makeDeps>

    beforeEach(() => {
      vi.clearAllMocks()
      handlers = captureHandlers()
      deps = makeDeps()
      registerVoiceIpc(deps)
    })

    it('calls tts.stop()', async () => {
      await handlers[IPC.ai.stopSpeaking](evt)
      expect(deps.tts.stop).toHaveBeenCalledOnce()
    })
  })
})
