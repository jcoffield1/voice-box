// Vitest setup file — mock Electron and native modules that aren't available in Node test env
import { vi } from 'vitest'

// Mock 'electron' so that main-process code can be imported in tests
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userData'),
    isPackaged: false
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  },
  BrowserWindow: vi.fn(),
  // Required by recording.ipc.ts on macOS to request microphone permission
  systemPreferences: {
    askForMediaAccess: vi.fn(async () => true)
  },
  shell: {
    openExternal: vi.fn()
  }
}))

// Mock sqlite-vec so that Database.ts never calls db.loadExtension() with the native dylib.
// db.loadExtension() hangs in the Node/vitest environment (no Electron sandbox / SIP-restricted dlopen).
vi.mock('sqlite-vec', () => ({
  getLoadablePath: vi.fn(() => '/dev/null'),
  load: vi.fn()
}))
