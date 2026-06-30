import { app, BrowserWindow, shell, globalShortcut, protocol, net, systemPreferences } from 'electron'
import { join, extname } from 'path'
import { pathToFileURL } from 'url'
import { appendFileSync, existsSync, mkdirSync, unlinkSync, statSync, createReadStream } from 'fs'
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
import { registerTemplateIpc } from './ipc/template.ipc'
import { IPC } from '@shared/ipc-types'
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

  // Any recording left in 'processing' from a previous session (e.g. app quit
  // mid-pipeline) would permanently block the New Recording button. Reset them.
  db.prepare(`UPDATE recordings SET status = 'error' WHERE status = 'processing'`).run()

  // LLM / Embedding
  const llmService = new LLMService(settingsRepo)
  const embeddingService = new EmbeddingService(llmService, transcriptRepo, settingsRepo)

  // Keychain
  const keychainService = new KeychainService()

  // Python processes
  pythonBridge = new PythonBridge()

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
  // Apply any saved model/language preferences immediately on startup.
  // Without this the service defaults were used regardless of user settings.
  const savedModel = settingsRepo.get('whisper.model') ?? 'large-v3-turbo'
  const savedLang = settingsRepo.get('whisper.language') ?? undefined
  whisper.configure(savedModel, savedLang)
  queue = new TranscriptionQueue(whisper, audio, transcriptRepo, recordingRepo)
  tts = new TTSService()
  voiceInput = new VoiceInputService(whisper)

  const speakerIdService = new SpeakerIdentificationService(pythonBridge, speakerRepo)

  // ─── Diarization + speaker identification ──────────────────────────────────
  // Runs after a recording finishes: assigns diarization labels to each
  // transcript segment, then tries to match each unique speaker against
  // stored voice embeddings.

  const SPEAKER_ID_CONFIDENCE_THRESHOLD = 0.85

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

  async function runDiarizationPipeline(recordingId: string, audioPath: string, expectedSpeakerIds?: string[]): Promise<void> {
    console.log(`[Diarization] Starting pipeline for recording ${recordingId}`)
    console.log(`[Diarization] HF_TOKEN configured: ${hfTokenConfigured}`)

    if (!pythonBridge.isRunning('diarize')) {
      pythonBridge.start('diarize')
    }

    const diarResult = await pythonBridge.send<{ segments: DiarizationSegment[] }>(
      'diarize',
      'diarize',
      {
        audio_path: audioPath,
        // Tell pyannote exactly how many clusters to find when we know the
        // speaker count — this dramatically improves diarization accuracy.
        num_speakers: expectedSpeakerIds?.length ? expectedSpeakerIds.length : undefined
      }
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
        const candidates = await speakerIdService.identifyFromAudio(audioPath, timeRanges, expectedSpeakerIds)
        const best = candidates[0]
        if (best && best.confidence >= (expectedSpeakerIds?.length ? 0.55 : SPEAKER_ID_CONFIDENCE_THRESHOLD)) {
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

  const LIVE_SPEAKER_ID_THRESHOLD = 0.85
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
  /** Expected speaker IDs for the active recording — loaded when a segment
   *  arrives and cached for the duration. Empty = match all speakers. */
  let activeRecordingExpectedSpeakers: string[] = []

  /** True when the identification is unambiguous — above threshold AND the winner
   *  dominates the runner-up by at least LIVE_ID_MIN_GAP. */
  /** When expected speakers are set we use relaxed thresholds (the speaker
   *  pool is constrained, so lower confidence is acceptable), but we still
   *  require a minimum confidence floor and gap to avoid assigning every
   *  segment to the speaker with the strongest stored embedding. */
  const EXPECTED_SPEAKER_MIN_CONFIDENCE = 0.55
  function isConfidentLiveMatch(candidates: SpeakerCandidate[], hasExpectedSpeakers: boolean): boolean {
    const best = candidates[0]
    if (!best) return false
    if (hasExpectedSpeakers) {
      if (best.confidence < EXPECTED_SPEAKER_MIN_CONFIDENCE) return false
      const second = candidates[1]
      if (second && best.confidence - second.confidence < LIVE_ID_MIN_GAP) return false
      return true
    }
    if (best.confidence < LIVE_SPEAKER_ID_THRESHOLD) return false
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
        speakerIdService.identifyBatch(snapshotPath, clusters, activeRecordingExpectedSpeakers.length > 0 ? activeRecordingExpectedSpeakers : undefined),
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
        if (isConfidentLiveMatch(candidates, activeRecordingExpectedSpeakers.length > 0)) {
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

    // Load expected speakers for the active recording (cached per recording)
    if (activeRecordingExpectedSpeakers.length === 0) {
      activeRecordingExpectedSpeakers = recordingRepo.getExpectedSpeakerIds(segment.recordingId)
    }

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
          ], activeRecordingExpectedSpeakers.length > 0 ? activeRecordingExpectedSpeakers : undefined),
          new Promise<SpeakerCandidate[]>((resolve) =>
            setTimeout(() => resolve([]), LIVE_ID_TIMEOUT_MS)
          )
        ])
        const best = candidates[0]
        const second = candidates[1]
        const gap = second ? best?.confidence - second.confidence : 1.0
        if (isConfidentLiveMatch(candidates, activeRecordingExpectedSpeakers.length > 0)) {
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

  /**
   * LLM second-pass transcript refinement.
   *
   * Only runs if the user has EXPLICITLY configured an LLM provider for the
   * 'transcript-refinement' feature.  Small local models (e.g. llama3.2:8b) are
   * unreliable at this task and can silently degrade quality — we do not want to
   * fall back to whatever Ollama default happens to be installed.
   *
   * Recommended local models: llama3.1:70b, qwen2.5:32b, mistral-large.
   * With those, it catches homophones and garbled proper nouns that Whisper missed.
   */
  async function refineTranscript(recordingId: string): Promise<void> {
    // Skip entirely unless the user has explicitly chosen a provider for refinement.
    const refinementProvider = settingsRepo.getJson<string>('llm.transcript-refinement.provider')
    if (!refinementProvider) {
      console.log('[Refinement] Skipping — no transcript-refinement provider configured')
      return
    }

    const segments = transcriptRepo.findByRecordingId(recordingId)
    if (segments.length < 2) return

    const BATCH_SIZE = 20
    let refined = 0

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE)
      const numbered = batch.map((s, idx) => `${idx + 1}. "${s.text}"`).join('\n')

      try {
        const response = await llmService.complete('transcript-refinement', {
          systemPrompt:
            'You are an expert at correcting speech-to-text transcription errors. ' +
            'Fix only clear ASR mistakes — misheared words, homophones, garbled proper nouns. ' +
            'Do NOT rephrase, summarize, add, or remove content. ' +
            'Return ONLY a valid JSON array of strings, one corrected string per segment, in the same order. No other text.',
          messages: [
            {
              role: 'user',
              content:
                `Correct any transcription errors in these speech segments. ` +
                `If a segment looks correct, return it unchanged.\n\n${numbered}\n\n` +
                `Return format: ["corrected 1", "corrected 2", ...]`
            }
          ]
        })

        let corrections: string[]
        try {
          // Strip markdown code fences if the LLM wraps the JSON
          const raw = response.text.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim()
          corrections = JSON.parse(raw)
        } catch {
          console.warn(`[Refinement] JSON parse failed for batch starting at ${i}; skipping batch`)
          continue
        }

        if (!Array.isArray(corrections) || corrections.length !== batch.length) {
          console.warn(`[Refinement] Unexpected response length for batch at ${i}; skipping`)
          continue
        }

        for (let j = 0; j < batch.length; j++) {
          const seg = batch[j]
          const corrected = typeof corrections[j] === 'string' ? corrections[j].trim() : null
          if (corrected && corrected !== seg.text && !seg.isEdited) {
            transcriptRepo.refineText(seg.id, corrected)
            refined++
          }
        }
      } catch (err) {
        console.warn(`[Refinement] Batch ${i} failed (non-fatal):`, (err as Error).message)
      }
    }

    if (refined > 0) {
      console.log(`[Refinement] Corrected ${refined} segment(s)`)
      const updated = transcriptRepo.findByRecordingId(recordingId)
      mainWindow?.webContents.send(IPC.transcript.speakersSwept, { recordingId, segments: updated })
    }
  }

  async function generateDebrief(recordingId: string): Promise<void> {
    const recording = recordingRepo.findById(recordingId)
    if (!recording) return
    try {
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

      const template =
        (recording.templateId ? templateRepo.findById(recording.templateId) : null) ??
        templateRepo.findDefault()
      if (!template) {
        console.warn('[Debrief] No summary template available; skipping')
        return
      }

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
    } catch (err) {
      console.error('[Debrief] Failed to generate debrief:', (err as Error).message)
    }
  }

  function regenerateDebrief(recordingId: string): void {
    // Clear existing debrief so renderer shows loading state immediately
    recordingRepo.update(recordingId, { debrief: null, debriefAt: null })
    const cleared: RecordingDebriefReadyPayload = { recordingId, debrief: '' }
    mainWindow?.webContents.send(IPC.recording.debriefReady, cleared)
    // Fire and forget — UI will be notified via debriefReady when complete.
    void generateDebrief(recordingId)
  }

  // After recording completes: run diarization then auto-generate debrief
  async function runPostRecordingPipeline(recordingId: string): Promise<void> {
    const recording = recordingRepo.findById(recordingId)
    if (!recording) {
      mainWindow?.webContents.send(IPC.recording.processed, { recordingId })
      return
    }

    // Remove any Whisper hallucination segments (repeated-token loops) before
    // diarization — running diarize on garbage text wastes time and produces
    // incorrect speaker counts.
    const removedCount = transcriptRepo.deleteHallucinatedSegments(recordingId)
    if (removedCount > 0) {
      console.warn(`[PostRecording] Removed ${removedCount} hallucinated segment(s) from recording ${recordingId}`)
      mainWindow?.webContents.send(IPC.transcript.speakersSwept, {
        recordingId,
        segments: transcriptRepo.findByRecordingId(recordingId)
      })
    }

    // Load expected speakers for this recording (empty = match all)
    const expectedSpeakerIds = recordingRepo.getExpectedSpeakerIds(recordingId)
    const speakerFilter = expectedSpeakerIds.length > 0 ? expectedSpeakerIds : undefined

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
      // Live and post-recording both use LIVE_SPEAKER_ID_THRESHOLD (0.85), so
      // this range [threshold, 0.85) is currently empty and this block is a
      // no-op. Kept so a future threshold split (live < post) automatically
      // re-activates without code changes.
      try {
        const borderlineSegs = transcriptRepo.findBorderlineAssignedSegments(
          recordingId, LIVE_SPEAKER_ID_THRESHOLD, 0.85
        )
        if (borderlineSegs.length > 0 && speakerRepo.findWithEmbeddings().length > 0) {
          const clusters = borderlineSegs.map((s) => ({
            id: s.id,
            segments: [{ start: s.timestampStart, end: s.timestampEnd }]
          }))
            const resultsMap = await speakerIdService.identifyBatch(recording.audioPath, clusters, speakerFilter)
          let reswept = 0
          for (const seg of borderlineSegs) {
            const candidates = resultsMap.get(seg.id) ?? []
            const best = candidates[0]
            if (best && (speakerFilter?.length || best.confidence >= SPEAKER_ID_CONFIDENCE_THRESHOLD)) {
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
          await runDiarizationPipeline(recordingId, recording.audioPath, speakerFilter)
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
      // pass using the full audio file.  We score each segment INDIVIDUALLY
      // (via identifyBatch) rather than concatenating them, because lumping
      // all null segments into a single identifyFromAudio call produces an
      // *aggregate* confidence that gets stamped onto every segment — and
      // that aggregate score doesn't reflect per-segment truth (e.g. a clip
      // that actually sounds like Jon can end up labeled "Tony @ 91%" simply
      // because Tony dominated the aggregate).  Per-segment scores keep the
      // displayed confidence honest and let the later highest-match sweep
      // upgrade or correct assignments based on real evidence.
      try {
        const nullSegs = transcriptRepo.findNullSpeakerSegments(recordingId)
        if (nullSegs.length > 0 && speakerRepo.findWithEmbeddings().length > 0) {
          const clusters = nullSegs.map((s) => ({
            id: s.id,
            segments: [{ start: s.timestampStart, end: s.timestampEnd }]
          }))
          const resultsMap = await speakerIdService.identifyBatch(recording.audioPath, clusters, speakerFilter)
          let swept = 0
          for (const seg of nullSegs) {
            const candidates = resultsMap.get(seg.id) ?? []
            const best = candidates[0]
            if (!best || (!speakerFilter?.length && best.confidence < SPEAKER_ID_CONFIDENCE_THRESHOLD)) continue
            transcriptRepo.assignSpeakerToSegmentWithConfidence(
              seg.id, best.speakerId, best.speakerName, best.confidence
            )
            swept++
          }
          if (swept > 0) {
            console.log(`[SpeakerID] Post-recording sweep: ${swept}/${nullSegs.length} null segment(s) assigned per-segment`)
            const updated = transcriptRepo.findByRecordingId(recordingId)
            mainWindow?.webContents.send(IPC.transcript.speakersSwept, { recordingId, segments: updated })
          }
        }
      } catch (sweepErr) {
        console.warn('[SpeakerID] Post-recording null-segment sweep failed:', (sweepErr as Error).message)
      }

      // ── Final highest-match sweep ────────────────────────────────────────
      // Re-evaluates every non-manual segment individually against the now-
      // finalized voice embeddings and assigns whichever speaker scores
      // highest (provided it clears the confidence threshold).  This corrects
      // earlier auto-assignments where a different speaker was a stronger
      // match — e.g. a live-ID call that picked Ed Donner at 78% when Jon
      // would have scored 86% had the embedding been fully trained.
      // Manual assignments (speaker_confidence IS NULL on a real profile id)
      // are excluded so user choices are never overwritten.
      try {
        if (speakerRepo.findWithEmbeddings().length > 0) {
          const reevaluable = transcriptRepo.findReevaluableSegments(recordingId)
          if (reevaluable.length > 0) {
            const clusters = reevaluable.map((s) => ({
              id: s.id,
              segments: [{ start: s.timestampStart, end: s.timestampEnd }]
            }))
            const resultsMap = await speakerIdService.identifyBatch(recording.audioPath, clusters, speakerFilter)
            let updated = 0
            for (const seg of reevaluable) {
              const candidates = resultsMap.get(seg.id) ?? []
              const best = candidates[0]
              if (!best || (!speakerFilter?.length && best.confidence < SPEAKER_ID_CONFIDENCE_THRESHOLD)) continue
              // Only overwrite an existing auto-assignment if the new match
              // is strictly higher confidence — never downgrade.
              if (
                seg.currentConfidence != null &&
                best.confidence <= seg.currentConfidence
              ) continue
              transcriptRepo.assignSpeakerToSegmentWithConfidence(
                seg.id, best.speakerId, best.speakerName, best.confidence
              )
              updated++
            }
            if (updated > 0) {
              console.log(`[SpeakerID] Highest-match sweep: ${updated}/${reevaluable.length} segment(s) re-assigned`)
              const segs = transcriptRepo.findByRecordingId(recordingId)
              mainWindow?.webContents.send(IPC.transcript.speakersSwept, { recordingId, segments: segs })
            }
          }
        }
      } catch (bestErr) {
        console.warn('[SpeakerID] Highest-match sweep failed:', (bestErr as Error).message)
      }
    }

    // ── LLM transcript refinement ─────────────────────────────────────────────
    // Runs after all speaker sweeps so the LLM sees context from real speaker names.
    await refineTranscript(recordingId)

    // ── Debrief generation ────────────────────────────────────────────────────
    await generateDebrief(recordingId)

    // ── Rebuild search embeddings ─────────────────────────────────────────────
    // Reprocess deletes and rewrites all transcript segments, so the search
    // index is stale after transcription. Re-embed just this recording's
    // segments so search stays consistent without a manual Reindex.
    try {
      const { queued } = await embeddingService.indexAll(recordingId)
      if (queued > 0) console.log(`[PostPipeline] Search index: queued ${queued} segment(s) for embedding`)
    } catch (embedErr) {
      console.warn('[PostPipeline] Search re-embedding failed (non-fatal):', (embedErr as Error).message)
    }

    // Ensure the recording ends up in 'complete' state. The reprocess handler
    // sets 'complete' explicitly before calling this pipeline, but reDiarize
    // only sets 'processing' — without this update the recording would stay
    // 'processing' and be reset to 'error' on the next app startup.
    const rec = recordingRepo.findById(recordingId)
    if (rec?.status === 'processing') {
      recordingRepo.update(recordingId, { status: 'complete' })
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
    activeRecordingExpectedSpeakers = []

    await runPostRecordingPipeline(recordingId)
  })

  // Search
  const searchService = new SearchService(getDatabase(), llmService)

  // Register all IPC handlers
  const getWebContents = () => mainWindow?.webContents ?? null

  registerRecordingIpc({
    recordingRepo,
    transcriptRepo,
    speakerRepo,
    audio,
    queue,
    whisper,
    getWebContents,
    triggerPostRecordingPipeline: (recordingId) => void runPostRecordingPipeline(recordingId),
    regenerateDebrief
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
    whisper,
    onHfTokenChange: (hasToken) => { hfTokenConfigured = hasToken }
  })
  registerSpeakerIpc({ speakerRepo })
  registerVoiceIpc({ tts, voiceInput, settings: settingsRepo, getWebContents })
  registerTemplateIpc({ templateRepo, recordingRepo, transcriptRepo, llm: llmService })
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

function getAudioMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return ({
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
  } as Record<string, string>)[ext] ?? 'application/octet-stream'
}

app.whenReady().then(() => {
  setupFileLogger()
  console.log('[App] whenReady fired')
  electronApp.setAppUserModelId('com.calltranscriber.app')

  // Register vbfile:// protocol to serve local audio files to the renderer.
  // URLs are always of the form vbfile://localhost<absolute-path> so that
  // Chromium never confuses the path with a URL authority/hostname.
  // Range requests are handled manually — net.fetch(file://) ignores Range
  // headers and always returns 200, which breaks audio seeking in the player.
  protocol.handle('vbfile', async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)

    let fileSize: number
    try {
      fileSize = statSync(filePath).size
    } catch {
      return new Response(null, { status: 404 })
    }

    const mimeType = getAudioMimeType(filePath)
    const rangeHeader = request.headers.get('range')

    const makeWebStream = (start: number, end: number) => {
      const nodeStream = createReadStream(filePath, { start, end })
      return new ReadableStream({
        start(controller) {
          nodeStream.on('data', (chunk) => controller.enqueue(chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)))
          nodeStream.on('end', () => controller.close())
          nodeStream.on('error', (err) => controller.error(err))
        },
        cancel() { nodeStream.destroy() }
      })
    }

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1
        return new Response(makeWebStream(start, end), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': mimeType,
          }
        })
      }
    }

    return new Response(makeWebStream(0, fileSize - 1), {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize),
        'Content-Type': mimeType,
      }
    })
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
