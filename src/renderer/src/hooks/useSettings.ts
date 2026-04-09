import { useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'

export function useSettings() {
  const store = useSettingsStore()

  useEffect(() => {
    void store.loadSettings()
    void store.loadAudioDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return store
}
