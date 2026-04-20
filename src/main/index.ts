import { app, BrowserWindow, shell, globalShortcut, protocol, net, systemPreferences } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
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
import { SpeakerIdentificationService, type SpeakerCandidate } from './services/ai/SpeakerIdentificationService'
import { PythonBridge } from './python/PythonBridge'
import { registerRecordingIpc } from './ipc/recording.ipc'
import { registerTranscriptIpc } from './ipc/transcript.ipc'
import { registerSearchIpc } from './ipc/search.ipc'
import { registerAiIpc } from './ipc/ai.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerSpeakerIpc } from './ipc/speaker.ipc'
import { registerVoiceIpc } from './ipc/voice.ipc'
import { SummaryTemplateRepository } from './services/storage/repositories/SummaryTemplateRepository'
import { TtsVoiceRepository } from './services/storage/repositories/TtsVoiceRepository'
import { TTSCloningService } from './services/audio/TTSCloningService'
import { registerTemplateIpc } from './ipc/template.ipc'
import { registerTtsVoiceIpc } from './ipc/tts-voice.ipc'
import { IPC } from '@shared/ipc-types'
import ffmpegStatic from 'ffmpeg-static'
import type { RecordingDebriefReadyPayload } from '@shared/ipc-types'

let mainWindow: BrowserWindow | null = null

// ─── File logger (writes to ~/Library/Logs/VoiceBox/main.log) ────────────────
// Visible in Console.app or: tail -f ~/Library/Logs/VoiceBox/main.log

function setupFileLogger(): void {
  const logsDir = join(app.getPath('logs'))
  try { mkdirSync(logsDir, { recursive: true }) } catch { /* already exists */ }
  const logFile = join(logsDir, 'main.log')

  function write(level: string, args: unknown[]): void {
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] ${args.map(String).join(' ')}\n`
    try { appendFileSync(logFile, line) } catch { /* disk full / permission */ }
  }

  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log   = (...a) => { orig.log(...a);   write('INFO',  a) }
  console.warn  = (...a) => { orig.warn(...a);  write('WARN',  a) }
  console.error = (...a) => { orig.error(...a); write('ERROR', a) }

  process.on('uncaughtException',  (e) => write('FATAL', ['uncaughtException',  e?.stack ?? e]))
  process.on('unhandledRejection', (e) => write('FATAL', ['unhandledRejection', e instanceof Error ? e.stack : e]))

  write('INFO', [`=== VoiceBox starting — ${new Date().toISOString()} ===`])
  write('INFO', [`userData: ${app.getPath('userData')}`])
  write('INFO', [`logFile:  ${logFile}`])
  write('INFO', [`__dirname: ${__dirname}`])
}

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
    console.log('[Window] ready-to-show — calling show()')
    mainWindow!.show()
  })

  // Safety fallback: if ready-to-show never fires (renderer crash, missing
  // index.html, etc.) force the window visible after 8 seconds so the user
  // can at least see a blank or error page instead of nothing.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.warn('[Window] ready-to-show never fired — forcing show() as fallback')
      mainWindow.show()
    }
  }, 8000)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const rendererPath = join(__dirname, '../renderer/index.html')
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    console.log('[Window] Loading renderer URL:', process.env['ELECTRON_RENDERER_URL'])
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    console.log('[Window] Loading renderer file:', rendererPath)
    mainWindow.loadFile(rendererPath)
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Window] did-fail-load: ${code} ${desc} — ${url}`)
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Window] render-process-gone:', details.reason)
  })
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
  const templateRepo = new SummaryTemplateRepository(db)
  const ttsVoiceRepo = new TtsVoiceRepository(db)

  // LLM / Embedding
  const llmService = new LLMService(settingsRepo)
  const embeddingService = new EmbeddingService(llmService, transcriptRepo, settingsRepo)

  // Keychain
  const keychainService = new KeychainService()

  // Python processes
  pythonBridge = new PythonBridge()

  // Inject the bundled ffmpeg binary path so all Python scripts use it
  const ffmpegPath = ffmpegStatic as unknown as string | null
  if (ffmpegPath) pythonBridge.setEnv('FFMPEG_PATH', ffmpegPath)

  // Load saved API keys into LLM service at startup, and inject HF token
  // into PythonBridge before any Python process that needs it is started.
  let hfTokenConfigured = false
  ;(async () => {
    for (const provider of ['claude', 'openai'] as const) {
      const key = await keychainService.getApiKey(provider)
      if (key) llmService.setApiKey(provider, key)
    }
    // HuggingFace token for pyannote/speaker-diarization (gated model)
    const hfToken = await keychainService.getApiKey('huggingface')
    if (hfToken) {
      pythonBridge.setEnv('HF_TOKEN', hfToken)
      hfTokenConfigured = true
    }
  })()

  pythonBridge.start('transcribe')
  pythonBridge.start('embed_voice') // pre-warm so embeddings are ready for the first assignment
  // Ask the encoder to load its model weights during app startup so the
  // first identify/learn call doesn't incur the cold-load delay.
  pythonBridge.send('embed_voice', 'warmup', {}).catch((err) => {
    console.warn('[Main] embed_voice warmup failed (non-fatal):', err?.message ?? err)
  })
  // Pre-warm the TTS bridge so F5-TTS weights are in memory before the
  // user clicks Generate. The Python-side warmup handler is a no-op if the
  // model snapshot hasn't been downloaded yet.
  pythonBridge.start('tts')
  pythonBridge.send('tts', 'warmup', {}).catch((err) => {
    console.warn('[Main] tts warmup failed (non-fatal):', err?.message ?? err)
  })

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

  const ttsCloningService = new TTSCloningService(pythonBridge, ttsVoiceRepo, recordingRepo, transcriptRepo)

  const speakerIdService = new SpeakerIdentificationService(pythonBridge, speakerRepo)

  // ─── Diarization + speaker identification ──────────────────────────────────
  // Runs after a recording finishes: assigns diarization labels to each
  // transcript segment, then tries to match each unique speaker against
  // stored voice embeddings.

  const SPEAKER_ID_CONFIDENCE_THRESHOLD = 0.75

  interface DiarizationSegment {
    speaker_id: string
    start: number
    end: number
  }

  function findBestDiarMatch(
    diarSegs: DiarizationSegment[],
    segStart: number,
    segEnd: number
  ): DiarizationSegment | null {
    // Prefer the diar segment with the greatest time overlap
    let best: DiarizationSegment | null = null
    let bestOverlap = 0
    for (const d of diarSegs) {
      const overlap = Math.max(0, Math.min(d.end, segEnd) - Math.max(d.start, segStart))
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = d
      }
    }
    // Fallback: containment of segment start
    if (!best) {
      best = diarSegs.find((d) => d.start <= segStart && d.end >= segStart) ?? null
    }
    return best
  }

  async function runDiarizationPipeline(recordingId: string, audioPath: string): Promise<void> {
    console.log(`[Diarization] Starting pipeline for recording ${recordingId}`)
    console.log(`[Diarization] HF_TOKEN configured: ${hfTokenConfigured}`)

    if (!pythonBridge.isRunning('diarize')) {
      pythonBridge.start('diarize')
    }

    const diarResult = await pythonBridge.send<{ segments: DiarizationSegment[] }>(
      'diarize',
      'diarize',
      { audio_path: audioPath }
    )

    if (!diarResult.segments.length) {
      console.log('[Diarization] No segments returned — skipping speaker assignment')
      return
    }

    // Step 1: Stamp each transcript segment with its raw SPEAKER_XX label
    const transcriptSegs = transcriptRepo.findByRecordingId(recordingId)
    for (const seg of transcriptSegs) {
      const match = findBestDiarMatch(diarResult.segments, seg.timestampStart, seg.timestampEnd)
      if (match) {
        transcriptRepo.setRawSpeakerId(seg.id, match.speaker_id)
      }
    }

    // Step 2: Group diar segments by speaker and run embedding+match
    const speakerGroups = new Map<string, Array<{ start: number; end: number }>>()
    for (const d of diarResult.segments) {
      const group = speakerGroups.get(d.speaker_id) ?? []
      group.push({ start: d.start, end: d.end })
      speakerGroups.set(d.speaker_id, group)
    }

    for (const [rawSpeakerId, timeRanges] of speakerGroups) {
      try {
        const candidates = await speakerIdService.identifyFromAudio(audioPath, timeRanges)
        const best = candidates[0]
        if (best && best.confidence >= SPEAKER_ID_CONFIDENCE_THRESHOLD) {
          const updated = transcriptRepo.assignSpeakerByRawIdWithConfidence(
            recordingId,
            rawSpeakerId,
            best.speakerId,
            best.speakerName,
            best.confidence
          )
          if (updated > 0) {
            speakerRepo.incrementRecordingCount(best.speakerId)
            console.log(
              `[Diarization] ${rawSpeakerId} → "${best.speakerName}" (${Math.round(best.confidence * 100)}%) — ${updated} segments`
            )
          }
        } else {
          console.log(
            `[Diarization] ${rawSpeakerId} — no confident match (best: ${best ? Math.round(best.confidence * 100) + '%' : 'none'})`
          )
        }
      } catch (err) {
        console.warn(`[Diarization] Speaker ID failed for ${rawSpeakerId}:`, (err as Error).message)
      }
    }

    console.log(`[Diarization] Pipeline complete for recording ${recordingId}`)
  }

  // Prevent EventEmitter process-exit if audio fails (no listener = Node exits)
  audio.on('error', (err: Error) => {
    console.error('[AudioCapture] Error:', err.message)
    mainWindow?.webContents.send('audio:error', { message: err.message })
  })

  audio.on('level', (level: number) => {
    mainWindow?.webContents.send('audio:level', level)
  })

  const LIVE_SPEAKER_ID_THRESHOLD = 0.75
  // A winning speaker must beat the runner-up by at least this margin.
  // Without a gap check, Ed Donner at 77% beats Jon Coffield at 70% — a
  // borderline "win" during a speaker transition that produces a false positive.
  // Requiring a gap means ambiguous transitions become unassigned rather than wrong.
  // 0.07 (7 points) is enough to reject coin-flip calls while not over-rejecting
  // steady-state segments where two well-trained speakers are 10-15 points apart.
  const LIVE_ID_MIN_GAP = 0.07
  const LIVE_ID_TIMEOUT_MS = 5_000
  const LIVE_ID_PENDING_CAP = 20
  let liveIdRunning = false
  let pendingLiveSegments: Array<{ id: string; recordingId: string; timestampStart: number; timestampEnd: number }> = []

  /** True when the identification is unambiguous — above threshold AND the winner
   *  dominates the runner-up by at least LIVE_ID_MIN_GAP. */
  function isConfidentLiveMatch(candidates: SpeakerCandidate[]): boolean {
    const best = candidates[0]
    if (!best || best.confidence < LIVE_SPEAKER_ID_THRESHOLD) return false
    const second = candidates[1]
    const gap = second ? best.confidence - second.confidence : 1.0
    return gap >= LIVE_ID_MIN_GAP
  }

  /**
   * Batch-identify all segments that accumulated while liveIdRunning was true.
   * Uses a single full-buffer snapshot so only one Python IPC call is needed
   * regardless of how many segments are pending.
   */
  async function drainPendingLiveSegments(recordingId: string): Promise<void> {
    if (pendingLiveSegments.length === 0) return
    if (speakerRepo.findWithEmbeddings().length === 0) {
      pendingLiveSegments = []
      return
    }
    const toProcess = pendingLiveSegments
    pendingLiveSegments = []

    const snapshotPath = join(tmpdir(), `vb-pending-${recordingId}.wav`)
    try {
      // Full recording buffer — all pending segments' timestamps are valid offsets
      audio.saveSnapshot(snapshotPath)
      if (!existsSync(snapshotPath)) return

      const clusters = toProcess.map((seg) => ({
        id: seg.id,
        segments: [{ start: seg.timestampStart, end: seg.timestampEnd }]
      }))

      const resultsMap = await Promise.race([
        speakerIdService.identifyBatch(snapshotPath, clusters),
        new Promise<Map<string, SpeakerCandidate[]>>((resolve) =>
          // Scale timeout with number of segments: identifyBatch sends one Python
          // request but processes each cluster sequentially (~1s each). A fixed
          // 10-second budget fails when 7+ segments queue up.
          setTimeout(() => resolve(new Map()), LIVE_ID_TIMEOUT_MS * Math.max(2, toProcess.length))
        )
      ])

      for (const seg of toProcess) {
        const candidates = resultsMap.get(seg.id) ?? []
        const best = candidates[0]
        if (isConfidentLiveMatch(candidates)) {
          transcriptRepo.assignSpeakerToSegmentWithConfidence(
            seg.id, best.speakerId, best.speakerName, best.confidence
          )
          const second = candidates[1]
          console.log(`[LiveID] pending "${best.speakerName}" (${Math.round(best.confidence * 100)}% gap:${Math.round((second ? best.confidence - second.confidence : 1) * 100)}%) → segment ${seg.id}`)
          const updated = transcriptRepo.findByRecordingId(recordingId).find((s) => s.id === seg.id)
          if (updated) mainWindow?.webContents.send(IPC.transcript.segmentAdded, updated)
        } else if (best) {
          console.debug(`[LiveID] pending rejected — "${best.speakerName}" ${Math.round(best.confidence * 100)}% gap:${Math.round((candidates[1] ? best.confidence - candidates[1].confidence : 1) * 100)}%`)
        }
      }
    } catch (err) {
      console.debug('[LiveID] pending drain failed (non-fatal):', (err as Error).message)
    } finally {
      try { unlinkSync(snapshotPath) } catch { /* ignore */ }
    }
  }

  // Embed segments when they're created; also attempt live speaker auto-assignment
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

    // Live speaker auto-assignment ────────────────────────────────────────────
    // Skip if no stored voice embeddings exist yet.
    if (speakerRepo.findWithEmbeddings().length === 0) return

    const duration = segment.timestampEnd - segment.timestampStart
    if (duration <= 0) return

    // If a live-ID call is already in flight, queue this segment rather than
    // dropping it. The full recording buffer is in memory so saveSegmentSnapshot
    // can reconstruct any past timestamp when we drain after the current call.
    if (liveIdRunning) {
      if (pendingLiveSegments.length < LIVE_ID_PENDING_CAP) {
        pendingLiveSegments.push({
          id: segment.id,
          recordingId: segment.recordingId,
          timestampStart: segment.timestampStart,
          timestampEnd: segment.timestampEnd
        })
      }
      return
    }

    liveIdRunning = true
    const snapshotPath = join(tmpdir(), `vb-live-${segment.id}.wav`)
    void (async () => {
      try {
        audio.saveSegmentSnapshot(snapshotPath, segment.timestampStart, segment.timestampEnd)
        // saveSegmentSnapshot is a no-op when the buffer is empty — skip Python call
        if (!existsSync(snapshotPath)) return
        // Race the embed_voice call against a short timeout. Post-recording
        // processing (learnSpeaker, null-segment sweeps, diarization identify)
        // shares the same embed_voice queue and can make it back up for 20-30 s.
        // If we don't timeout, liveIdRunning stays true for the entire backlog
        // and every subsequent segment in this recording is dropped.
        const candidates = await Promise.race([
          speakerIdService.identifyFromAudio(snapshotPath, [
            { start: 0, end: duration }
          ]),
          new Promise<SpeakerCandidate[]>((resolve) =>
            setTimeout(() => resolve([]), LIVE_ID_TIMEOUT_MS)
          )
        ])
        const best = candidates[0]
        const second = candidates[1]
        const gap = second ? best?.confidence - second.confidence : 1.0
        if (isConfidentLiveMatch(candidates)) {
          transcriptRepo.assignSpeakerToSegmentWithConfidence(
            segment.id,
            best.speakerId,
            best.speakerName,
            best.confidence
          )
          console.log(
            `[LiveID] "${best.speakerName}" (${Math.round(best.confidence * 100)}% gap:${Math.round(gap * 100)}%) → segment ${segment.id}`
          )
          // Push the updated segment back to the renderer so the live view updates
          const updated = transcriptRepo.findByRecordingId(segment.recordingId)
            .find((s) => s.id === segment.id)
          if (updated) {
            mainWindow?.webContents.send(IPC.transcript.segmentAdded, updated)
          }
        } else {
          console.debug(
            `[LiveID] rejected — best: ${best ? `"${best.speakerName}" ${Math.round(best.confidence * 100)}% gap:${Math.round(gap * 100)}%` : 'none'}`
          )
        }
        // Drain any segments that queued up while this call was in flight.
        // Still inside the try block so liveIdRunning stays true — new arrivals
        // continue to be buffered rather than triggering a concurrent call.
        await drainPendingLiveSegments(segment.recordingId)
      } catch (err) {
        console.debug('[LiveID] identification failed (non-fatal):', (err as Error).message)
      } finally {
        try { unlinkSync(snapshotPath) } catch { /* ignore */ }
        liveIdRunning = false
      }
    })()
  })

  // After recording completes: run diarization then auto-generate debrief
  async function runPostRecordingPipeline(recordingId: string): Promise<void> {
    const recording = recordingRepo.findById(recordingId)
    if (!recording) {
      mainWindow?.webContents.send(IPC.recording.processed, { recordingId })
      return
    }

    // ── Diarization + speaker identification ─────────────────────────────────
    if (recording.audioPath) {
      // Learn voice embeddings for speakers confirmed during live recording.
      // This must run BEFORE diarization so those embeddings are available for
      // the subsequent speaker-ID sweep that resolves SPEAKER_XX clusters.
      const liveConfirmed = transcriptRepo.findManuallyConfirmedSpeakers(recordingId)
      for (const { speakerId, timeRanges } of liveConfirmed) {
        const sp = speakerRepo.findById(speakerId)
        if (sp) {
          try {
            await speakerIdService.learnSpeaker(sp.id, recording.audioPath, timeRanges)
            console.log(
              `[SpeakerID] Post-recording embedding learned for "${sp.name}" (${timeRanges.length} segment${timeRanges.length !== 1 ? 's' : ''})`
            )
          } catch (err) {
            console.error(
              `[SpeakerID] Post-recording learnSpeaker failed for "${sp.name}":`,
              (err as Error).message
            )
          }
        }
      }

      // ── Re-sweep borderline live-assigned segments ────────────────────────
      // Live-ID runs against in-progress embeddings; post-recording learnSpeaker
      // above may have updated those embeddings significantly.  Re-identify any
      // segment assigned with 0.75–0.84 confidence so that a wrong assignment
      // made with a stale embedding (e.g. Ed Donner scored 78% when Jon was the
      // true speaker at 82%) gets corrected using the now-updated profiles.
      try {
        const borderlineSegs = transcriptRepo.findBorderlineAssignedSegments(
          recordingId, LIVE_SPEAKER_ID_THRESHOLD, 0.85
        )
        if (borderlineSegs.length > 0 && speakerRepo.findWithEmbeddings().length > 0) {
          const clusters = borderlineSegs.map((s) => ({
            id: s.id,
            segments: [{ start: s.timestampStart, end: s.timestampEnd }]
          }))
          const resultsMap = await speakerIdService.identifyBatch(recording.audioPath, clusters)
          let reswept = 0
          for (const seg of borderlineSegs) {
            const candidates = resultsMap.get(seg.id) ?? []
            const best = candidates[0]
            if (best && best.confidence >= SPEAKER_ID_CONFIDENCE_THRESHOLD) {
              transcriptRepo.assignSpeakerToSegmentWithConfidence(
                seg.id, best.speakerId, best.speakerName, best.confidence
              )
              reswept++
              console.log(`[SpeakerID] Borderline re-sweep: segment ${seg.id} → "${best.speakerName}" (${Math.round(best.confidence * 100)}%)`)
            }
          }
          if (reswept > 0) {
            const updated = transcriptRepo.findByRecordingId(recordingId)
            mainWindow?.webContents.send(IPC.transcript.speakersSwept, { recordingId, segments: updated })
          }
        }
      } catch (resweptErr) {
        console.warn('[SpeakerID] Borderline re-sweep failed:', (resweptErr as Error).message)
      }

      if (!hfTokenConfigured) {
        console.log('[Diarization] Skipping — no HuggingFace token configured')
      } else {
        try {
          await runDiarizationPipeline(recordingId, recording.audioPath)
          // Push updated segments to renderer so the UI refreshes
          mainWindow?.webContents.send('recording:diarizationComplete', { recordingId })
        } catch (err) {
          const msg = (err as Error).message ?? ''
          if (msg.includes('GatedRepoError') || msg.includes('gated') || msg.includes('403')) {
            console.error('[Diarization] HuggingFace access denied — ensure both model licenses are accepted at huggingface.co')
            console.error('[Diarization] Full error:', msg)
            mainWindow?.webContents.send('diarization:error', {
              type: 'gated_repo',
              message: 'HuggingFace access denied. Make sure you have accepted the license for both pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0.'
            })
          } else {
            console.error('[Diarization] Pipeline failed:', msg)
          }
        }
      }

      // ── Post-recording null-segment sweep ────────────────────────────────
      // Always runs after learnSpeaker + diarization (success or failure) so
      // that any segments skipped by the live-ID gate get a final assignment
      // pass using the full audio file.  Combining all null-segment timestamps
      // into a single identifyFromAudio call gives Resemblyzer more audio to
      // work with, producing higher-confidence matches than individual short
      // snippets.
      try {
        const nullSegs = transcriptRepo.findNullSpeakerSegments(recordingId)
        if (nullSegs.length > 0 && speakerRepo.findWithEmbeddings().length > 0) {
          // Identify against all null segments at once (better embedding quality)
          const timeRanges = nullSegs.map((s) => ({ start: s.timestampStart, end: s.timestampEnd }))
          const candidates = await speakerIdService.identifyFromAudio(recording.audioPath, timeRanges)
          const best = candidates[0]
          if (best && best.confidence >= SPEAKER_ID_CONFIDENCE_THRESHOLD) {
            let swept = 0
            for (const seg of nullSegs) {
              transcriptRepo.assignSpeakerToSegmentWithConfidence(
                seg.id, best.speakerId, best.speakerName, best.confidence
              )
              swept++
            }
            console.log(`[SpeakerID] Post-recording sweep: ${swept} null segment(s) → "${best.speakerName}" (${Math.round(best.confidence * 100)}%)`)
            const updated = transcriptRepo.findByRecordingId(recordingId)
            mainWindow?.webContents.send(IPC.transcript.speakersSwept, { recordingId, segments: updated })
          }
        }
      } catch (sweepErr) {
        console.warn('[SpeakerID] Post-recording null-segment sweep failed:', (sweepErr as Error).message)
      }
    }

    // ── Debrief generation ────────────────────────────────────────────────────
    try {
      const segments = transcriptRepo.findByRecordingId(recordingId)
      if (segments.length > 0) {
        const transcript = segments
          .map((s) => {
            const m = Math.floor(s.timestampStart / 60)
            const sec = String(Math.floor(s.timestampStart % 60)).padStart(2, '0')
            const speaker = s.speakerName ?? 'Unknown'
            return `[${m}:${sec}] ${speaker}: ${s.text}`
          })
          .join('\n')

        const template =
          (recording.templateId ? templateRepo.findById(recording.templateId) : null) ??
          templateRepo.findDefault()

        const userMessage = template.userPromptTemplate
          .replace('{{title}}', recording.title)
          .replace('{{transcript}}', transcript)

        const response = await llmService.complete('summarization', {
          systemPrompt: template.systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        })

        recordingRepo.update(recordingId, { debrief: response.text, debriefAt: Date.now() })

        const payload: RecordingDebriefReadyPayload = { recordingId, debrief: response.text }
        mainWindow?.webContents.send(IPC.recording.debriefReady, payload)
      }
    } catch (err) {
      console.error('[Debrief] Failed to generate debrief:', (err as Error).message)
    }

    // Signal that the full post-recording pipeline is done — always fires so
    // the renderer clears the "Analyzing recording…" banner regardless of
    // whether diarization/debrief succeeded or there were no segments.
    mainWindow?.webContents.send(IPC.recording.processed, { recordingId })
  }

  queue.on('complete', async (recordingId: string) => {
    // Clear any segments that were pending live-ID when the recording stopped.
    // They'll be fully covered by the post-recording null-segment sweep.
    pendingLiveSegments = []
    liveIdRunning = false

    await runPostRecordingPipeline(recordingId)
  })

  // Search
  const searchService = new SearchService(getDatabase(), llmService)

  // Register all IPC handlers
  const getWebContents = () => mainWindow?.webContents ?? null

  registerRecordingIpc({
    recordingRepo,
    transcriptRepo,
    audio,
    queue,
    whisper,
    getWebContents,
    triggerPostRecordingPipeline: (recordingId) => void runPostRecordingPipeline(recordingId)
  })
  registerTranscriptIpc({ transcriptRepo, speakerRepo, recordingRepo, speakerIdService, getWebContents, audio })
  registerSearchIpc({ search: searchService, embeddingService })
  registerAiIpc({ llm: llmService, conversationRepo, recordingRepo, transcriptRepo, speakerRepo, searchService, getWebContents })
  registerSettingsIpc({
    settings: settingsRepo,
    audio,
    keychain: keychainService,
    llm: llmService,
    pythonBridge,
    onHfTokenChange: (hasToken) => { hfTokenConfigured = hasToken }
  })
  registerSpeakerIpc({ speakerRepo })
  registerVoiceIpc({ tts, ttsCloningService, voiceInput, settings: settingsRepo, getWebContents })
  registerTemplateIpc({ templateRepo, recordingRepo, transcriptRepo, llm: llmService })
  registerTtsVoiceIpc({ ttsVoiceRepo, ttsCloningService, getWebContents })
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  setupFileLogger()
  console.log('[App] whenReady fired')
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

  try {
    console.log('[App] initServices() start')
    initServices()
    console.log('[App] initServices() complete')
  } catch (err) {
    console.error('[App] initServices() threw:', (err as Error)?.stack ?? err)
  }

  console.log('[App] createWindow() start')
  createWindow()
  console.log('[App] createWindow() complete')

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
