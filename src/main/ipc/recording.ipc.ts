import { ipcMain, app, systemPreferences, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/ipc-types'
import type {
  StartRecordingArgs,
  StartRecordingResult,
  StopRecordingArgs,
  StopRecordingResult,
  GetRecordingsResult,
  GetRecordingArgs,
  GetRecordingResult,
  UpdateRecordingArgs,
  DeleteRecordingArgs,
  ExportTranscriptArgs,
  ExportTranscriptResult
} from '@shared/ipc-types'
import type { RecordingRepository } from '../services/storage/repositories/RecordingRepository'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { AudioCaptureService } from '../services/audio/AudioCaptureService'
import type { TranscriptionQueue } from '../services/transcription/TranscriptionQueue'
import type { WebContents } from 'electron'

interface RecordingIpcDeps {
  recordingRepo: RecordingRepository
  transcriptRepo: TranscriptRepository
  audio: AudioCaptureService
  queue: TranscriptionQueue
  getWebContents: () => WebContents | null
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function registerRecordingIpc(deps: RecordingIpcDeps): void {
  const { recordingRepo, transcriptRepo, audio, queue, getWebContents } = deps

  // Register once — not inside the start handler, to avoid accumulating listeners
  queue.on('segment', (segment) => {
    getWebContents()?.send(IPC.transcript.segmentAdded, segment)
  })

  ipcMain.handle(IPC.recording.start, async (_event, args: StartRecordingArgs): Promise<StartRecordingResult> => {
    // On macOS, ensure microphone permission before attempting to open the device.
    // This prompts the TCC dialog if not yet decided, and surfaces a clear error
    // with a link to System Settings if access has been denied.
    if (process.platform === 'darwin') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
        throw new Error(
          'Microphone access denied. Grant access in System Settings → Privacy & Security → Microphone, then try again.'
        )
      }
    }

    const recording = recordingRepo.create(args.title)
    audio.start(args.config)

    // If audio failed to start (e.g. device unavailable), clean up and surface the error.
    if (audio.getState() === 'error') {
      recordingRepo.update(recording.id, { status: 'error' })
      throw new Error('Failed to open audio device. Check microphone permissions.')
    }

    queue.start(recording.id)

    return { recordingId: recording.id }
  })

  ipcMain.handle(IPC.recording.stop, async (_event, args: StopRecordingArgs): Promise<StopRecordingResult> => {
    audio.stop()

    // Persist audioPath to the DB BEFORE calling queue.stop(). queue.stop() emits
    // 'complete' synchronously, and the handler in index.ts reads recording.audioPath
    // immediately (synchronous SQLite read). If we write audioPath afterwards the
    // handler always sees null and skips diarization entirely.
    const audioPath = join(app.getPath('userData'), 'recordings', `${args.recordingId}.wav`)
    audio.saveAudio(audioPath)

    const durationSeconds = Math.round((Date.now() - (recordingRepo.findById(args.recordingId)?.createdAt ?? Date.now())) / 1000)
    const recording = recordingRepo.update(args.recordingId, {
      status: 'complete',
      duration: durationSeconds,
      audioPath
    })

    // Flush remaining transcription — 'complete' fires here, index.ts will now
    // find recording.audioPath already written and run the diarization pipeline.
    await queue.stop()

    return { recordingId: args.recordingId, duration: recording?.duration ?? 0 }
  })

  ipcMain.handle(IPC.recording.getAll, async (): Promise<GetRecordingsResult> => {
    return { recordings: recordingRepo.findAll() }
  })

  ipcMain.handle(IPC.recording.get, async (_event, args: GetRecordingArgs): Promise<GetRecordingResult> => {
    return { recording: recordingRepo.findById(args.recordingId) }
  })

  ipcMain.handle(IPC.recording.update, async (_event, args: UpdateRecordingArgs): Promise<GetRecordingResult> => {
    const recording = recordingRepo.update(args.recordingId, {
      title: args.title,
      notes: args.notes,
      tags: args.tags
    })
    return { recording }
  })

  ipcMain.handle(IPC.recording.delete, async (_event, args: DeleteRecordingArgs): Promise<void> => {
    recordingRepo.delete(args.recordingId)
  })

  // ─── Export Transcript ───────────────────────────────────────────────────

  ipcMain.handle(IPC.recording.export, async (_event, args: ExportTranscriptArgs): Promise<ExportTranscriptResult> => {
    const recording = recordingRepo.findById(args.recordingId)
    if (!recording) throw new Error(`Recording not found: ${args.recordingId}`)

    const segments = transcriptRepo.findByRecordingId(args.recordingId)
    const date = new Date(recording.createdAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    })

    let content: string
    const safeTitle = recording.title.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim()

    if (args.format === 'srt') {
      content = segments.map((seg, i) => {
        const start = srtTime(seg.timestampStart)
        const end = srtTime(seg.timestampEnd)
        const speaker = seg.speakerName ? `${seg.speakerName}: ` : ''
        return `${i + 1}\n${start} --> ${end}\n${speaker}${seg.text}\n`
      }).join('\n')
    } else if (args.format === 'md') {
      const header = `# ${recording.title}\n\n**Date:** ${date}\n**Duration:** ${recording.duration ? formatTime(recording.duration) : 'unknown'}\n\n---\n\n`
      const summary = recording.summary ? `## Summary\n\n${recording.summary}\n\n---\n\n## Transcript\n\n` : `## Transcript\n\n`
      const body = segments.map((seg) => {
        const ts = formatTime(seg.timestampStart)
        const speaker = seg.speakerName ?? 'Unknown'
        return `**[${ts}] ${speaker}:** ${seg.text}`
      }).join('\n\n')
      content = header + summary + body
    } else {
      // plain text
      const header = `${recording.title}\n${'='.repeat(recording.title.length)}\nDate: ${date}\n\n`
      const body = segments.map((seg) => {
        const ts = formatTime(seg.timestampStart)
        const speaker = seg.speakerName ?? 'Unknown'
        return `[${ts}] ${speaker}: ${seg.text}`
      }).join('\n')
      content = header + body
    }

    return {
      content,
      filename: `${safeTitle}.${args.format}`
    }
  })
}

function srtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

