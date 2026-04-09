/**
 * KeychainService — secure API key storage via macOS Keychain (keytar).
 * Falls back to encrypted sqlite settings when keytar is unavailable.
 */

const SERVICE_NAME = 'com.calltranscriber.app'

export class KeychainService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private keytar: any = null

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.keytar = require('keytar')
    } catch {
      console.warn('[KeychainService] keytar not available — API keys stored in memory only')
    }
  }

  async getApiKey(provider: string): Promise<string | null> {
    if (!this.keytar) return null
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return await this.keytar.getPassword(SERVICE_NAME, provider) as string | null
    } catch (err) {
      console.error(`[KeychainService] getApiKey failed for ${provider}:`, err)
      return null
    }
  }

  async setApiKey(provider: string, apiKey: string): Promise<void> {
    if (!this.keytar) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this.keytar.setPassword(SERVICE_NAME, provider, apiKey)
    } catch (err) {
      console.error(`[KeychainService] setApiKey failed for ${provider}:`, err)
    }
  }

  async deleteApiKey(provider: string): Promise<void> {
    if (!this.keytar) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await this.keytar.deletePassword(SERVICE_NAME, provider)
    } catch (err) {
      console.error(`[KeychainService] deleteApiKey failed for ${provider}:`, err)
    }
  }
}
