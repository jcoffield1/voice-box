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

  // Pre-set onboarding.complete so the full-screen OnboardingModal doesn't
  // intercept clicks and block navigation in every test.
  await page.evaluate(() =>
    (window as any).api?.settings?.set({ key: 'onboarding.complete', value: 'true' })
  )
  // Reload so React re-reads the setting on mount and skips the modal.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  // Confirm the sidebar nav is visible before handing control to tests.
  await page.waitForSelector('aside nav', { timeout: 10000 })

  return { app, page }
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close()
}

/**
 * Reliable hash-based navigation wait for Playwright + HashRouter.
 * page.waitForURL() does not reliably detect client-side hash changes;
 * this polls window.location.hash directly.
 *
 * Patterns mirror the waitForURL glob style:
 *   '**\/#\/recordings'     → hash === '#/recordings'
 *   '**\/#\/recordings\/**' → hash starts with '#/recordings/'
 */
export async function waitForHash(page: Page, urlPattern: string): Promise<void> {
  const hash = urlPattern.replace(/^\*\*\//, '')
  const isWildcard = hash.endsWith('/**')
  if (isWildcard) {
    const prefix = hash.slice(0, -3) // strip trailing '/**'
    await page.waitForFunction((p: string) => window.location.hash.startsWith(p + '/'), prefix, { timeout: 10000 })
  } else {
    await page.waitForFunction((p: string) => window.location.hash === p, hash, { timeout: 10000 })
  }
}
