import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import { createInterface } from 'readline'

export type PythonScriptName = 'transcribe' | 'diarize' | 'embed_voice'

interface PendingRequest {
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

const MAX_RETRIES = 3
const REQUEST_TIMEOUT_MS = 120_000

export class PythonBridge extends EventEmitter {
  private processes: Map<PythonScriptName, ChildProcess> = new Map()
  private pending: Map<string, PendingRequest> = new Map()
  private retries: Map<PythonScriptName, number> = new Map()
  private restarting: Set<PythonScriptName> = new Set()

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
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
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
        const response = JSON.parse(line) as JsonResponse
        this.handleResponse(response)
      } catch {
        // Non-JSON output from Python (e.g., debug prints) — ignore
      }
    })

    child.stderr!.on('data', (data: Buffer) => {
      console.error(`[PythonBridge:${name}] stderr:`, data.toString().trim())
    })

    child.on('exit', (code, signal) => {
      this.processes.delete(name)
      this.emit('process:exit', { name, code, signal })

      // Reject all pending requests for this process
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`Python process '${name}' exited unexpectedly (code ${code})`))
        clearTimeout(pending.timeout)
        this.pending.delete(id)
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

  send<TResponse>(
    name: PythonScriptName,
    type: string,
    payload: unknown
  ): Promise<TResponse> {
    const process = this.processes.get(name)
    if (!process || !process.stdin?.writable) {
      return Promise.reject(new Error(`Python process '${name}' is not running`))
    }

    const id = randomUUID()
    const message = JSON.stringify({ id, type, payload }) + '\n'

    return new Promise<TResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Python request '${type}' timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout
      })

      process.stdin!.write(message, (err) => {
        if (err) {
          clearTimeout(timeout)
          this.pending.delete(id)
          reject(err)
        }
      })
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
