import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-types'
import type { SpeakArgs, VoiceInputStartResult, VoiceInputStopResult, ListVoicesResult, MacOSVoice } from '@shared/ipc-types'
import type { TTSService } from '../services/audio/TTSService'
import type { TTSCloningService } from '../services/audio/TTSCloningService'
import type { VoiceInputService } from '../services/audio/VoiceInputService'
import type { WebContents } from 'electron'
import type { SettingsRepository } from '../services/storage/repositories/SettingsRepository'
import { execFile } from 'child_process'

interface VoiceIpcDeps {
  tts: TTSService
  ttsCloningService: TTSCloningService
  voiceInput: VoiceInputService
  settings: SettingsRepository
  getWebContents: () => WebContents | null
}

/**
 * List voices using `say -v ?` — only returns voices that actually work
 * with the `say` command (Siri-restricted voices are excluded automatically).
 * Output format per line: "Voice Name          en_US    # Description"
 */
function listSystemVoices(): Promise<MacOSVoice[]> {
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], { timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve([]); return }
      const voices: MacOSVoice[] = []
      for (const line of stdout.split('\n')) {
        // Each line: "Moira               en_IE    # Moira speaks in an Irish accent"
        const match = line.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2}[^\s]*)\s/)
        if (!match) continue
        const name = match[1].trim()
        const locale = match[2].trim()
        voices.push({ name, locale, gender: '' })
      }
      // Sort: English first, then alphabetically
      voices.sort((a, b) => {
        const aEn = a.locale.startsWith('en') ? 0 : 1
        const bEn = b.locale.startsWith('en') ? 0 : 1
        if (aEn !== bEn) return aEn - bEn
        return a.name.localeCompare(b.name)
      })
      resolve(voices)
    })
  })
}

export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  const { tts, ttsCloningService, voiceInput, settings, getWebContents } = deps

  // ─── TTS (voice output) ──────────────────────────────────────────────────

  ipcMain.handle(IPC.ai.speak, async (_event, args: SpeakArgs): Promise<void> => {
    const { text, rate } = args
    const engine = (settings.get('tts.engine') as string | null) ?? 'macos'

    if (engine === 'qwen3') {
      const customVoiceId = (settings.get('tts.customVoiceId') as string | null) || null
      if (customVoiceId) {
        try {
          // Sentence-level streaming: play each sentence as soon as it is ready
          // instead of waiting for the full utterance — reduces perceived latency.
          await ttsCloningService.synthesizeStreaming(customVoiceId, text, async (audioPath) => {
            await tts.playFile(audioPath)
          })
        } catch (err) {
          console.error('[TTS/Qwen3] synthesis error:', err)
        }
        return
      }
      // Fall through to macOS if no voice is configured
    }

    // macOS path
    const dbVoice = (settings.get('tts.voice') as string | null) ?? undefined
    const resolvedVoice = args.voice || dbVoice || undefined
    const configuredRate = settings.get('tts.rate') ? Number(settings.get('tts.rate')) : undefined
    tts.speak(text, rate ?? configuredRate ?? 185, resolvedVoice).catch((err) => {
      console.error('[TTS] speak error:', err)
    })
  })

  ipcMain.handle(IPC.ai.stopSpeaking, async (): Promise<void> => {
    tts.stop()
  })

  ipcMain.handle(IPC.ai.listVoices, async (): Promise<ListVoicesResult> => {
    const voices = await listSystemVoices()
    return { voices }
  })

  // ─── Voice input ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.voiceInput.start, async (): Promise<VoiceInputStartResult> => {
    voiceInput.start()
    return { ok: true }
  })

  ipcMain.handle(IPC.voiceInput.stop, async (): Promise<VoiceInputStopResult> => {
    const transcript = await voiceInput.stop()
    getWebContents()?.send(IPC.voiceInput.done, { transcript })
    return { transcript }
  })
}
