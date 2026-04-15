import { test, expect } from '@playwright/test'
import { launchApp, closeApp, waitForHash } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  ;({ app, page } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

test.beforeEach(async () => {
  // Navigate to the Speakers page via sidebar
  const speakersLink = page.locator('a[href^="#/speakers"]')
  await speakersLink.click()
  await waitForHash(page, '**/#/speakers')
})

test('speakers page renders the Speakers heading', async () => {
  await expect(page.locator('h1, h2').filter({ hasText: /speakers/i }).first()).toBeVisible()
})

test('shows empty state or speaker list', async () => {
  // Either shows "No speakers yet" or the speakers list
  const noSpeakers = page.locator('text=No speakers yet')
  const hasCard = page.locator('.card').first()

  const isEmpty = await noSpeakers.isVisible({ timeout: 3000 }).catch(() => false)
  const hasCards = await hasCard.isVisible({ timeout: 3000 }).catch(() => false)

  expect(isEmpty || hasCards).toBe(true)
})

test('back-navigation returns to main page', async () => {
  await page.click('a[href^="#/recordings"]')
  await waitForHash(page, '**/#/recordings')
  const url = page.url()
  expect(url).toContain('recordings')
})

test('speakers page is accessible from sidebar', async () => {
  // Already on speakers page in beforeEach — just confirm URL
  await waitForHash(page, '**/#/speakers')
  expect(page.url()).toContain('speakers')
})

test('speaker rename UI appears when edit button is clicked', async () => {
  // Only run if a speaker card exists
  const hasSpeakers = await page.locator('.card').first().isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasSpeakers) {
    test.skip()
    return
  }

  // Click the edit (pencil) button on the first speaker card
  const editBtn = page.locator('button[title="Rename"]').first()
  const hasEditBtn = await editBtn.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasEditBtn) {
    test.skip()
    return
  }

  await editBtn.click()
  // Should show an input field for the new name
  await expect(page.locator('input').first()).toBeVisible()
})

test('merge section appears when merge button is clicked', async () => {
  const hasSpeakers = await page.locator('.card').first().isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasSpeakers) {
    test.skip()
    return
  }

  const mergeBtn = page.locator('button[title="Merge"]').first()
  const hasMergeBtn = await mergeBtn.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasMergeBtn) {
    test.skip()
    return
  }

  await mergeBtn.click()
  // Should show a select/dropdown for target speaker
  await expect(page.locator('select').last()).toBeVisible()
})
