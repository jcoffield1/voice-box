import AudioDeviceSettings from '../components/settings/AudioDeviceSettings'
import LLMProviderSettings from '../components/settings/LLMProviderSettings'
import EmbeddingSettings from '../components/settings/EmbeddingSettings'
import TTSSettings from '../components/settings/TTSSettings'
import DiarizationSettings from '../components/settings/DiarizationSettings'

export default function SettingsPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
      <AudioDeviceSettings />
      <LLMProviderSettings />
      <DiarizationSettings />
      <EmbeddingSettings />
      <TTSSettings />
    </div>
  )
}
