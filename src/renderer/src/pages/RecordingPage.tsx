import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import {
  ArrowLeft, Pencil, Check, X, Download, FileText, Tag, StickyNote, Maximize2, Minimize2, Loader2, LayoutTemplate
} from 'lucide-react'
import type { SummaryTemplate } from '@shared/types'
import TranscriptView from '../components/transcript/TranscriptView'
import AIPanel from '../components/ai/AIPanel'
import AudioPlayer from '../components/recording/AudioPlayer'
import { useRecordingStore } from '../store/recordingStore'
import DictationButton from '../components/notes/DictationButton'

function formatDate(ts: number) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  })
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return '—'
  const s = seconds
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

type Tab = 'transcript' | 'summary' | 'notes'

export default function RecordingPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const jumpToMs = searchParams.get('t') ? Number(searchParams.get('t')) : null
  const askParam = searchParams.get('ask') ? decodeURIComponent(searchParams.get('ask')!) : undefined

  const recordings = useRecordingStore((s) => s.recordings)
  const updateRecording = useRecordingStore((s) => s.updateRecording)
  const recording = recordings.find((r) => r.id === id)
  const isLive = useRecordingStore((s) => s.isRecording && s.activeRecordingId === id)

  // Tab + maximize
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [maximized, setMaximized] = useState(false)

  // Title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Notes
  const [notesDraft, setNotesDraft] = useState(recording?.notes ?? '')
  const [notesDirty, setNotesDirty] = useState(false)

  // Tags
  const [tags, setTags] = useState<string[]>(recording?.tags ?? [])
  const [tagInput, setTagInput] = useState('')
  const tagInputRef = useRef<HTMLInputElement>(null)
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Template picker
  const [templates, setTemplates] = useState<SummaryTemplate[]>([])
  const [templateId, setTemplateId] = useState<string | null>(recording?.templateId ?? null)

  // Export
  const [exportOpen, setExportOpen] = useState(false)
  const [exportSuccess, setExportSuccess] = useState<string | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)

  // Playback sync: currentTime from AudioPlayer drives transcript highlight;
  // seekToSeconds is set when the user clicks a segment play button.
  const [playbackSeconds, setPlaybackSeconds] = useState<number | undefined>(undefined)
  const [seekToSeconds, setSeekToSeconds] = useState<number | undefined>(undefined)

  useEffect(() => {
    setNotesDraft(recording?.notes ?? '')
    setTags(recording?.tags ?? [])
    setTemplateId(recording?.templateId ?? null)
  }, [recording?.id])

  useEffect(() => {
    window.api.template.getAll().then(({ templates: list }) => setTemplates(list)).catch(() => {})
  }, [])

  useEffect(() => {
    if (editingTitle && titleInputRef.current) titleInputRef.current.focus()
  }, [editingTitle])

  // Switch to summary tab when debrief arrives while we're on this page
  useEffect(() => {
    if (recording?.debrief && activeTab === 'transcript') {
      // Don't auto-switch — just let the tab glow/indicate availability
    }
  }, [recording?.debrief])

  const saveTitle = useCallback(async () => {
    const trimmed = titleDraft.trim()
    if (!trimmed || !id) { setEditingTitle(false); return }
    const { recording: updated } = await window.api.recording.update({ recordingId: id, title: trimmed })
    if (updated) updateRecording(updated)
    setEditingTitle(false)
  }, [id, titleDraft, updateRecording])

  const saveNotes = useCallback(async () => {
    if (!notesDirty || !id) return
    const { recording: updated } = await window.api.recording.update({ recordingId: id, notes: notesDraft })
    if (updated) updateRecording(updated)
    setNotesDirty(false)
  }, [id, notesDraft, notesDirty, updateRecording])

  const persistTags = useCallback(async (next: string[]) => {
    if (!id) return
    const { recording: updated } = await window.api.recording.update({ recordingId: id, tags: next })
    if (updated) updateRecording(updated)
  }, [id, updateRecording])

  const addTag = useCallback(async (raw: string) => {
    const value = raw.trim().replace(/,+$/, '').trim()
    if (!value || tags.includes(value)) { setTagInput(''); return }
    const next = [...tags, value]
    setTags(next)
    setTagInput('')
    await persistTags(next)
  }, [tags, persistTags])

  const removeTag = useCallback(async (tag: string) => {
    const next = tags.filter((t) => t !== tag)
    setTags(next)
    await persistTags(next)
  }, [tags, persistTags])

  const exportTranscript = useCallback(async (format: 'txt' | 'md' | 'srt') => {
    if (!id) return
    setExportOpen(false)
    const result = await window.api.recording.export({ recordingId: id, format })
    const blob = new Blob([result.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.filename
    a.click()
    URL.revokeObjectURL(url)
    setExportSuccess(format.toUpperCase())
    setTimeout(() => setExportSuccess(null), 3000)
  }, [id])

  const exportSummary = useCallback(async (format: 'txt' | 'md' | 'docx' | 'pdf') => {
    if (!id) return
    setExportOpen(false)
    const result = await window.api.recording.exportSummary({ recordingId: id, format })
    if (result.savedTo) {
      setExportSuccess(format.toUpperCase())
      setTimeout(() => setExportSuccess(null), 3000)
    }
  }, [id])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close maximize on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  if (!id) return null

  const isGeneratingDebrief = (recording?.status === 'processing' || recording?.status === 'complete') && !recording?.debrief

  // ── Summary tab content (shared between normal + maximized views) ──────────
  // NOTE: stored as a JSX element, not a function component, so it is never
  // unmounted when RecordingPage re-renders (e.g. when debrief arrives).
  const summaryContent = (
    <div className="space-y-4">
      {/* Summary Template */}
      <div className="flex items-center gap-2">
        <LayoutTemplate className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <select
          className="input text-sm flex-1"
          value={templateId ?? templates.find((t) => t.isDefault)?.id ?? templates[0]?.id ?? ''}
          onChange={async (e) => {
            const next = e.target.value || null
            setTemplateId(next)
            if (!id) return
            const { recording: updated } = await window.api.recording.update({ recordingId: id, templateId: next })
            if (updated) updateRecording(updated)
          }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      {recording?.debrief ? (
        <div className="selectable text-sm text-zinc-300 leading-relaxed [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-zinc-100 [&_h1]:mt-4 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h2]:mt-4 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-zinc-200 [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2 [&_li]:mb-0.5 [&_strong]:text-zinc-100 [&_strong]:font-semibold [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_th]:text-left [&_th]:text-zinc-400 [&_th]:pb-1 [&_th]:border-b [&_th]:border-surface-600 [&_td]:py-1 [&_td]:pr-4 [&_td]:border-b [&_td]:border-surface-700 [&_hr]:border-surface-600 [&_hr]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400">
          <ReactMarkdown>{recording.debrief}</ReactMarkdown>
        </div>
      ) : recording?.status === 'processing' ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-zinc-500">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <p className="text-sm">Transcription in progress — debrief will be generated when complete.</p>
        </div>
      ) : isGeneratingDebrief ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-zinc-500">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <p className="text-sm">Generating comprehensive debrief…</p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-zinc-500">
          <FileText className="w-8 h-8 opacity-30" />
          <p className="text-sm">No debrief available yet.</p>
          {recording?.status === 'complete' && (
            <p className="text-xs text-zinc-600">A full debrief is generated automatically after transcription finishes.</p>
          )}
        </div>
      )}
    </div>
  )

  // ── Transcript tab content (shared between normal + maximized views) ───────
  // NOTE: stored as a JSX element so TranscriptView (which owns the speaker-
  // label modal state) is never unmounted on RecordingPage re-renders.
  const transcriptTabContent = (
    <div className="space-y-4">
      <TranscriptView
        recordingId={id}
        isLive={isLive}
        jumpToSeconds={jumpToMs != null ? jumpToMs / 1000 : undefined}
        playbackSeconds={playbackSeconds}
        onSeek={(t) => setSeekToSeconds(t)}
      />
    </div>
  )

  // ── Notes tab content ─────────────────────────────────────────────────────
  const notesTabContent = (
    <div className="space-y-4">
      {/* Tags */}
      <div className="card space-y-2">
        <label className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <Tag className="w-3.5 h-3.5" />
          Tags
        </label>
        <div
          className="input flex flex-wrap gap-1.5 min-h-[2.25rem] cursor-text py-1.5 px-2"
          onClick={() => tagInputRef.current?.focus()}
        >
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 text-xs bg-accent/20 text-accent rounded-full pl-2 pr-1 py-0.5 border border-accent/30">
              {tag}
              <button
                type="button"
                className="hover:text-white transition-colors"
                onClick={(e) => { e.stopPropagation(); void removeTag(tag) }}
                aria-label={`Remove ${tag}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
          <input
            ref={tagInputRef}
            className="flex-1 min-w-[8rem] bg-transparent outline-none text-sm text-zinc-100 placeholder-zinc-600"
            placeholder={tags.length === 0 ? 'Add tags… press Enter or comma to add' : ''}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); void addTag(tagInput) }
              if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) void removeTag(tags[tags.length - 1])
            }}
            onBlur={() => { if (tagInput.trim()) void addTag(tagInput) }}
          />
        </div>
      </div>

      {/* Notes */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs font-medium text-zinc-400">
            <StickyNote className="w-3.5 h-3.5" />
            Notes
          </label>
          <DictationButton
            textareaRef={notesTextareaRef}
            onChange={(v) => { setNotesDraft(v); setNotesDirty(true) }}
          />
        </div>
        <textarea
          ref={notesTextareaRef}
          className="input text-sm resize-none w-full"
          rows={8}
          placeholder="Add notes about this recording…"
          value={notesDraft}
          onChange={(e) => { setNotesDraft(e.target.value); setNotesDirty(true) }}
          onBlur={() => void saveNotes()}
        />
      </div>
    </div>
  )

  return (
    <>
      {/* ── Maximized overlay ───────────────────────────────────────────── */}
      {maximized && (
        <div className="fixed inset-0 z-50 bg-surface-900 flex flex-col p-6 gap-4 overflow-hidden">
          {/* Header — app-region-no-drag so the Electron titlebar drag region
               doesn't swallow clicks on the exit button */}
          <div className="flex items-center justify-between shrink-0 app-region-no-drag">
            <h2 className="text-base font-semibold text-zinc-100 truncate">
              {recording?.title ?? 'Recording'}
            </h2>
            <button
              className="btn-ghost flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-300 hover:text-white shrink-0"
              onClick={() => setMaximized(false)}
              title="Exit fullscreen (Esc)"
            >
              <Minimize2 className="w-4 h-4" />
              <span>Exit fullscreen</span>
            </button>
          </div>

          {/* Audio player (so playback sync works in fullscreen) */}
          {!isLive && recording?.audioPath && (
            <div className="shrink-0">
              <AudioPlayer
                src={`vbfile://localhost${encodeURI(recording.audioPath)}`}
                onTimeUpdate={setPlaybackSeconds}
                seekToSeconds={seekToSeconds}
              />
            </div>
          )}

          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-surface-700 shrink-0">
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                activeTab === 'transcript'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setActiveTab('transcript')}
            >
              Transcript
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 flex items-center gap-1.5 ${
                activeTab === 'summary'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setActiveTab('summary')}
            >
              Summary
              {isGeneratingDebrief && <Loader2 className="w-3 h-3 animate-spin" />}
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                activeTab === 'notes'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setActiveTab('notes')}
            >
              Notes
            </button>
          </div>

          {/* Content — fills remaining height */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {activeTab === 'transcript' ? transcriptTabContent : activeTab === 'summary' ? summaryContent : notesTabContent}
          </div>
        </div>
      )}

      {/* ── Normal layout ────────────────────────────────────────────────── */}
      <div className="flex gap-6 h-full max-h-[calc(100vh-8rem)]">
        {/* Left column */}
        <div className="flex-1 flex flex-col min-w-0 space-y-4">
          {/* Header row */}
          <div className="flex items-center gap-3">
            <Link to="/recordings" className="text-zinc-400 hover:text-zinc-100 transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>

            {editingTitle ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  ref={titleInputRef}
                  className="input text-base py-1 flex-1"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveTitle()
                    if (e.key === 'Escape') setEditingTitle(false)
                  }}
                />
                <button className="btn-primary p-1.5" onClick={() => void saveTitle()}>
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button className="btn-ghost p-1.5" onClick={() => setEditingTitle(false)}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <h1 className="text-lg font-semibold text-zinc-100 truncate">
                  {recording?.title ?? 'Recording'}
                </h1>
                {!isLive && (
                  <button
                    className="btn-ghost p-1"
                    onClick={() => { setTitleDraft(recording?.title ?? ''); setEditingTitle(true) }}
                    title="Rename"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}

            {isLive && (
              <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full border border-red-500/30 shrink-0">
                LIVE
              </span>
            )}

            {/* Export dropdown */}
            {!isLive && (
              <div className="relative shrink-0" ref={exportRef}>
                <button
                  className="btn-ghost py-1.5 px-3 text-xs flex items-center gap-1.5"
                  onClick={() => setExportOpen((v) => !v)}
                >
                  <Download className="w-3.5 h-3.5" />
                  {exportSuccess ? `Saved as ${exportSuccess}` : 'Export'}
                </button>
                {exportOpen && (
                  <div className="absolute right-0 top-full mt-1 w-52 bg-surface-800 border border-surface-600 rounded-lg shadow-lg z-10 py-1">
                    <div className="px-3 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider font-medium">Transcript</div>
                    {([
                      { fmt: 'txt', label: 'Plain Text', desc: '.txt' },
                      { fmt: 'md',  label: 'Markdown',   desc: '.md' },
                      { fmt: 'srt', label: 'Subtitles',  desc: '.srt' },
                    ] as const).map(({ fmt, label, desc }) => (
                      <button
                        key={fmt}
                        className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-surface-700 flex items-center justify-between gap-2"
                        onClick={() => void exportTranscript(fmt)}
                      >
                        <span className="flex items-center gap-2"><FileText className="w-3 h-3 shrink-0" />{label}</span>
                        <span className="text-zinc-500">{desc}</span>
                      </button>
                    ))}
                    <div className="border-t border-surface-600 my-1" />
                    <div className="px-3 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider font-medium flex items-center justify-between">
                      Summary
                      {!recording?.debrief && <span className="text-[9px] text-zinc-600 normal-case tracking-normal">not yet available</span>}
                    </div>
                    {([
                      { fmt: 'pdf',  label: 'PDF Document',  desc: 'Print-ready' },
                      { fmt: 'docx', label: 'Word Document', desc: '.docx' },
                      { fmt: 'md',   label: 'Markdown',      desc: '.md' },
                      { fmt: 'txt',  label: 'Plain Text',    desc: '.txt' },
                    ] as const).map(({ fmt, label, desc }) => (
                      <button
                        key={fmt}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 ${
                          recording?.debrief
                            ? 'text-zinc-300 hover:bg-surface-700'
                            : 'text-zinc-600 cursor-not-allowed'
                        }`}
                        onClick={() => recording?.debrief && void exportSummary(fmt)}
                        disabled={!recording?.debrief}
                      >
                        <span className="flex items-center gap-2"><FileText className="w-3 h-3 shrink-0" />{label}</span>
                        <span className={recording?.debrief ? 'text-zinc-500' : 'text-zinc-700'}>{desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Meta info */}
          {recording && (
            <div className="text-xs text-zinc-500 flex flex-wrap gap-3">
              <span>{formatDate(recording.createdAt)}</span>
              <span>{formatDuration(recording.duration)}</span>
              <span className={`capitalize ${
                recording.status === 'complete' ? 'text-emerald-400' :
                recording.status === 'error' ? 'text-red-400' : 'text-zinc-400'
              }`}>{recording.status}</span>
            </div>
          )}

          {/* Audio player — hidden when maximized to avoid two competing audio instances */}
          {!isLive && recording?.audioPath && !maximized && (
            <AudioPlayer
              src={`vbfile://localhost${encodeURI(recording.audioPath)}`}
              jumpToSeconds={jumpToMs != null ? jumpToMs / 1000 : undefined}
              onTimeUpdate={setPlaybackSeconds}
              seekToSeconds={seekToSeconds}
            />
          )}

          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-surface-700">
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                activeTab === 'transcript'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setActiveTab('transcript')}
            >
              Transcript
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 flex items-center gap-1.5 ${
                activeTab === 'summary'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setActiveTab('summary')}
            >
              Summary
              {isGeneratingDebrief && <Loader2 className="w-3 h-3 animate-spin" />}
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                activeTab === 'notes'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setActiveTab('notes')}
            >
              Notes
            </button>
            <div className="ml-auto mb-1">
              <button
                className="btn-ghost p-1.5"
                onClick={() => setMaximized(true)}
                title="Fullscreen"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'transcript' ? transcriptTabContent : activeTab === 'summary' ? summaryContent : notesTabContent}
          </div>
        </div>

        {/* Right: AI panel */}
        <div className="w-80 flex-shrink-0">
          <AIPanel recordingId={id} initialMessage={askParam} />
        </div>
      </div>
    </>
  )
}
