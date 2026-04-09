import { create } from 'zustand'
import type { AudioDevice, LLMProviderType, LLMFeature, LLMModel } from '@shared/types'

interface SettingsState {
  audioDevices: AudioDevice[]
  selectedInputDeviceId: string | null
  selectedOutputDeviceId: string | null
  whisperModel: string
  language: string
  providerMap: Partial<Record<LLMFeature, LLMProviderType>>
  modelMap: Partial<Record<LLMFeature, string>>
  availableModels: Record<string, LLMModel[]>

  // Actions
  setAudioDevices: (devices: AudioDevice[]) => void
  setSelectedInputDeviceId: (id: string | null) => void
  setSelectedOutputDeviceId: (id: string | null) => void
  setWhisperModel: (model: string) => void
  setLanguage: (lang: string) => void
  setProviderForFeature: (feature: LLMFeature, provider: LLMProviderType) => void
  setModelForFeature: (feature: LLMFeature, model: string) => void
  setModelsForProvider: (provider: string, models: LLMModel[]) => void

  // Async thunks
  loadAudioDevices: () => Promise<void>
  loadSettings: () => Promise<void>
  saveApiKey: (provider: LLMProviderType, key: string) => Promise<void>
  loadModels: (provider: LLMProviderType) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  audioDevices: [],
  selectedInputDeviceId: null,
  selectedOutputDeviceId: null,
  whisperModel: 'base',
  language: 'en',
  providerMap: {},
  modelMap: {},
  availableModels: {},

  setAudioDevices: (devices) => set({ audioDevices: devices }),
  setSelectedInputDeviceId: (id) => set({ selectedInputDeviceId: id }),
  setSelectedOutputDeviceId: (id) => set({ selectedOutputDeviceId: id }),
  setWhisperModel: (model) => set({ whisperModel: model }),
  setLanguage: (lang) => set({ language: lang }),
  setProviderForFeature: (feature, provider) =>
    set((s) => ({ providerMap: { ...s.providerMap, [feature]: provider } })),
  setModelForFeature: (feature, model) =>
    set((s) => ({ modelMap: { ...s.modelMap, [feature]: model } })),
  setModelsForProvider: (provider, models) =>
    set((s) => ({ availableModels: { ...s.availableModels, [provider]: models } })),

  loadAudioDevices: async () => {
    const result = await window.api.settings.getAudioDevices()
    set({ audioDevices: result.devices })
  },

  loadSettings: async () => {
    const [inputDevice, outputDevice, whisperModel, language] = await Promise.all([
      window.api.settings.get({ key: 'audio.inputDeviceId' }),
      window.api.settings.get({ key: 'audio.outputDeviceId' }),
      window.api.settings.get({ key: 'whisper.model' }),
      window.api.settings.get({ key: 'whisper.language' })
    ])
    set({
      selectedInputDeviceId: inputDevice.value ?? null,
      selectedOutputDeviceId: outputDevice.value ?? null,
      whisperModel: whisperModel.value ?? 'base',
      language: language.value ?? 'en'
    })
    // Load provider and model for all features
    const features: LLMFeature[] = ['summarization', 'conversation', 'embeddings', 'intent']
    for (const feature of features) {
      const result = await window.api.settings.getProviderForFeature({ feature })
      if (result.provider) {
        get().setProviderForFeature(feature, result.provider)
      }
      if (result.model) {
        get().setModelForFeature(feature, result.model)
      }
    }
  },

  saveApiKey: async (provider, key) => {
    await window.api.settings.setApiKey({ provider, apiKey: key })
  },

  loadModels: async (provider) => {
    const result = await window.api.ai.getModels({ provider })
    get().setModelsForProvider(provider, result.models)
  }
}))
