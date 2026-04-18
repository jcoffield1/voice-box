import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import ErrorBoundary from './components/layout/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import RecordingPage from './pages/RecordingPage'
import SearchPage from './pages/SearchPage'
import SettingsPage from './pages/SettingsPage'
import SpeakersPage from './pages/SpeakersPage'
import GlobalChatPage from './pages/GlobalChatPage'
import TemplatesPage from './pages/TemplatesPage'
import OnboardingModal from './components/layout/OnboardingModal'
import HuggingFaceSetupGate from './components/layout/HuggingFaceSetupGate'
import LLMSetupGate from './components/layout/LLMSetupGate'
import { useRecordingEvents } from './hooks/useRecording'

export default function App() {
  // Wire up global IPC event listeners
  useRecordingEvents()

  return (
    <HashRouter>
      <HuggingFaceSetupGate>
        <LLMSetupGate>
          <OnboardingModal />
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Navigate to="/recordings" replace />} />
                <Route path="recordings" element={<Dashboard />} />
                <Route path="recordings/:id" element={<RecordingPage />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="chat" element={<GlobalChatPage />} />
                <Route path="speakers" element={<SpeakersPage />} />
                <Route path="templates" element={<TemplatesPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </ErrorBoundary>
        </LLMSetupGate>
      </HuggingFaceSetupGate>
    </HashRouter>
  )
}
