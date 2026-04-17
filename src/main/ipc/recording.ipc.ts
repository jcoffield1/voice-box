import { ipcMain, app, systemPreferences, shell, dialog, BrowserWindow } from 'electron'
import { join, basename, extname } from 'path'
import { promises as fs, copyFileSync } from 'fs'
import { marked } from 'marked'
import {
  Document, Paragraph, TextRun, HeadingLevel, Packer, BorderStyle
} from 'docx'
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
  ImportAudioArgs,
  ImportAudioResult,
  ExportTranscriptArgs,
  ExportTranscriptResult,
  ExportSummaryArgs,
  ExportSummaryResult
} from '@shared/ipc-types'
import type { RecordingRepository } from '../services/storage/repositories/RecordingRepository'
import type { TranscriptRepository } from '../services/storage/repositories/TranscriptRepository'
import type { AudioCaptureService } from '../services/audio/AudioCaptureService'
import type { TranscriptionQueue } from '../services/transcription/TranscriptionQueue'
import type { WhisperService } from '../services/transcription/WhisperService'
import type { WebContents } from 'electron'

interface RecordingIpcDeps {
  recordingRepo: RecordingRepository
  transcriptRepo: TranscriptRepository
  audio: AudioCaptureService
  queue: TranscriptionQueue
  whisper: WhisperService
  getWebContents: () => WebContents | null
  triggerPostRecordingPipeline: (recordingId: string) => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function registerRecordingIpc(deps: RecordingIpcDeps): void {
  const { recordingRepo, transcriptRepo, audio, queue, whisper, getWebContents, triggerPostRecordingPipeline } = deps

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

  // ─── Import Audio File ────────────────────────────────────────────────────

  ipcMain.handle(IPC.recording.import, async (_event, args: ImportAudioArgs): Promise<ImportAudioResult> => {
    const SUPPORTED_EXTENSIONS = ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'webm', 'mp4']

    let sourcePath: string | undefined = args?.filePath

    if (!sourcePath) {
      const win = BrowserWindow.fromWebContents(_event.sender) ?? BrowserWindow.getFocusedWindow()
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import Audio File',
        properties: ['openFile'],
        filters: [
          { name: 'Audio Files', extensions: SUPPORTED_EXTENSIONS },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) {
        throw new Error('Import cancelled')
      }
      sourcePath = result.filePaths[0]
    }

    // Derive a title from the filename (strip extension)
    const ext = extname(sourcePath).toLowerCase().slice(1)
    const nameWithExt = basename(sourcePath)
    const title = nameWithExt.replace(/\.[^.]+$/, '')

    // Copy audio into the recordings folder so we have a stable internal path
    const recordingsDir = join(app.getPath('userData'), 'recordings')
    await fs.mkdir(recordingsDir, { recursive: true })

    const recording = recordingRepo.create(title)
    const destPath = join(recordingsDir, `${recording.id}.${ext}`)
    copyFileSync(sourcePath, destPath)

    // Mark as processing immediately and persist the audio path
    recordingRepo.update(recording.id, { status: 'processing', audioPath: destPath })

    // Run transcription + pipeline asynchronously; return the recordingId right
    // away so the renderer can navigate to the new recording page immediately.
    void (async () => {
      try {
        console.log(`[Import] Starting transcription for "${title}" (${destPath})`)
        const segments = await whisper.transcribeFile(destPath)

        for (const seg of segments) {
          if (!seg.text.trim()) continue
          if (seg.confidence < -0.7) continue
          transcriptRepo.create({
            recordingId: recording.id,
            text: seg.text,
            timestampStart: seg.start,
            timestampEnd: seg.end,
            whisperConfidence: seg.confidence
          })
        }

        const lastSeg = segments[segments.length - 1]
        const duration = lastSeg ? Math.round(lastSeg.end) : null
        recordingRepo.update(recording.id, { status: 'complete', duration })

        console.log(`[Import] Transcription done — ${segments.length} segments. Triggering post-recording pipeline.`)

        // Reuse the exact same diarization + debrief pipeline as live recordings
        triggerPostRecordingPipeline(recording.id)
      } catch (err) {
        console.error('[Import] Pipeline failed:', (err as Error).message)
        recordingRepo.update(recording.id, { status: 'error' })
        getWebContents()?.send(IPC.recording.processed, { recordingId: recording.id })
      }
    })()

    return { recordingId: recording.id }
  })

  // ─── Export Transcript (txt / md / srt) ───────────────────────────────────

  ipcMain.handle(IPC.recording.export, async (_event, args: ExportTranscriptArgs): Promise<ExportTranscriptResult> => {
    const recording = recordingRepo.findById(args.recordingId)
    if (!recording) throw new Error(`Recording not found: ${args.recordingId}`)

    const segments = transcriptRepo.findByRecordingId(args.recordingId)
    const date = new Date(recording.createdAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    })
    const safeTitle = recording.title.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim() || 'recording'
    let content: string

    if (args.format === 'srt') {
      content = segments.map((seg, i) => {
        const start = srtTime(seg.timestampStart)
        const end = srtTime(seg.timestampEnd)
        const speaker = seg.speakerName ? `${seg.speakerName}: ` : ''
        return `${i + 1}\n${start} --> ${end}\n${speaker}${seg.text}\n`
      }).join('\n')
    } else if (args.format === 'md') {
      const header = `# ${recording.title}\n\n**Date:** ${date}\n**Duration:** ${recording.duration ? formatTime(recording.duration) : 'unknown'}\n\n---\n\n## Transcript\n\n`
      const body = segments.map((seg) => {
        const ts = formatTime(seg.timestampStart)
        const speaker = seg.speakerName ?? 'Unknown'
        return `**[${ts}] ${speaker}:** ${seg.text}`
      }).join('\n\n')
      content = header + body
    } else {
      // txt
      const header = `${recording.title}\n${'='.repeat(recording.title.length)}\nDate: ${date}\n\n`
      const body = segments.map((seg) => {
        const ts = formatTime(seg.timestampStart)
        const speaker = seg.speakerName ?? 'Unknown'
        return `[${ts}] ${speaker}: ${seg.text}`
      }).join('\n')
      content = header + body
    }

    return { content, filename: `${safeTitle}.${args.format}` }
  })

  // ─── Export Summary (pdf / docx / md / txt) ─────────────────────────────

  ipcMain.handle(IPC.recording.exportSummary, async (_event, args: ExportSummaryArgs): Promise<ExportSummaryResult> => {
    const recording = recordingRepo.findById(args.recordingId)
    if (!recording) throw new Error(`Recording not found: ${args.recordingId}`)

    const summary = recording.debrief ?? recording.summary ?? ''
    const date = new Date(recording.createdAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    })
    const duration = recording.duration ? formatTime(recording.duration) : 'unknown'
    const safeTitle = recording.title.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim() || 'recording'

    const filterMap: Record<string, Electron.FileFilter[]> = {
      txt:  [{ name: 'Plain Text', extensions: ['txt'] }],
      md:   [{ name: 'Markdown', extensions: ['md'] }],
      docx: [{ name: 'Word Document', extensions: ['docx'] }],
      pdf:  [{ name: 'PDF Document', extensions: ['pdf'] }],
    }

    const win = BrowserWindow.fromWebContents(_event.sender)
    const { filePath } = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Export Summary',
      defaultPath: join(app.getPath('documents'), `${safeTitle}-summary.${args.format}`),
      filters: filterMap[args.format],
    })

    if (!filePath) return { savedTo: null }

    if (args.format === 'txt') {
      const divider = '─'.repeat(60)
      let out = `${recording.title}\n${'='.repeat(recording.title.length)}\n`
      out += `Date:      ${date}\nDuration:  ${duration}\n`
      out += `${divider}\n\nSUMMARY\n${divider}\n\n${summary}\n`
      await fs.writeFile(filePath, out, 'utf8')

    } else if (args.format === 'md') {
      let out = `# ${recording.title}\n\n`
      out += `> **Date:** ${date} &nbsp;·&nbsp; **Duration:** ${duration}\n\n`
      out += `---\n\n## Summary\n\n${summary}\n`
      await fs.writeFile(filePath, out, 'utf8')

    } else if (args.format === 'docx') {
      // Parse inline markdown (**bold**, *italic*, `code`) into TextRuns
      const inlineRuns = (text: string): TextRun[] => {
        const runs: TextRun[] = []
        const re = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+)/gs
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          if (m[1]) runs.push(new TextRun({ text: m[1], bold: true, size: 22 }))
          else if (m[2]) runs.push(new TextRun({ text: m[2], italics: true, size: 22 }))
          else if (m[3]) runs.push(new TextRun({ text: m[3], font: 'Courier New', size: 20 }))
          else if (m[4]) runs.push(new TextRun({ text: m[4], size: 22 }))
        }
        return runs.length > 0 ? runs : [new TextRun({ text, size: 22 })]
      }

      // Parse markdown blocks into Paragraph objects
      const mdToDocxParagraphs = (text: string): Paragraph[] => {
        const paras: Paragraph[] = []
        for (const line of text.split('\n')) {
          const t = line.trimEnd()
          const h1 = t.match(/^# (.+)$/)
          const h2 = t.match(/^## (.+)$/)
          const h3 = t.match(/^### (.+)$/)
          const ul = t.match(/^[*\-] (.+)$/)
          const ol = t.match(/^\d+\. (.+)$/)
          const hr = t.match(/^---+$/)
          if (h1) {
            paras.push(new Paragraph({ text: h1[1].replace(/\*\*/g, ''), heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 120 } }))
          } else if (h2) {
            paras.push(new Paragraph({ text: h2[1].replace(/\*\*/g, ''), heading: HeadingLevel.HEADING_3, spacing: { before: 240, after: 80 } }))
          } else if (h3) {
            paras.push(new Paragraph({ children: [new TextRun({ text: h3[1].replace(/\*\*/g, ''), bold: true, size: 22 })], spacing: { before: 160, after: 60 } }))
          } else if (ul) {
            paras.push(new Paragraph({ children: inlineRuns(ul[1]), bullet: { level: 0 }, spacing: { after: 40 } }))
          } else if (ol) {
            paras.push(new Paragraph({ children: inlineRuns(ol[1]), bullet: { level: 0 }, spacing: { after: 40 } }))
          } else if (hr) {
            paras.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' } }, spacing: { before: 80, after: 80 } }))
          } else if (t.trim()) {
            paras.push(new Paragraph({ children: inlineRuns(t), spacing: { after: 100 } }))
          } else {
            paras.push(new Paragraph({ text: '', spacing: { after: 60 } }))
          }
        }
        return paras
      }

      const docChildren: Paragraph[] = []

      docChildren.push(new Paragraph({
        text: recording.title,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 120 },
      }))
      docChildren.push(new Paragraph({
        children: [
          new TextRun({ text: `Date: ${date}`, color: '666666', size: 20 }),
          new TextRun({ text: '   ·   ', color: 'AAAAAA', size: 20 }),
          new TextRun({ text: `Duration: ${duration}`, color: '666666', size: 20 }),
        ],
        spacing: { after: 240 },
      }))
      docChildren.push(new Paragraph({
        text: 'Summary',
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' } },
      }))
      docChildren.push(...mdToDocxParagraphs(summary))

      const doc = new Document({
        creator: 'VoiceBox',
        title: recording.title,
        description: `Summary exported from VoiceBox on ${date}`,
        styles: {
          paragraphStyles: [
            { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', run: { size: 40, bold: true, color: '1a1a2e' }, paragraph: { spacing: { after: 120 } } },
            { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', run: { size: 28, bold: true, color: '2c3e50' }, paragraph: { spacing: { before: 360, after: 120 } } },
          ],
        },
        sections: [{ children: docChildren }],
      })
      await fs.writeFile(filePath, await Packer.toBuffer(doc))

    } else if (args.format === 'pdf') {
      const escHtml = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

      // Convert markdown to HTML so bold, headings, bullets etc. render correctly
      marked.setOptions({ async: false })
      const summaryHtml = marked.parse(summary) as string

      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  @page { margin: 20mm 22mm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; color: #1a1a2e; line-height: 1.7; margin: 0; }
  h1.doc-title { font-size: 20pt; margin: 0 0 4px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .meta { color: #777; font-size: 9pt; margin-bottom: 20px; font-family: Arial, sans-serif; }
  hr.divider { border: none; border-top: 1px solid #ccc; margin: 18px 0; }
  .summary-body h1 { font-size: 14pt; color: #1a1a2e; margin: 18px 0 8px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .summary-body h2 { font-size: 13pt; color: #2c3e50; margin: 16px 0 7px; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .summary-body h3 { font-size: 11.5pt; color: #2c3e50; margin: 14px 0 5px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .summary-body p { margin: 0 0 9px; }
  .summary-body ul, .summary-body ol { margin: 0 0 9px; padding-left: 22px; }
  .summary-body li { margin-bottom: 4px; }
  .summary-body strong { font-weight: 700; color: #111; }
  .summary-body em { font-style: italic; }
  .summary-body blockquote { border-left: 3px solid #ccc; margin: 0 0 9px 0; padding: 4px 12px; color: #555; }
  .summary-body code { font-family: 'Courier New', monospace; background: #f4f4f4; padding: 1px 4px; border-radius: 2px; font-size: 10pt; }
  .footer { text-align: center; font-size: 8pt; color: #aaa; margin-top: 32px; font-family: Arial, sans-serif; }
</style></head><body>
<h1 class="doc-title">${escHtml(recording.title)}</h1>
<div class="meta">${escHtml(date)} &nbsp;·&nbsp; ${escHtml(duration)}</div>
<hr class="divider">
<div class="summary-body">${summaryHtml}</div>
<div class="footer">Exported from VoiceBox</div>
</body></html>`

      const pdfWin = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
      await pdfWin.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
      const pdfBuffer = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
        margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
      })
      pdfWin.destroy()
      await fs.writeFile(filePath, pdfBuffer)
    }

    shell.showItemInFolder(filePath)
    return { savedTo: filePath }
  })
}

function srtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

