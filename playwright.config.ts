import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: process.env.CI ? 2 : 0,
  use: {
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'electron',
      use: {
        // Electron e2e tests launch the built app
      }
    }
  ],
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']]
})
