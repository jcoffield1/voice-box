import { app, BrowserWindow, shell, globalShortcut, protocol, net, systemPreferences } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, closeDatabase, getDatabase } from './services/storage/Database'
import { RecordingRepository } from './services/storage/repositories/RecordingRepository'
import { TranscriptRepository } from './services/storage/repositories/TranscriptRepository'
import { SpeakerRepository } from './services/storage/repositories/SpeakerRepository'
import { ConversationRepository } from './services/storage/repositories/ConversationRepository'
import { SettingsRepository } from './services/storage/repositories/SettingsRepository'
import { AudioCaptureService } from './services/audio/AudioCaptureService'
import { TTSService } from './services/audio/TTSService'
import { VoiceInputService } from './services/audio/VoiceInputService'
import { WhisperService } from './services/transcription/WhisperService'
import { TranscriptionQueue } from './services/transcription/TranscriptionQueue'
import { LLMService } from './services/llm/LLMService'
import { EmbeddingService } from './services/llm/EmbeddingService'
import { SearchService } from './services/search/SearchService'
import { KeychainService } from './services/security/KeychainService'
import { PythonBridge } from './python/PythonBridge'
import { registerRecordingIpc } from './ipc/recording.ipc'
import { registerTranscriptIpc } from './ipc/transcript.ipc'
import { registerSearchIpc } from './ipc/search.ipc'
import { registerAiIpc } from './ipc/ai.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerSpeakerIpc } from './ipc/speaker.ipc'
import { registerVoiceIpc } from './ipc/voice.ipc'
import { IPC } from '@shared/ipc-types'
import type { RecordingDebriefReadyPayload } from '@shared/ipc-types'

let mainWindow: BrowserWindow | null = null

// Must be called before app is ready.
// standard:true is required so Chromium parses vbfile://localhost/... correctly.
// We always use 'localhost' as the host in vbfile URLs so the absolute path
// is never confused with the URL authority section.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vbfile',
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true }
  }
])

// ─── Services (singleton per process lifetime) ───────────────────────────────

let pythonBridge: PythonBridge
let audio: AudioCaptureService
let whisper: WhisperService
let queue: TranscriptionQueue
let tts: TTSService
let voiceInput: VoiceInputService

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function initServices(): void {
  // Database
  const db = initDatabase()

  // Repositories
  const recordingRepo = new RecordingRepository(db)
  const transcriptRepo = new TranscriptRepository(db)
  const speakerRepo = new SpeakerRepository(db)
  const conversationRepo = new ConversationRepository(db)
  const settingsRepo = new SettingsRepository(db)

  // LLM / Embedding
  const llmService = new LLMService(settingsRepo)
  const embeddingService = new EmbeddingService(llmService, transcriptRepo, settingsRepo)

  // Keychain
  const keychainService = new KeychainService()

  // Load saved API keys into LLM service at startup
  ;(async () => {
    for (const provider of ['claude', 'openai'] as const) {
      const key = await keychainService.getApiKey(provider)
      if (key) llmService.setApiKey(provider, key)
    }
  })()

  // Python processes
  pythonBridge = new PythonBridge()
  pythonBridge.start('transcribe')

  pythonBridge.on('process:restarted', ({ name, attempt }: { name: string; attempt: number }) => {
    console.warn(`[Main] Python process '${name}' restarted (attempt ${attempt})`)
    mainWindow?.webContents.send('python:restarted', { name, attempt })
  })

  pythonBridge.on('process:failed', ({ name }: { name: string }) => {
    console.error(`[Main] Python process '${name}' failed after max retries`)
    mainWindow?.webContents.send('python:failed', { name })
  })

  // Audio + transcription
  audio = new AudioCaptureService()
  whisper = new WhisperService(pythonBridge)
  queue = new TranscriptionQueue(whisper, audio, transcriptRepo, recordingRepo)
  tts = new TTSService()
  voiceInput = new VoiceInputService(whisper)

  // Prevent EventEmitter process-exit if audio fails (no listener = Node exits)
  audio.on('error', (err: Error) => {
    console.error('[AudioCapture] Error:', err.message)
    mainWindow?.webContents.send('audio:error', { message: err.message })
  })

  audio.on('level', (level: number) => {
    mainWindow?.webContents.send('audio:level', level)
  })

  // Embed segments when they're created
  queue.on('segment', (segment) => {
    const recording = recordingRepo.findById(segment.recordingId)
    if (recording) {
      embeddingService.enqueue(segment.id, segment.text, {
        recordingTitle: recording.title,
        speakerName: segment.speakerName,
        timestampStart: segment.timestampStart,
        createdAt: segment.createdAt
      })
    }
  })

  // Auto-generate a full debrief when transcription completes
  queue.on('complete', async (recordingId: string) => {
    try {
      const recording = recordingRepo.findById(recordingId)
      if (!recording) return
      const segments = transcriptRepo.findByRecordingId(recordingId)
      if (segments.length === 0) return

      const transcript = segments
        .map((s) => {
          const m = Math.floor(s.timestampStart / 60)
          const sec = String(Math.floor(s.timestampStart % 60)).padStart(2, '0')
          const speaker = s.speakerName ?? 'Unknown'
          return `[${m}:${sec}] ${speaker}: ${s.text}`
        })
        .join('\n')

      const systemPrompt = `You are a professional meeting analyst. Create a comprehensive debrief of this conversation.
Structure your response with these sections:
1. Executive Summary (2-3 sentences)
2. Discussion Timeline (key topics in chronological order)
3. Decisions Made (each decision with context and rationale)
4. Action Items (who is responsible and what they need to do)
5. Key Insights (important observations, patterns, or takeaways)
6. Open Questions (anything unresolved or requiring follow-up)
7. Participant Contributions (brief summary of each person's role)

Be thorough — this is the complete record of the conversation.`

      const response = await llmService.complete('summarization', {
        systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Please create a full debrief for this call titled "${recording.title}":\n\n${transcript}`
          }
        ]
      })

      recordingRepo.update(recordingId, { debrief: response.text, debriefAt: Date.now() })

      const payload: RecordingDebriefReadyPayload = { recordingId, debrief: response.text }
      mainWindow?.webContents.send(IPC.recording.debriefReady, payload)
    } catch (err) {
      console.error('[Debrief] Failed to generate debrief:', (err as Error).message)
    }
  })

  // Search
  const searchService = new SearchService(getDatabase(), llmService)

  // Register all IPC handlers
  const getWebContents = () => mainWindow?.webContents ?? null

  registerRecordingIpc({ recordingRepo, transcriptRepo, audio, queue, getWebContents })
  registerTranscriptIpc({ transcriptRepo, speakerRepo })
  registerSearchIpc({ search: searchService, embeddingService })
  registerAiIpc({ llm: llmService, conversationRepo, recordingRepo, transcriptRepo, speakerRepo, searchService, getWebContents })
  registerSettingsIpc({ settings: settingsRepo, audio, keychain: keychainService, llm: llmService })
  registerSpeakerIpc({ speakerRepo })
  registerVoiceIpc({ tts, voiceInput, settings: settingsRepo, getWebContents })
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.calltranscriber.app')

  // Register vbfile:// protocol to serve local audio files to the renderer.
  // URLs are always of the form vbfile://localhost<absolute-path> so that
  // Chromium never confuses the path with a URL authority/hostname.
  protocol.handle('vbfile', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    // Forward Range header so the browser can seek and determine duration
    const init: RequestInit = {}
    const range = request.headers.get('range')
    if (range) init.headers = { range }
    return net.fetch(pathToFileURL(filePath).href, init)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initServices()
  createWindow()

  // Request microphone permission on macOS so the first recording attempt
  // doesn't get silently killed by the OS before the user sees a dialog.
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').then((granted) => {
      if (!granted) {
        console.warn('[Main] Microphone access denied by user')
      }
    }).catch(() => {})
  }

  // Global push-to-talk shortcut: Cmd+Shift+Space
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.webContents.send('shortcut:pushToTalk')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  audio?.stop()
  tts?.stop()
  pythonBridge?.killAll()
  queue?.destroy()
  closeDatabase()
})
