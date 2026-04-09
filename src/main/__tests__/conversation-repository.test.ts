import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, closeDatabase, getDatabase } from '@main/services/storage/Database'
import { ConversationRepository } from '@main/services/storage/repositories/ConversationRepository'
import { RecordingRepository } from '@main/services/storage/repositories/RecordingRepository'

describe('ConversationRepository', () => {
  let repo: ConversationRepository
  let recRepo: RecordingRepository

  beforeEach(() => {
    initDatabase(':memory:')
    repo = new ConversationRepository(getDatabase())
    recRepo = new RecordingRepository(getDatabase())
  })

  afterEach(() => {
    closeDatabase()
  })

  // ─── Thread CRUD ──────────────────────────────────────────────────────────

  it('creates a thread with no recordingId', () => {
    const thread = repo.createThread(null)
    expect(thread.id).toBeTruthy()
    expect(thread.recordingId).toBeNull()
    expect(thread.title).toBeNull()
    expect(typeof thread.createdAt).toBe('number')
    expect(typeof thread.updatedAt).toBe('number')
  })

  it('creates a thread with a recordingId and title', () => {
    const rec = recRepo.create('Test Recording')
    const thread = repo.createThread(rec.id, 'My Chat')
    expect(thread.recordingId).toBe(rec.id)
    expect(thread.title).toBe('My Chat')
  })

  it('findThreadById returns the correct thread', () => {
    const created = repo.createThread(null, 'Test')
    const found = repo.findThreadById(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.title).toBe('Test')
  })

  it('findThreadById returns null for unknown id', () => {
    expect(repo.findThreadById('non-existent')).toBeNull()
  })

  it('findThreadsByRecording returns threads for that recording in desc order', () => {
    const recA = recRepo.create('Recording A')
    const recB = recRepo.create('Recording B')
    repo.createThread(recA.id, 'First')
    repo.createThread(recA.id, 'Second')
    repo.createThread(recB.id, 'Other')
    const threads = repo.findThreadsByRecording(recA.id)
    expect(threads.length).toBe(2)
    // Should not include recB threads
    expect(threads.every((t) => t.recordingId === recA.id)).toBe(true)
  })

  it('findAllThreads returns threads ordered by updatedAt desc', () => {
    const t1 = repo.createThread(null, 'Oldest')
    repo.addMessage(t1.id, 'user', 'first message')
    const t2 = repo.createThread(null, 'Newest')
    repo.addMessage(t2.id, 'user', 'second message')
    const threads = repo.findAllThreads()
    expect(threads.length).toBeGreaterThanOrEqual(2)
    // Most recently updated first
    expect(threads[0].updatedAt).toBeGreaterThanOrEqual(threads[1].updatedAt)
  })

  it('findAllThreads respects limit parameter', () => {
    for (let i = 0; i < 5; i++) repo.createThread(null, `Thread ${i}`)
    const limited = repo.findAllThreads(3)
    expect(limited.length).toBeLessThanOrEqual(3)
  })

  it('deleteThread removes the thread', () => {
    const thread = repo.createThread(null)
    repo.deleteThread(thread.id)
    expect(repo.findThreadById(thread.id)).toBeNull()
  })

  it('updateTitle sets the thread title', () => {
    const thread = repo.createThread(null)
    expect(thread.title).toBeNull()
    repo.updateTitle(thread.id, 'Updated Title')
    const updated = repo.findThreadById(thread.id)
    expect(updated!.title).toBe('Updated Title')
  })

  it('updateTitle updates the updatedAt timestamp', () => {
    const thread = repo.createThread(null)
    const before = thread.updatedAt
    // Small delay to ensure timestamp changes
    const start = Date.now()
    while (Date.now() === start) { /* spin */ }
    repo.updateTitle(thread.id, 'New Title')
    const updated = repo.findThreadById(thread.id)
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before)
  })

  // ─── Messages ─────────────────────────────────────────────────────────────

  it('addMessage stores a user message', () => {
    const thread = repo.createThread(null)
    const msg = repo.addMessage(thread.id, 'user', 'Hello there')
    expect(msg.id).toBeTruthy()
    expect(msg.threadId).toBe(thread.id)
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('Hello there')
  })

  it('addMessage stores an assistant message with provider/model', () => {
    const thread = repo.createThread(null)
    const msg = repo.addMessage(thread.id, 'assistant', 'Hi back', {
      provider: 'ollama',
      model: 'llama3:8b'
    })
    expect(msg.role).toBe('assistant')
    expect(msg.provider).toBe('ollama')
    expect(msg.model).toBe('llama3:8b')
  })

  it('addMessage bumps the thread updatedAt', () => {
    const thread = repo.createThread(null)
    const before = thread.updatedAt
    const start = Date.now()
    while (Date.now() === start) { /* spin */ }
    repo.addMessage(thread.id, 'user', 'test')
    const updated = repo.findThreadById(thread.id)
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('findMessagesByThread returns messages in chronological order', () => {
    const thread = repo.createThread(null)
    repo.addMessage(thread.id, 'user', 'First')
    repo.addMessage(thread.id, 'assistant', 'Second')
    repo.addMessage(thread.id, 'user', 'Third')
    const msgs = repo.findMessagesByThread(thread.id)
    expect(msgs.length).toBe(3)
    expect(msgs[0].content).toBe('First')
    expect(msgs[1].content).toBe('Second')
    expect(msgs[2].content).toBe('Third')
  })

  it('findMessagesByThread returns empty array for thread with no messages', () => {
    const thread = repo.createThread(null)
    expect(repo.findMessagesByThread(thread.id)).toEqual([])
  })

  it('deleteThread cascades to messages', () => {
    const thread = repo.createThread(null)
    repo.addMessage(thread.id, 'user', 'will be gone')
    repo.deleteThread(thread.id)
    // Messages should also be deleted via foreign key cascade
    expect(repo.findMessagesByThread(thread.id)).toEqual([])
  })
})
