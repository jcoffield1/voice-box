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
  await expect(page.locator('text=Recordings')).toBeVisible()
  await expect(page.locator('text=Search')).toBeVisible()
  await expect(page.locator('text=Settings')).toBeVisible()
})

test('landing page redirects to /recordings', async () => {
  const url = page.url()
  expect(url).toContain('recordings')
})

test('window title is VoiceBox', async () => {
  const title = await page.title()
  expect(title).toBe('VoiceBox')
})
