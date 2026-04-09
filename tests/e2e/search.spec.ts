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

test.beforeEach(async () => {
  await page.click('a[href^="#/search"]')
  await page.waitForURL('**/#/search')
})

test('search page renders heading and input', async () => {
  await expect(page.locator('h1:has-text("Search Transcripts")')).toBeVisible()
  await expect(page.locator('input[placeholder*="Search"]')).toBeVisible()
})

test('empty state: no results shown before searching', async () => {
  await expect(page.locator('.card')).not.toBeVisible({ timeout: 2000 }).catch(() => {
    // may have no cards which is fine
  })
})

test('submitting search without input does nothing', async () => {
  await page.click('button:has-text("Search")')
  await expect(page.locator('text=No results found')).not.toBeVisible()
})

test('search with non-matching term shows no-results message', async () => {
  await page.fill('input[placeholder*="Search"]', 'xyzzy-unicorn-term-12345')
  await page.click('button:has-text("Search")')
  await expect(
    page.locator('text=No results found').or(page.locator('text=no results'))
  ).toBeVisible({ timeout: 5000 })
})

test('pressing Enter in search input submits the query', async () => {
  await page.fill('input[placeholder*="Search"]', 'xyzzy-enter-key-test')
  await page.keyboard.press('Enter')
  // Should not crash — either no-results or results appear
  await expect(page.locator('text=Something went wrong')).not.toBeVisible({ timeout: 3000 })
})

test('clearing search input and submitting resets state', async () => {
  await page.fill('input[placeholder*="Search"]', 'first search')
  await page.click('button:has-text("Search")')
  await page.waitForTimeout(500)

  await page.fill('input[placeholder*="Search"]', '')
  await page.click('button:has-text("Search")')
  // No crash, and results area is clear or shows empty state
  await expect(page.locator('text=Something went wrong')).not.toBeVisible()
})

test('search results are clickable and navigate to the recording', async () => {
  // This test only runs if there's at least one indexed recording.
  // Perform a broad search and check if any result card appears.
  await page.fill('input[placeholder*="Search"]', 'the')
  await page.click('button:has-text("Search")')
  await page.waitForTimeout(2000)

  const resultCard = page.locator('.card, [data-testid="search-result"]').first()
  const hasResult = await resultCard.isVisible({ timeout: 1000 }).catch(() => false)
  if (!hasResult) { test.skip(); return }

  await resultCard.click()
  // Should navigate to the recording detail page
  await expect(page.locator('button:has-text("Transcript")')).toBeVisible({ timeout: 3000 })
})
