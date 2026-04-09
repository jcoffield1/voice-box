import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-types'
import type {
  GetApiKeyArgs,
  GetApiKeyResult,
  SetApiKeyArgs,
  DeleteApiKeyArgs,
  GetAudioDevicesResult,
  GetProviderForFeatureArgs,
  GetProviderForFeatureResult,
  SetProviderForFeatureArgs,
  GetSettingArgs,
  GetSettingResult,
  SetSettingArgs,
  SystemStatusResult
} from '@shared/ipc-types'
import type { SettingsRepository } from '../services/storage/repositories/SettingsRepository'
import type { AudioCaptureService } from '../services/audio/AudioCaptureService'
import type { KeychainService } from '../services/security/KeychainService'
import type { LLMService } from '../services/llm/LLMService'
import type { LLMProviderType } from '@shared/types'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

interface SettingsIpcDeps {
  settings: SettingsRepository
  audio: AudioCaptureService
  keychain: KeychainService
  llm: LLMService
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const { settings, audio, keychain, llm } = deps

  ipcMain.handle(IPC.settings.get, async (_event, args: GetSettingArgs): Promise<GetSettingResult> => {
    return { value: settings.get(args.key) }
  })

  ipcMain.handle(IPC.settings.set, async (_event, args: SetSettingArgs): Promise<void> => {
    if (args.key === '_openAccessibility') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?Dictation')
      return
    }
    settings.set(args.key, args.value)
  })

  ipcMain.handle(IPC.settings.getAudioDevices, async (): Promise<GetAudioDevicesResult> => {
    return { devices: audio.listDevices() }
  })

  ipcMain.handle(
    IPC.settings.getProviderForFeature,
    async (_event, args: GetProviderForFeatureArgs): Promise<GetProviderForFeatureResult> => {
      const provider = settings.getJson<LLMProviderType>(`llm.${args.feature}.provider`) ?? 'ollama'
      const model = settings.getJson<string>(`llm.${args.feature}.model`) ?? 'llama3.2:8b'
      return { provider, model }
    }
  )

  ipcMain.handle(
    IPC.settings.setProviderForFeature,
    async (_event, args: SetProviderForFeatureArgs): Promise<void> => {
      settings.setJson(`llm.${args.feature}.provider`, args.provider)
      settings.setJson(`llm.${args.feature}.model`, args.model)
    }
  )

  // ─── Keychain ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.settings.getApiKey, async (_event, args: GetApiKeyArgs): Promise<GetApiKeyResult> => {
    const apiKey = await keychain.getApiKey(args.provider)
    return { apiKey }
  })

  ipcMain.handle(IPC.settings.setApiKey, async (_event, args: SetApiKeyArgs): Promise<void> => {
    await keychain.setApiKey(args.provider, args.apiKey)
    // Also update the in-memory provider so it takes effect immediately
    llm.setApiKey(args.provider as LLMProviderType, args.apiKey)
  })

  ipcMain.handle(IPC.settings.deleteApiKey, async (_event, args: DeleteApiKeyArgs): Promise<void> => {
    await keychain.deleteApiKey(args.provider)
    llm.setApiKey(args.provider as LLMProviderType, '')
  })

  // ─── System status ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.settings.getSystemStatus, async (): Promise<SystemStatusResult> => {
    let ollamaModels: string[] = []
    let ollamaAvailable = false
    try {
      const models = await llm.listModels('ollama')
      ollamaModels = models.map((m) => m.id)
      ollamaAvailable = true
    } catch {
      ollamaAvailable = false
    }

    let pythonAvailable = false
    let whisperAvailable = false
    try {
      // Prefer the bundled venv; fall back to system python3 only in dev
      const venvPython = app.isPackaged
        ? join(process.resourcesPath, 'python', 'venv', 'bin', 'python3')
        : join(app.getAppPath(), 'python', 'venv', 'bin', 'python3')
      const pythonBin = existsSync(venvPython) ? venvPython : 'python3'
      await execFileAsync(pythonBin, ['--version'])
      pythonAvailable = true
      await execFileAsync(pythonBin, ['-c', 'import whisper'])
      whisperAvailable = true
    } catch {
      // Not available
    }

    return { ollamaAvailable, ollamaModels, pythonAvailable, whisperAvailable }
  })
}

