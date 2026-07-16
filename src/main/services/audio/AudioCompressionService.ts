import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, promises as fs } from 'fs'
import type { RecordingRepository } from '../storage/repositories/RecordingRepository'

interface CompressResult {
  success: boolean
  duration_in?: number
  duration_out?: number
  size_in?: number
  size_out?: number
  error?: string
}

/** Max allowed drift between source and encoded duration (seconds). */
const DURATION_TOLERANCE_S = 2.0
/** Encoding watchdog — kills a hung python process. */
const ENCODE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * AudioCompressionService — background WAV → AAC (.m4a) compression.
 *
 * Recordings are saved as uncompressed WAV (~115 MB/hour). Once a recording is
 * fully processed, this service re-encodes it to mono AAC (~28 MB/hour) via a
 * one-shot PyAV script and swaps the recording's audioPath over.
 *
 * Fail-safe contract — the original WAV is NEVER deleted until:
 *   1. the encode completed without error,
 *   2. the output file was fully re-decoded and its duration matches the source,
 *   3. the .part file was atomically renamed to its final .m4a name, and
 *   4. the DB row was updated AND read back pointing at the new file.
 * Any failure at any step leaves the WAV untouched; a stale .part file is the
 * only possible residue, and those are cleaned up on the next startup sweep.
 */
export class AudioCompressionService {
  private queue: string[] = []
  private running = false
  private activeChild: ChildProcess | null = null
  private shuttingDown = false

  constructor(
    private readonly recordingRepo: RecordingRepository,
    /** Called with the recording id after a successful swap so the renderer
     *  can refresh the recording (new audioPath). */
    private readonly onCompressed: (recordingId: string) => void
  ) {}

  /** Queue a recording for compression (no-op if already queued or ineligible). */
  enqueue(recordingId: string): void {
    if (this.shuttingDown) return
    if (this.queue.includes(recordingId)) return
    this.queue.push(recordingId)
    void this.processQueue()
  }

  /** Stop queue processing and kill any in-flight encoder. Called on app quit —
   *  the abandoned .part file is cleaned up by the next startup sweep. */
  shutdown(): void {
    this.shuttingDown = true
    this.queue = []
    if (this.activeChild) {
      try { this.activeChild.kill('SIGKILL') } catch { /* already dead */ }
      this.activeChild = null
    }
  }

  /** Clean stale .part files and queue every eligible recording. Called once
   *  shortly after startup to compress the existing back catalog. */
  async sweepAll(): Promise<void> {
    const recordingsDir = join(app.getPath('userData'), 'recordings')
    try {
      for (const f of await fs.readdir(recordingsDir)) {
        if (f.endsWith('.part')) {
          await fs.unlink(join(recordingsDir, f)).catch(() => {})
          console.log(`[Compress] Removed stale partial file: ${f}`)
        }
      }
    } catch {
      // recordings dir may not exist yet
    }

    let queued = 0
    for (const rec of this.recordingRepo.findAll()) {
      if (rec.status === 'complete' && rec.audioPath?.toLowerCase().endsWith('.wav')) {
        this.enqueue(rec.id)
        queued++
      }

      // Finish an interrupted swap: if the app quit between the DB update and
      // the WAV removal, the recording points at a valid .m4a but the sibling
      // .wav is still on disk. Delete it — but only after confirming the
      // attached .m4a actually exists.
      if (rec.audioPath?.toLowerCase().endsWith('.m4a') && existsSync(rec.audioPath)) {
        const siblingWav = rec.audioPath.replace(/\.m4a$/i, '.wav')
        if (existsSync(siblingWav)) {
          await fs.unlink(siblingWav).catch(() => {})
          console.log(`[Compress] Removed leftover WAV from interrupted swap: ${siblingWav}`)
        }
      }
    }
    if (queued > 0) console.log(`[Compress] Startup sweep queued ${queued} recording(s)`)
  }

  private async processQueue(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        try {
          await this.compressOne(id)
        } catch (err) {
          console.error(`[Compress] Failed for recording ${id} (WAV kept):`, (err as Error).message)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async compressOne(recordingId: string): Promise<void> {
    const rec = this.recordingRepo.findById(recordingId)
    // Eligibility re-checked at run time — state may have changed since enqueue
    if (!rec?.audioPath) return
    if (rec.status !== 'complete') return
    if (!rec.audioPath.toLowerCase().endsWith('.wav')) return
    if (!existsSync(rec.audioPath)) return

    const wavPath = rec.audioPath
    const finalPath = wavPath.replace(/\.wav$/i, '.m4a')
    const partPath = `${finalPath}.part`

    console.log(`[Compress] Encoding ${recordingId} → ${finalPath}`)
    const result = await this.runScript(wavPath, partPath)

    try {
      // ── Verification gauntlet — any failure keeps the WAV ─────────────────
      if (!result.success) {
        throw new Error(result.error ?? 'encoder reported failure')
      }
      const stat = await fs.stat(partPath)
      if (stat.size < 1000) {
        throw new Error(`output suspiciously small (${stat.size} bytes)`)
      }
      if (
        result.duration_in == null ||
        result.duration_out == null ||
        Math.abs(result.duration_in - result.duration_out) > DURATION_TOLERANCE_S
      ) {
        throw new Error(
          `duration mismatch: in=${result.duration_in}s out=${result.duration_out}s`
        )
      }

      // ── Pre-commit eligibility re-check ───────────────────────────────────
      // The encode takes seconds to minutes; the recording may have been
      // deleted or sent back into reprocessing in the meantime. Abort and
      // leave everything as-is if the world changed under us.
      const current = this.recordingRepo.findById(recordingId)
      if (!current) {
        throw new Error('recording was deleted during encode — discarding output')
      }
      if (current.status !== 'complete' || current.audioPath !== wavPath) {
        throw new Error('recording changed during encode (reprocess?) — discarding output')
      }

      // ── Commit: atomic rename → DB swap → read-back check ─────────────────
      await fs.rename(partPath, finalPath)
      this.recordingRepo.update(recordingId, { audioPath: finalPath })
      const check = this.recordingRepo.findById(recordingId)
      if (check?.audioPath !== finalPath) {
        // Row vanished or update failed — remove the m4a we just created so a
        // deleted recording doesn't leave an orphaned file behind.
        await fs.unlink(finalPath).catch(() => {})
        throw new Error('DB read-back does not show new audioPath — output discarded, WAV kept')
      }
    } catch (err) {
      await fs.unlink(partPath).catch(() => {})
      throw err
    }

    // ── Only now is the original safe to remove ───────────────────────────────
    try {
      await fs.unlink(wavPath)
    } catch (err) {
      // Non-fatal: recording already points at the m4a; the orphaned WAV will
      // just sit on disk. Log so it's discoverable.
      console.warn(`[Compress] Could not remove original WAV ${wavPath}:`, (err as Error).message)
    }

    const savedMb = ((result.size_in ?? 0) - (result.size_out ?? 0)) / 1024 / 1024
    console.log(
      `[Compress] Done ${recordingId}: ${((result.size_in ?? 0) / 1024 / 1024).toFixed(1)} MB → ` +
      `${((result.size_out ?? 0) / 1024 / 1024).toFixed(1)} MB (saved ${savedMb.toFixed(1)} MB)`
    )
    this.onCompressed(recordingId)
  }

  private getPythonPath(): string {
    if (!app.isPackaged) {
      const venvPython = join(app.getAppPath(), 'python', 'venv', 'bin', 'python3')
      if (existsSync(venvPython)) return venvPython
      return 'python3'
    }
    return join(process.resourcesPath, 'python', 'venv', 'bin', 'python3')
  }

  private getScriptPath(): string {
    const dir = app.isPackaged ? join(process.resourcesPath, 'python') : join(app.getAppPath(), 'python')
    return join(dir, 'compress_audio.py')
  }

  private runScript(src: string, dst: string): Promise<CompressResult> {
    return new Promise((resolve) => {
      if (this.shuttingDown) {
        resolve({ success: false, error: 'app is shutting down' })
        return
      }
      const child = spawn(this.getPythonPath(), ['-u', this.getScriptPath(), src, dst])
      this.activeChild = child
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ success: false, error: `encode timed out after ${ENCODE_TIMEOUT_MS / 60000} min` })
      }, ENCODE_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(timer)
        this.activeChild = null
        resolve({ success: false, error: `failed to spawn python: ${err.message}` })
      })
      child.on('close', () => {
        clearTimeout(timer)
        this.activeChild = null
        if (this.shuttingDown) {
          resolve({ success: false, error: 'encode aborted by app shutdown' })
          return
        }
        const lastLine = stdout.trim().split('\n').pop() ?? ''
        try {
          resolve(JSON.parse(lastLine) as CompressResult)
        } catch {
          resolve({ success: false, error: `unparseable encoder output: ${lastLine || stderr.slice(0, 500)}` })
        }
      })
    })
  }
}
