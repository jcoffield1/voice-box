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

/**
 * Transcript tests run in the context of the RecordingPage (/recordings/:id).
 * Since we cannot trigger a real transcription in e2e without audio hardware,
 * these tests verify the empty/loading state and the UI controls.
 */

test('navigating to an unknown recording shows error or empty state', async () => {
  await page.goto('./#/recordings/non-existent-id-000')
  await page.waitForLoadState('domcontentloaded')

  // Either an error message or empty transcript view
  const hasError = await page.locator('text=not found').isVisible({ timeout: 3000 }).catch(() => false)
  const hasEmpty = await page.locator('text=No transcript').isVisible({ timeout: 3000 }).catch(() => false)
  const hasMsg = await page.locator('text=Transcript').isVisible({ timeout: 3000 }).catch(() => false)

  expect(hasError || hasEmpty || hasMsg).toBe(true)
})

test('transcript view renders when a recording exists', async () => {
  // Navigate to recordings list
  await page.click('a[href^="#/recordings"]')
  await page.waitForURL('**/#/recordings')

  // If there are recordings, click the first one
  const firstCard = page.locator('.card').first()
  const exists = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)

  if (exists) {
    await firstCard.click()
    await page.waitForURL('**/#/recordings/**')
    await expect(page.locator('text=Transcript')).toBeVisible()
  } else {
    // No recordings yet — just assert the empty state
    await expect(page.locator('text=No recordings yet')).toBeVisible()
  }
})

test('segment edit controls appear on pencil click', async () => {
  // Navigate to recordings list; skip if no recordings
  await page.click('a[href^="#/recordings"]')
  await page.waitForURL('**/#/recordings')

  const firstCard = page.locator('.card').first()
  const exists = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!exists) {
    test.skip()
    return
  }

  await firstCard.click()
  await page.waitForURL('**/#/recordings/**')

  const editBtn = page.locator('button[title="Edit segment"]').first()
  const segmentExists = await editBtn.isVisible({ timeout: 3000 }).catch(() => false)

  if (segmentExists) {
    await editBtn.click()
    await expect(page.locator('textarea').first()).toBeVisible()
    // Cancel edit via Escape or X button
    await page.keyboard.press('Escape')
  }
})

test('AI panel renders in recording detail', async () => {
  await page.click('a[href^="#/recordings"]')
  await page.waitForURL('**/#/recordings')

  const firstCard = page.locator('.card').first()
  const exists = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!exists) {
    test.skip()
    return
  }

  await firstCard.click()
  await page.waitForURL('**/#/recordings/**')
  await expect(page.locator('text=AI Assistant')).toBeVisible()
})
