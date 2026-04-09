/**
 * E2E test utilities — shared helpers for launching the Electron app.
 * We use _electron from @playwright/test which drives the app via CDP.
 *
 * Requires `npm run build` (electron-vite) to have been run first.
 * Build outputs to: out/main/index.js  (matches package.json "main" field)
 */
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'path'

// electron-vite builds main process to out/main/index.js
const APP_MAIN = path.resolve(__dirname, '../../../out/main/index.js')

export async function launchApp(): Promise<{
  app: ElectronApplication
  page: Page
}> {
  const app = await electron.launch({
    args: [APP_MAIN],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close()
}
