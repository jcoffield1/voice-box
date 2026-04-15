import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
    exclude: ['src/renderer/**/*.{test,spec}.tsx', 'tests/e2e/**'],
    // Use forked child-processes instead of worker-threads.
    // better-sqlite3 (native .node addon) works reliably in forked processes;
    // in worker-thread mode it can deadlock on first use due to mutex
    // contention between Vitest's loader and the native module initialiser.
    pool: 'forks',
    // Prevent Vite's optimizer from trying to bundle native Node addons.
    // better-sqlite3 and sqlite-vec use platform-native .node files that
    // hang under macOS SIP/Gatekeeper when dlopen()'d outside of Electron.
    deps: {
      optimizer: {
        ssr: {
          exclude: ['better-sqlite3', 'sqlite-vec', 'sqlite-vec-darwin-arm64']
        }
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/**/*.d.ts']
    }
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
