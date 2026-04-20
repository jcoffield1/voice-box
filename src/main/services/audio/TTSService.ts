/**
 * TTSService — Text-to-speech for macOS using the built-in `say` command.
 * Streams sentence-by-sentence so first words start playing while the
 * rest of the response is still arriving.
 */
import { spawn, ChildProcess } from 'child_process'

export class TTSService {
  private currentProcess: ChildProcess | null = null
  private speaking = false

  isSpeaking(): boolean {
    return this.speaking
  }

  /**
   * Speak the given text. Kills any in-progress speech first.
   * @param text     Text to speak
   * @param rate     Words per minute (default 200; macOS default is ~175)
   * @param voice    macOS voice name, e.g. "Samantha" (optional)
   */
  speak(text: string, rate = 200, voice?: string): Promise<void> {
    this.stop()

    return new Promise((resolve, reject) => {
      const args = ['-r', String(rate)]
      if (voice) args.push('-v', voice)
      args.push(text)

      this.currentProcess = spawn('say', args)
      this.speaking = true

      this.currentProcess.on('close', (code) => {
        this.speaking = false
        this.currentProcess = null
        if (code === 0 || code === null) {
          resolve()
        } else {
          reject(new Error(`say exited with code ${code}`))
        }
      })

      this.currentProcess.on('error', (err) => {
        this.speaking = false
        this.currentProcess = null
        reject(err)
      })
    })
  }

  /**
   * Play an audio file (WAV/MP3/etc.) using afplay.
   * Kills any in-progress speech first.
   */
  playFile(filePath: string): Promise<void> {
    this.stop()

    return new Promise((resolve, reject) => {
      this.currentProcess = spawn('afplay', [filePath])
      this.speaking = true

      this.currentProcess.on('close', (code) => {
        this.speaking = false
        this.currentProcess = null
        if (code === 0 || code === null) {
          resolve()
        } else {
          reject(new Error(`afplay exited with code ${code}`))
        }
      })

      this.currentProcess.on('error', (err) => {
        this.speaking = false
        this.currentProcess = null
        reject(err)
      })
    })
  }

  /**
   * Stop any in-progress speech immediately.
   */
  stop(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM')
      this.currentProcess = null
      this.speaking = false
    }
  }
}
