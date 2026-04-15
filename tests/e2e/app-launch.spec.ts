import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  ;({ app, page } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

test('app launches and shows the VoiceBox title', async () => {
  await expect(page.locator('text=VoiceBox')).toBeVisible()
})

test('navigation sidebar is visible', async () => {
  // Scope to the sidebar <nav> to avoid strict-mode violations when heading
  // text (e.g. "Recordings") also appears on the active page.
  const nav = page.locator('aside nav')
  await expect(nav.locator('text=Recordings')).toBeVisible()
  await expect(nav.locator('text=Search')).toBeVisible()
  await expect(nav.locator('text=Settings')).toBeVisible()
})

test('landing page redirects to /recordings', async () => {
  // HashRouter redirects / → /recordings client-side.
  // waitForFunction polls window.location until the hash is set — more
  // reliable than waitForURL for hash-only navigation changes.
  await page.waitForFunction(() => window.location.hash.startsWith('#/recordings'), { timeout: 5000 })
  expect(page.url()).toContain('#/recordings')
})

test('window title is VoiceBox', async () => {
  const title = await page.title()
  expect(title).toBe('VoiceBox')
})
