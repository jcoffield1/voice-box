// Vitest setup file — mock Electron and native modules that aren't available in Node test env
import { vi } from 'vitest'

// Mock 'electron' so that main-process code can be imported in tests
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userData')
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  },
  BrowserWindow: vi.fn()
}))

// Note: sqlite-vec is NOT mocked — it ships prebuilt binaries and loads fine in Node test env
