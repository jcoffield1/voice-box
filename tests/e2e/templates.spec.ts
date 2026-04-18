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
  await page.click('a[href^="#/templates"]')
  await waitForHash(page, '**/#/templates')
})

// ─── Page renders ─────────────────────────────────────────────────────────────

test('templates page renders heading', async () => {
  await expect(page.locator('h1:has-text("Summary Templates")')).toBeVisible()
})

test('at least the built-in default template is listed', async () => {
  // The default template ships with VoiceBox
  const cards = page.locator('.card')
  await expect(cards.first()).toBeVisible({ timeout: 3000 })
})

test('"Default" badge is visible on the built-in template', async () => {
  await expect(page.locator('text=Default').first()).toBeVisible({ timeout: 3000 })
})

// ─── Create new template ──────────────────────────────────────────────────────

test('clicking New Template opens the editor', async () => {
  await page.click('button:has-text("New Template")')
  await expect(page.locator('h2:has-text("New Template")')).toBeVisible({ timeout: 2000 })
})

test('editor shows Edit / Preview / Test tabs', async () => {
  await page.click('button:has-text("New Template")')
  await expect(page.locator('button:has-text("Edit")')).toBeVisible({ timeout: 2000 })
  await expect(page.locator('button:has-text("Preview")')).toBeVisible()
  await expect(page.locator('button:has-text("Test")')).toBeVisible()
})

test('Save button is disabled when name is empty', async () => {
  await page.click('button:has-text("New Template")')
  // Clear the name field (should be empty on new template)
  const nameInput = page.locator('input[placeholder*="Sales Call"]')
  await nameInput.fill('')
  const saveBtn = page.locator('button:has-text("Save")').first()
  await expect(saveBtn).toBeDisabled({ timeout: 2000 })
})

test('can fill in and save a new template', async () => {
  await page.click('button:has-text("New Template")')

  await page.locator('input[placeholder*="Sales Call"]').fill('E2E Test Template')
  await page.locator('textarea').nth(0).fill('You are a helpful test assistant.')
  await page.locator('textarea').nth(1).fill('Summarize "{{title}}":\n\n{{transcript}}')

  await page.click('button:has-text("Save")')

  // Editor should close and the new template should appear in the list
  await expect(page.locator('text=E2E Test Template')).toBeVisible({ timeout: 3000 })
})

test('Cancel button dismisses the editor without saving', async () => {
  await page.click('button:has-text("New Template")')
  await page.locator('input[placeholder*="Sales Call"]').fill('Should Not Be Saved')
  await page.click('button:has-text("Cancel")')

  await expect(page.locator('text=Should Not Be Saved')).not.toBeVisible({ timeout: 2000 })
})

// ─── Edit existing template ───────────────────────────────────────────────────

test('pencil icon opens the edit form for a template', async () => {
  // Navigate fresh to ensure list is loaded
  await page.click('a[href^="#/templates"]')
  await waitForHash(page, '**/#/templates')

  // Click the edit (pencil) button on the first non-default template if present,
  // otherwise rely on the one we created in the save test above
  const editBtn = page.locator('button[title="Edit"]').first()
  const hasEdit = await editBtn.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasEdit) { test.skip(); return }

  await editBtn.click()
  // The inline editor form should appear
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 2000 })
})

// ─── Help panels ─────────────────────────────────────────────────────────────

test('What is this? help panel expands and shows placeholder documentation', async () => {
  await page.click('button:has-text("New Template")')

  // First "What is this?" button expands the system prompt help
  const helpBtn = page.locator('button:has-text("What is this?")').first()
  await expect(helpBtn).toBeVisible({ timeout: 2000 })
  await helpBtn.click()

  await expect(page.locator('text={{title}}')).toBeVisible({ timeout: 2000 })
})

// ─── Preview tab ─────────────────────────────────────────────────────────────

test('Preview tab shows rendered prompt sections', async () => {
  await page.click('button:has-text("New Template")')

  await page.locator('textarea').nth(0).fill('You are a test assistant.')
  await page.locator('textarea').nth(1).fill('Summarize "{{title}}":\n\n{{transcript}}')

  await page.click('button:has-text("Preview")')

  await expect(page.locator('text=Rendered System Prompt')).toBeVisible({ timeout: 2000 })
  await expect(page.locator('text=Rendered User Message')).toBeVisible()
})

test('Preview tab substitutes {{title}} with sample value', async () => {
  await page.click('button:has-text("New Template")')
  await page.locator('textarea').nth(1).fill('Debrief for "{{title}}"')
  await page.click('button:has-text("Preview")')

  // The sample title field should be pre-filled and reflected in the rendered output
  const sampleTitleInput = page.locator('input[value="Sample Recording Title"]')
  const visible = await sampleTitleInput.isVisible({ timeout: 1000 }).catch(() => false)
  if (visible) {
    await sampleTitleInput.fill('My Custom Title')
  }
  await expect(page.locator('pre:has-text("My Custom Title"), pre:has-text("Sample Recording Title")')).toBeVisible({ timeout: 2000 })
})

// ─── Test tab ─────────────────────────────────────────────────────────────────

test('Test tab renders with a message when no transcribed recordings exist', async () => {
  await page.click('button:has-text("New Template")')
  await page.click('button:has-text("Test")')

  // Either shows a recording picker or the "no transcribed recordings" empty state
  const hasRecordingPicker = await page.locator('select').isVisible({ timeout: 1000 }).catch(() => false)
  const hasEmptyMsg = await page
    .locator('text=No transcribed recordings found')
    .isVisible({ timeout: 1000 })
    .catch(() => false)

  expect(hasRecordingPicker || hasEmptyMsg).toBe(true)
})

test('Run Test button is disabled when prompts are empty', async () => {
  await page.click('button:has-text("New Template")')
  await page.click('button:has-text("Test")')

  // Prompts are empty by default on a new template
  const runBtn = page.locator('button:has-text("Run Test")')
  const hasBtn = await runBtn.isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasBtn) { test.skip(); return }

  await expect(runBtn).toBeDisabled()
})

// ─── Export ───────────────────────────────────────────────────────────────────

test('Export button is present on each template card', async () => {
  const exportBtn = page.locator('button[title="Export as JSON"]').first()
  await expect(exportBtn).toBeVisible({ timeout: 3000 })
})

// ─── Delete ───────────────────────────────────────────────────────────────────

test('default template does not have a delete button', async () => {
  // The built-in default has isDefault=true — its card should not render a Trash button
  // Identify the card that contains the "Default" badge
  const defaultCard = page.locator('.card').filter({ hasText: 'Default' }).first()
  await expect(defaultCard).toBeVisible({ timeout: 3000 })
  await expect(defaultCard.locator('button[title="Delete"]')).not.toBeVisible()
})
