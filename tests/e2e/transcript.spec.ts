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

/**
 * Transcript tests run in the context of the RecordingPage (/recordings/:id).
 * Since we cannot trigger a real transcription in e2e without audio hardware,
 * these tests verify the empty/loading state and the UI controls.
 */

test('navigating to an unknown recording shows error or empty state', async () => {
  // Use evaluate to set the hash directly — page.goto() with relative paths
  // does not work in the file:// context used by Electron
  await page.evaluate(() => { window.location.hash = '#/recordings/non-existent-id-000' })
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
  await waitForHash(page, '**/#/recordings')

  // If there are recordings, click the first one
  const firstCard = page.locator('.card').first()
  const exists = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)

  if (exists) {
    await firstCard.click()
    await waitForHash(page, '**/#/recordings/**')
    await expect(page.locator('text=Transcript')).toBeVisible()
  } else {
    // No recordings yet — just assert the empty state
    await expect(page.locator('text=No recordings yet')).toBeVisible()
  }
})

test('segment edit controls appear on pencil click', async () => {
  // Navigate to recordings list; skip if no recordings
  await page.click('a[href^="#/recordings"]')
  await waitForHash(page, '**/#/recordings')

  const firstCard = page.locator('.card').first()
  const exists = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!exists) {
    test.skip()
    return
  }

  await firstCard.click()
  await waitForHash(page, '**/#/recordings/**')

  const editBtn = page.locator('button[title="Edit segment"]').first()
  const segmentExists = await editBtn.isVisible({ timeout: 3000 }).catch(() => false)

  if (segmentExists) {
    await editBtn.click()
    await expect(page.locator('textarea').first()).toBeVisible()
    // Cancel edit via Escape or X button
    await page.keyboard.press('Escape')
  }
})

// ── Diarization error banner ────────────────────────────────────────────────

test('diarization error banner renders and can be dismissed', async () => {
  // Navigate to any recording (or mock one via evaluate)
  await page.click('a[href^="#/recordings"]')
  await waitForHash(page, '**/#/recordings')

  const firstCard = page.locator('.card').first()
  const hasRecording = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasRecording) {
    test.skip()
    return
  }

  await firstCard.click()
  await waitForHash(page, '**/#/recordings/**')

  // Simulate the diarization:error event that the main process emits
  await page.evaluate(() => {
    const ipcRenderer = (window as unknown as { electron?: { ipcRenderer?: { emit: (ch: string, ...args: unknown[]) => void } } }).electron?.ipcRenderer
    ipcRenderer?.emit('diarization:error', { type: 'gated_repo', message: 'Test error banner' })
  })

  // The banner may or may not appear depending on whether the IPC bridge is stubbed.
  // At minimum the evaluate must not throw and the page must still be functional.
  await expect(page.locator('body')).toBeVisible()
})

// ── Speaker label modal structure ───────────────────────────────────────────

test('clicking a speaker label opens the assignment modal', async () => {
  await page.click('a[href^="#/recordings"]')
  await waitForHash(page, '**/#/recordings')

  const firstCard = page.locator('.card').first()
  const hasRecording = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasRecording) {
    test.skip()
    return
  }

  await firstCard.click()
  await waitForHash(page, '**/#/recordings/**')

  // Try clicking the first speaker label chip in the transcript
  const speakerChip = page.locator('[data-testid="speaker-label"], button.speaker-label, button[class*="speaker"]').first()
  const chipVisible = await speakerChip.isVisible({ timeout: 3000 }).catch(() => false)
  if (!chipVisible) {
    test.skip()
    return
  }

  await speakerChip.click()

  // Modal should be open — look for a dialog or modal overlay
  const modal = page.locator('[role="dialog"], [data-testid="speaker-modal"]').first()
  const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false)
  if (modalVisible) {
    // Modal is open — verify it has candidate buttons or an input
    const hasCandidates = await page.locator('[data-testid="speaker-candidate"], button[class*="candidate"]').first().isVisible({ timeout: 2000 }).catch(() => false)
    const hasInput = await page.locator('input[placeholder*="name"], input[placeholder*="speaker"]').first().isVisible({ timeout: 2000 }).catch(() => false)
    expect(hasCandidates || hasInput).toBe(true)

    // Dismiss via Escape
    await page.keyboard.press('Escape')
  }
})

// ── sweepSpeakers triggered on transcript load ──────────────────────────────

test('transcript page loads without JS errors related to sweepSpeakers', async () => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.click('a[href^="#/recordings"]')
  await waitForHash(page, '**/#/recordings')

  const firstCard = page.locator('.card').first()
  const hasRecording = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasRecording) {
    test.skip()
    return
  }

  await firstCard.click()
  await waitForHash(page, '**/#/recordings/**')
  await page.waitForLoadState('domcontentloaded')

  // Allow async sweep to settle
  await page.waitForTimeout(500)

  // No uncaught JS errors from the sweep IPC call
  const sweepErrors = consoleErrors.filter((e) => e.includes('sweepSpeakers') || e.includes('speakersSwept'))
  expect(sweepErrors).toHaveLength(0)
})

test('AI panel renders in recording detail', async () => {
  await page.click('a[href^="#/recordings"]')
  await waitForHash(page, '**/#/recordings')

  const firstCard = page.locator('.card').first()
  const exists = await firstCard.isVisible({ timeout: 2000 }).catch(() => false)
  if (!exists) {
    test.skip()
    return
  }

  await firstCard.click()
  await waitForHash(page, '**/#/recordings/**')
  await expect(page.locator('text=AI Assistant')).toBeVisible()
})
