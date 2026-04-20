import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import { createInterface } from 'readline'

export type PythonScriptName = 'transcribe' | 'diarize' | 'embed_voice' | 'tts'

interface PendingRequest {
  processName: PythonScriptName
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface JsonResponse {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

interface StreamingResponse {
  id: string
  streaming: true
  done: boolean
  data?: unknown
  error?: string
}

interface PendingStreamingRequest {
  processName: PythonScriptName
  onChunk: (data: unknown) => void
  resolve: () => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const MAX_RETRIES = 3
const REQUEST_TIMEOUT_MS = 120_000

/** Per-process overrides for requests that are known to be slow.
 *  Diarization runs a full neural speaker-separation pipeline on CPU/MPS and
 *  can take 3–8 minutes for longer recordings — 2 minutes is far too short.
 *  TTS cold-start loads ~3.4 GB of weights; first synthesis adds another
 *  1–3 minutes on CPU — give 15 minutes total. */
const PROCESS_TIMEOUT_MS: Partial<Record<PythonScriptName, number>> = {
  diarize: 600_000,  // 10 minutes
  tts: 900_000,      // 15 minutes (cold-start weight load + first inference)
}

interface QueuedSend {
  doWrite: () => void
  reject: (err: Error) => void
}

export class PythonBridge extends EventEmitter {
  private processes: Map<PythonScriptName, ChildProcess> = new Map()
  private pending: Map<string, PendingRequest> = new Map()
  private pendingStreaming: Map<string, PendingStreamingRequest> = new Map()
  private retries: Map<PythonScriptName, number> = new Map()
  private restarting: Set<PythonScriptName> = new Set()
  /** True once the process has emitted {startup:'ready'} on stdout */
  private processReady: Map<PythonScriptName, boolean> = new Map()
  /** Writes buffered while the process is still starting up */
  private startupQueue: Map<PythonScriptName, QueuedSend[]> = new Map()
  /** Extra env vars injected into every spawned process */
  private extraEnv: Record<string, string> = {}

  /** Inject an environment variable into all future (and restarted) processes.
   *  Call this before start() for it to take effect on the initial spawn. */
  setEnv(key: string, value: string): void {
    this.extraEnv[key] = value
  }

  private getPythonPath(): string {
    const isDev = !app.isPackaged
    if (isDev) {
      // Prefer the venv built by `npm run setup:python`; fall back to system
      // python3 so the app doesn't crash before the venv exists.
      const venvPython = join(app.getAppPath(), 'python', 'venv', 'bin', 'python3')
      if (existsSync(venvPython)) return venvPython
      console.warn('[PythonBridge] python/venv not found — run `npm run setup:python`. Falling back to system python3.')
      return 'python3'
    }
    // In production, use bundled venv shipped inside app resources
    return join(process.resourcesPath, 'python', 'venv', 'bin', 'python3')
  }

  private getScriptPath(name: PythonScriptName): string {
    const isDev = !app.isPackaged
    const base = isDev
      ? join(app.getAppPath(), 'python')
      : join(process.resourcesPath, 'python')
    return join(base, `${name}.py`)
  }

  start(name: PythonScriptName): void {
    if (this.processes.has(name)) return

    const pythonBin = this.getPythonPath()
    const script = this.getScriptPath(name)

    const child = spawn(pythonBin, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...this.extraEnv }
    })

    // Prevent unhandled ENOENT from crashing the main process if the
    // Python binary or script path doesn't exist.
    child.on('error', (err) => {
      console.error(`[PythonBridge:${name}] failed to start:`, err.message)
      this.processes.delete(name)
      this.emit('process:failed', { name, error: err })
    })

    this.setupProcess(name, child)
    this.processes.set(name, child)
    this.retries.set(name, 0)
  }

  private setupProcess(name: PythonScriptName, child: ChildProcess): void {
    const rl = createInterface({ input: child.stdout! })

    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const parsed = JSON.parse(line) as JsonResponse & { startup?: string }
        if ('startup' in parsed) {
          if (parsed.startup === 'ready') {
            this.processReady.set(name, true)
            const queue = this.startupQueue.get(name) ?? []
            this.startupQueue.delete(name)
            for (const { doWrite } of queue) doWrite()
          }
          return // startup messages are not request responses — don't pass to handleResponse
        }
        if ('streaming' in parsed) {
          this.handleStreamingResponse(parsed as unknown as StreamingResponse)
        } else {
          this.handleResponse(parsed)
        }
      } catch {
        // Non-JSON output from Python (e.g., debug prints) — ignore
      }
    })

    child.stderr!.on('data', (data: Buffer) => {
      console.error(`[PythonBridge:${name}] stderr:`, data.toString().trim())
    })

    child.on('exit', (code, signal) => {
      this.processes.delete(name)
      this.processReady.delete(name)
      this.emit('process:exit', { name, code, signal })

      // Reject any sends that were still buffered waiting for startup
      const queued = this.startupQueue.get(name) ?? []
      this.startupQueue.delete(name)
      for (const { reject } of queued) {
        reject(new Error(`Python process '${name}' exited before becoming ready`))
      }

      // Reject only the pending requests that belong to this process
      for (const [id, pending] of this.pending) {
        if (pending.processName !== name) continue
        pending.reject(new Error(`Python process '${name}' exited unexpectedly (code ${code})`))
        clearTimeout(pending.timeout)
        this.pending.delete(id)
      }

      // Reject any in-flight streaming requests for this process
      for (const [id, pending] of this.pendingStreaming) {
        if (pending.processName !== name) continue
        pending.reject(new Error(`Python process '${name}' exited unexpectedly (code ${code})`))
        clearTimeout(pending.timeout)
        this.pendingStreaming.delete(id)
      }

      // Auto-restart if not intentionally killed
      if (signal !== 'SIGTERM' && !this.restarting.has(name)) {
        const retries = this.retries.get(name) ?? 0
        if (retries < MAX_RETRIES) {
          this.retries.set(name, retries + 1)
          const delay = Math.min(1000 * Math.pow(2, retries), 10_000)
          setTimeout(() => {
            if (!this.processes.has(name)) {
              this.start(name)
              this.emit('process:restarted', { name, attempt: retries + 1 })
            }
          }, delay)
        } else {
          this.emit('process:failed', { name })
        }
      }
      this.restarting.delete(name)
    })
  }

  private handleResponse(response: JsonResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(response.id)

    if (response.success) {
      pending.resolve(response.data)
    } else {
      pending.reject(new Error(response.error ?? 'Unknown Python error'))
    }
  }

  private handleStreamingResponse(response: StreamingResponse): void {
    const pending = this.pendingStreaming.get(response.id)
    if (!pending) return

    if (response.error) {
      clearTimeout(pending.timeout)
      this.pendingStreaming.delete(response.id)
      pending.reject(new Error(response.error))
      return
    }

    if (!response.done) {
      pending.onChunk(response.data)
    } else {
      clearTimeout(pending.timeout)
      this.pendingStreaming.delete(response.id)
      pending.resolve()
    }
  }

  send<TResponse>(
    name: PythonScriptName,
    type: string,
    payload: unknown
  ): Promise<TResponse> {
    const proc = this.processes.get(name)
    if (!proc || !proc.stdin?.writable) {
      return Promise.reject(new Error(`Python process '${name}' is not running`))
    }

    const id = randomUUID()
    const message = JSON.stringify({ id, type, payload }) + '\n'

    return new Promise<TResponse>((resolve, reject) => {
      // Start timeout and write immediately once the process is ready.
      // This ensures the 120 s clock only counts time Python is actually
      // processing — not time spent loading model weights at startup.
      const doWrite = () => {
        const currentProc = this.processes.get(name)
        if (!currentProc?.stdin?.writable) {
          reject(new Error(`Python process '${name}' is not running`))
          return
        }

        const timeoutMs = PROCESS_TIMEOUT_MS[name] ?? REQUEST_TIMEOUT_MS
        const timeout = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Python request '${type}' timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        this.pending.set(id, {
          processName: name,
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout
        })

        currentProc.stdin!.write(message, (err) => {
          if (err) {
            clearTimeout(timeout)
            this.pending.delete(id)
            reject(err)
          }
        })
      }

      if (this.processReady.get(name)) {
        doWrite()
      } else {
        const queue = this.startupQueue.get(name) ?? []
        queue.push({ doWrite, reject })
        this.startupQueue.set(name, queue)
      }
    })
  }

  /**
   * Send a streaming request to a Python process.
   * `onChunk` is called for each intermediate JSON chunk as they arrive.
   * Resolves when Python sends the terminal `{"done": true}` frame.
   */
  sendStreaming(
    name: PythonScriptName,
    type: string,
    payload: unknown,
    onChunk: (data: unknown) => void
  ): Promise<void> {
    const proc = this.processes.get(name)
    if (!proc || !proc.stdin?.writable) {
      return Promise.reject(new Error(`Python process '${name}' is not running`))
    }

    const id = randomUUID()
    const message = JSON.stringify({ id, type, payload }) + '\n'

    return new Promise<void>((resolve, reject) => {
      const doWrite = () => {
        const currentProc = this.processes.get(name)
        if (!currentProc?.stdin?.writable) {
          reject(new Error(`Python process '${name}' is not running`))
          return
        }

        const timeoutMs = PROCESS_TIMEOUT_MS[name] ?? REQUEST_TIMEOUT_MS
        const timeout = setTimeout(() => {
          this.pendingStreaming.delete(id)
          reject(new Error(`Python streaming request '${type}' timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        this.pendingStreaming.set(id, {
          processName: name,
          onChunk,
          resolve,
          reject,
          timeout
        })

        currentProc.stdin!.write(message, (err) => {
          if (err) {
            clearTimeout(timeout)
            this.pendingStreaming.delete(id)
            reject(err)
          }
        })
      }

      if (this.processReady.get(name)) {
        doWrite()
      } else {
        const queue = this.startupQueue.get(name) ?? []
        queue.push({ doWrite, reject })
        this.startupQueue.set(name, queue)
      }
    })
  }

  kill(name: PythonScriptName): void {
    const child = this.processes.get(name)
    if (child) {
      this.restarting.add(name)
      child.kill('SIGTERM')
      this.processes.delete(name)
    }
  }

  killAll(): void {
    for (const name of this.processes.keys()) {
      this.kill(name as PythonScriptName)
    }
  }

  isRunning(name: PythonScriptName): boolean {
    return this.processes.has(name)
  }
}
