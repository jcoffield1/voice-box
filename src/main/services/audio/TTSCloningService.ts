/**
 * TTSCloningService — orchestrates F5-TTS zero-shot voice cloning.
 *
 * Responsibilities:
 *  - Track whether the F5-TTS model has been downloaded.
 *  - Trigger model download on demand (user-initiated only — never auto-download).
 *  - Synthesize speech by forwarding requests to python/tts.py via PythonBridge.
 *  - Manage audio sample files under userData/tts-samples/.
 */
import { EventEmitter } from 'events'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'
import { app, dialog } from 'electron'
import type { TtsVoiceSample, Qwen3ModelStatus } from '@shared/types'
import type { TtsVoiceRepository } from '../storage/repositories/TtsVoiceRepository'
import type { RecordingRepository } from '../storage/repositories/RecordingRepository'
import type { TranscriptRepository } from '../storage/repositories/TranscriptRepository'
import type { PythonBridge } from '../../python/PythonBridge'

// Duration (seconds) to clip from an existing recording when no window is specified.
const DEFAULT_CLIP_DURATION = 10
// Minimum / maximum sample duration bounds we enforce.
const MIN_SAMPLE_SEC = 2
const MAX_SAMPLE_SEC = 30
// Maximum samples to auto-extract when adding by speaker.
const MAX_SPEAKER_SAMPLES = 4
// Hard cap on transcript segments scanned per speaker — prevents hanging on large corpuses.
const MAX_SEGMENTS_TO_SCAN = 200

interface CheckModelResponse {
  status: Qwen3ModelStatus
}

interface DownloadModelResponse {
  status: Qwen3ModelStatus
}

interface SynthesizeResponse {
  audio_path: string
}

/** Clip an audio file to [startSec, endSec] using ffmpeg, writing a 16-kHz mono WAV.
 *  Runs ffmpeg directly in Node — no Python bridge or model load required. */
function clipAudio(sourcePath: string, outputPath: string, startSec: number, endSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Prefer the bundled ffmpeg-static binary; fall back to system PATH
    const ffmpeg = (ffmpegStatic as unknown as string) ?? 'ffmpeg'
    mkdirSync(join(outputPath, '..'), { recursive: true })
    const proc = spawn(ffmpeg, [
      '-y',
      '-ss', String(startSec),
      '-i', sourcePath,
      '-t', String(endSec - startSec),
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ])
    const stderr: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.join('').slice(-300)}`))
    })
  })
}

export class TTSCloningService extends EventEmitter {
  private _modelStatus: Qwen3ModelStatus = 'not_downloaded'

  constructor(
    private readonly pythonBridge: PythonBridge,
    private readonly ttsVoiceRepo: TtsVoiceRepository,
    private readonly recordingRepo: RecordingRepository,
    private readonly transcriptRepo: TranscriptRepository
  ) {
    super()
  }

  get modelStatus(): Qwen3ModelStatus {
    return this._modelStatus
  }

  // ─── Model lifecycle ──────────────────────────────────────────────────────

  /**
   * Query Python for the on-disk presence of the F5-TTS weights.
   * Does NOT start a download.
   */
  async checkModelStatus(): Promise<Qwen3ModelStatus> {
    this.ensureTtsBridgeRunning()
    try {
      const res = await this.pythonBridge.send<CheckModelResponse>('tts', 'check_model', {})
      this._modelStatus = res.status
    } catch (err) {
      console.warn('[TTSCloningService] check_model failed:', err)
      this._modelStatus = 'error'
    }
    return this._modelStatus
  }

  /**
   * Trigger the F5-TTS model download.
   * Emits 'download:progress' events as { progress: number (0-100), status }.
   * Resolves when the download is complete (or rejects on error).
   */
  async downloadModel(): Promise<void> {
    this.ensureTtsBridgeRunning()
    this._modelStatus = 'downloading'
    this.emit('download:progress', { progress: 0, status: 'downloading' })

    try {
      const res = await this.pythonBridge.send<DownloadModelResponse>('tts', 'download_model', {})
      this._modelStatus = res.status
      this.emit('download:progress', { progress: 100, status: res.status })
    } catch (err) {
      this._modelStatus = 'error'
      this.emit('download:progress', { progress: 0, status: 'error' })
      throw err
    }
  }

  // ─── Synthesis ────────────────────────────────────────────────────────────

  /**
   * Synthesize `text` in the given voice.
   * Returns the path to the output WAV file.
   */
  async synthesize(voiceId: string, text: string, sampleId?: string): Promise<string> {
    if (this._modelStatus !== 'ready') {
      throw new Error('F5-TTS model is not downloaded. Download it first.')
    }

    this.ensureTtsBridgeRunning()

    const voice = this.ttsVoiceRepo.findById(voiceId)
    if (!voice) throw new Error(`Voice not found: ${voiceId}`)

    const outDir = this.getSamplesDir('synth-output')
    const outPath = join(outDir, `${randomUUID()}.wav`)

    // Resolve the reference audio clip
    let sample: TtsVoiceSample | null = null
    if (sampleId) {
      sample = this.ttsVoiceRepo.findSampleById(sampleId)
    }
    if (!sample) {
      sample = this.ttsVoiceRepo.findLatestSample(voiceId)
    }

    if (sample) {
      // Clone mode: use reference audio
      const res = await this.pythonBridge.send<SynthesizeResponse>('tts', 'synthesize', {
        text,
        reference_audio: sample.audioPath,
        reference_transcript: sample.transcript ?? '',
        output_path: outPath,
      })
      return res.audio_path
    } else if (voice.voiceDesignPrompt) {
      // Design mode: synthesize from text description
      const res = await this.pythonBridge.send<SynthesizeResponse>('tts', 'synthesize', {
        text,
        voice_design_prompt: voice.voiceDesignPrompt,
        output_path: outPath,
      })
      return res.audio_path
    } else {
      throw new Error(
        'No reference audio samples or voice design prompt found for this voice. ' +
        'Add at least one audio sample or set a voice design description.'
      )
    }
  }

  /**
   * Synthesize `text` in the given voice, streaming sentence-by-sentence.
   * `onChunk` is called with the WAV path of each sentence as it completes,
   * so you can start playback before the full utterance is generated.
   */
  async synthesizeStreaming(
    voiceId: string,
    text: string,
    onChunk: (audioPath: string) => void
  ): Promise<void> {
    if (this._modelStatus !== 'ready') {
      throw new Error('F5-TTS model is not downloaded. Download it first.')
    }

    this.ensureTtsBridgeRunning()

    const voice = this.ttsVoiceRepo.findById(voiceId)
    if (!voice) throw new Error(`Voice not found: ${voiceId}`)

    const outDir = this.getSamplesDir('synth-output')

    const sample = this.ttsVoiceRepo.findLatestSample(voiceId) ?? null

    const payload: Record<string, unknown> = { text, output_dir: outDir }
    if (sample) {
      payload.reference_audio = sample.audioPath
      payload.reference_transcript = sample.transcript ?? ''
    } else if (voice.voiceDesignPrompt) {
      payload.voice_design_prompt = voice.voiceDesignPrompt
    } else {
      throw new Error(
        'No reference audio samples or voice design prompt found for this voice. ' +
        'Add at least one audio sample or set a voice design description.'
      )
    }

    await this.pythonBridge.sendStreaming('tts', 'synthesize_stream', payload, (data) => {
      const chunk = data as { audio_path: string }
      if (chunk?.audio_path) {
        onChunk(chunk.audio_path)
      }
    })
  }

  // ─── Sample management ────────────────────────────────────────────────────

  /**
   * Import an audio file as a training sample for a voice.
   * If filePath is omitted a native file dialog is shown.
   */
  async addSampleFromFile(
    voiceId: string,
    opts: { filePath?: string; transcript?: string }
  ): Promise<TtsVoiceSample> {
    let srcPath = opts.filePath
    if (!srcPath) {
      const res = await dialog.showOpenDialog({
        title: 'Select voice reference audio',
        filters: [
          { name: 'Audio Files', extensions: ['wav', 'mp3', 'aiff', 'aif', 'm4a', 'flac', 'ogg'] }
        ],
        properties: ['openFile']
      })
      if (res.canceled || !res.filePaths[0]) {
        throw new Error('File selection cancelled.')
      }
      srcPath = res.filePaths[0]
    }

    if (!existsSync(srcPath)) {
      throw new Error(`Audio file not found: ${srcPath}`)
    }

    // Copy into managed storage so we own the file lifetime
    const destDir = this.getSamplesDir(voiceId)
    const ext = extname(srcPath) || '.wav'
    const destPath = join(destDir, `${randomUUID()}${ext}`)
    copyFileSync(srcPath, destPath)

    const durationSec = await this.probeDuration(srcPath)
    if (durationSec !== null) {
      if (durationSec < MIN_SAMPLE_SEC) {
        throw new Error(`Audio clip is too short (${durationSec.toFixed(1)}s). Minimum is ${MIN_SAMPLE_SEC}s.`)
      }
      if (durationSec > MAX_SAMPLE_SEC) {
        throw new Error(`Audio clip is too long (${durationSec.toFixed(1)}s). Maximum is ${MAX_SAMPLE_SEC}s.`)
      }
    }

    return this.ttsVoiceRepo.addSample(voiceId, destPath, {
      transcript: opts.transcript,
      durationSec: durationSec ?? undefined,
    })
  }

  /**
   * Clip a segment from an existing VoiceBox recording and add it as a sample.
   */
  async addSampleFromRecording(
    voiceId: string,
    recordingId: string,
    opts: { startSec?: number; endSec?: number; transcript?: string }
  ): Promise<TtsVoiceSample> {
    const recording = this.recordingRepo.findById(recordingId)
    if (!recording?.audioPath || !existsSync(recording.audioPath)) {
      throw new Error('Recording audio file not found.')
    }

    // Determine clip window
    const clipStart = opts.startSec ?? 0
    const clipEnd = opts.endSec ?? (clipStart + DEFAULT_CLIP_DURATION)
    const duration = clipEnd - clipStart

    if (duration < MIN_SAMPLE_SEC) {
      throw new Error(`Clip duration too short (${duration.toFixed(1)}s).`)
    }
    if (duration > MAX_SAMPLE_SEC) {
      throw new Error(`Clip duration too long (${duration.toFixed(1)}s). Maximum is ${MAX_SAMPLE_SEC}s.`)
    }

    this.ensureTtsBridgeRunning()
    const destDir = this.getSamplesDir(voiceId)
    const destPath = join(destDir, `${randomUUID()}.wav`)

    // Clip via ffmpeg directly — no need to wake the heavy TTS model for this
    await clipAudio(recording.audioPath, destPath, clipStart, clipEnd)

    if (!existsSync(destPath)) {
      throw new Error('Audio clip extraction failed.')
    }

    return this.ttsVoiceRepo.addSample(voiceId, destPath, {
      transcript: opts.transcript,
      durationSec: duration,
      sourceRecordingId: recordingId,
    })
  }

  /**
   * Auto-extract the best voice segments for a known speaker profile and add them as
   * TTS reference samples.  Picks up to MAX_SPEAKER_SAMPLES clips (3–15 s each) that
   * have good transcript coverage.
   */
  async addSamplesFromSpeaker(voiceId: string, speakerId: string): Promise<TtsVoiceSample[]> {
    this.ensureTtsBridgeRunning()

    const allSegments = this.transcriptRepo.findBySpeakerId(speakerId)
    // Cap the segment scan to avoid hanging on large corpuses
    const segments = allSegments.slice(0, MAX_SEGMENTS_TO_SCAN)
    if (segments.length === 0) {
      throw new Error('No transcript segments found for this speaker.')
    }

    this.emit('voice-creation:progress', {
      voiceId, percent: 10,
      message: `Scanning ${segments.length} transcript segment${segments.length !== 1 ? 's' : ''}…`,
      done: false,
    })

    // Group consecutive segments within the same recording into candidate clips
    interface Candidate {
      recordingAudioPath: string
      recordingId: string
      startSec: number
      endSec: number
      transcript: string
    }

    const candidates: Candidate[] = []
    let current: Candidate | null = null

    for (const seg of segments) {
      if (!seg.recordingAudioPath) continue

      const gap = current
        ? seg.recordingId === current.recordingId && seg.timestampStart - current.endSec
        : Infinity

      // Merge into current clip if same recording and gap < 1 second, else start new
      if (current && seg.recordingId === current.recordingId && typeof gap === 'number' && gap < 1) {
        current.endSec = seg.timestampEnd
        current.transcript += ' ' + seg.text
        if (current.endSec - current.startSec >= MAX_SAMPLE_SEC) {
          // Clip is long enough — bank it and start fresh
          candidates.push({ ...current })
          current = null
        }
      } else {
        if (current && current.endSec - current.startSec >= MIN_SAMPLE_SEC) {
          candidates.push({ ...current })
        }
        current = {
          recordingAudioPath: seg.recordingAudioPath,
          recordingId: seg.recordingId,
          startSec: seg.timestampStart,
          endSec: seg.timestampEnd,
          transcript: seg.text,
        }
      }
    }
    if (current && current.endSec - current.startSec >= MIN_SAMPLE_SEC) {
      candidates.push(current)
    }

    if (candidates.length === 0) {
      throw new Error('No usable audio segments found for this speaker (all too short).')
    }

    this.emit('voice-creation:progress', {
      voiceId, percent: 35,
      message: 'Identifying candidate clips…',
      done: false,
    })

    // Sort by duration descending, pick the best ones (prefer 5–15 s clips)
    const scored = candidates
      .map((c) => ({ ...c, duration: c.endSec - c.startSec }))
      .filter((c) => c.duration >= MIN_SAMPLE_SEC && c.duration <= MAX_SAMPLE_SEC)
      .sort((a, b) => {
        // Prefer clips closer to 8 s
        const target = 8
        return Math.abs(a.duration - target) - Math.abs(b.duration - target)
      })
      .slice(0, MAX_SPEAKER_SAMPLES)

    if (scored.length === 0) {
      throw new Error(`All candidate clips were outside the ${MIN_SAMPLE_SEC}–${MAX_SAMPLE_SEC}s range.`)
    }

    this.emit('voice-creation:progress', {
      voiceId, percent: 50,
      message: `Extracting ${scored.length} clip${scored.length !== 1 ? 's' : ''}…`,
      done: false,
    })

    const destDir = this.getSamplesDir(voiceId)
    const added: TtsVoiceSample[] = []

    for (let i = 0; i < scored.length; i++) {
      const clip = scored[i]
      this.emit('voice-creation:progress', {
        voiceId,
        percent: Math.round(50 + (45 * i / scored.length)),
        message: `Extracting clip ${i + 1} of ${scored.length}…`,
        done: false,
      })
      const destPath = join(destDir, `${randomUUID()}.wav`)
      await clipAudio(clip.recordingAudioPath, destPath, clip.startSec, clip.endSec)
      if (!existsSync(destPath)) continue
      const sample = this.ttsVoiceRepo.addSample(voiceId, destPath, {
        transcript: clip.transcript.trim(),
        durationSec: clip.duration,
        sourceRecordingId: clip.recordingId,
      })
      added.push(sample)
    }

    this.emit('voice-creation:progress', {
      voiceId,
      percent: 100,
      message: `${added.length} sample${added.length !== 1 ? 's' : ''} ready`,
      done: true,
    })

    return added
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private ensureTtsBridgeRunning(): void {
    if (!this.pythonBridge.isRunning('tts')) {
      this.pythonBridge.start('tts')
    }
  }

  private getSamplesDir(subdir: string): string {
    const base = join(app.getPath('userData'), 'tts-samples', subdir)
    mkdirSync(base, { recursive: true })
    return base
  }

  /**
   * Probe audio duration via Python (uses soundfile / mutagen if available).
   * Returns null if probing fails — callers still proceed; duration is advisory.
   */
  private async probeDuration(audioPath: string): Promise<number | null> {
    try {
      this.ensureTtsBridgeRunning()
      const res = await this.pythonBridge.send<{ duration_sec: number | null }>(
        'tts',
        'probe_duration',
        { audio_path: audioPath }
      )
      return res.duration_sec
    } catch {
      // Duration is advisory — don't block the import
      return null
    }
  }
}
