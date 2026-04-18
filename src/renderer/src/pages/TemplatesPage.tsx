import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Download, Upload, Trash2, Pencil, Check, X, FileText, Star,
  HelpCircle, Eye, FlaskConical, ChevronDown, ChevronUp, Loader2, Copy
} from 'lucide-react'
import type { SummaryTemplate, Recording } from '@shared/types'
import type { LLMProviderType } from '@shared/types'
import { useSettingsStore } from '../store/settingsStore'

// ─── Placeholder hint ─────────────────────────────────────────────────────────

const SAMPLE_TRANSCRIPT = `[0:05] Speaker 1: Welcome to today's call. Let's walk through the Q2 roadmap.
[0:12] Speaker 2: Thanks. I've reviewed the proposal and have a few questions.
[0:18] Speaker 1: Of course — go ahead.
[0:21] Speaker 2: The timeline looks aggressive. Can we add a two-week buffer after design?
[0:28] Speaker 1: Good point. I'll update the project plan to include that buffer.
[0:35] Speaker 2: Also, the QA budget seems low. Should we flag it?
[0:41] Speaker 1: Yes — let's add a QA line item and review it next week.
[0:47] Speaker 2: I'll draft the updated budget proposal by Friday.`

// ─── Collapsible help section ─────────────────────────────────────────────────

function HelpPanel({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1 mb-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <HelpCircle className="w-3 h-3" />
        {open ? 'Hide help' : 'What is this?'}
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2.5 text-xs text-zinc-300 space-y-1.5">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

type EditorTab = 'edit' | 'preview' | 'test'

function TabBar({ active, onChange }: { active: EditorTab; onChange: (t: EditorTab) => void }) {
  const tabs: { id: EditorTab; label: string; Icon: React.ElementType }[] = [
    { id: 'edit', label: 'Edit', Icon: Pencil },
    { id: 'preview', label: 'Preview', Icon: Eye },
    { id: 'test', label: 'Test', Icon: FlaskConical },
  ]
  return (
    <div className="flex items-center gap-1 border-b border-zinc-700 pb-2 mb-3">
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
            active === id
              ? 'bg-accent/20 text-accent border border-accent/30'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          <Icon className="w-3 h-3" />
          {label}
        </button>
      ))}
    </div>
  )
}

// ─── Preview tab ──────────────────────────────────────────────────────────────

function PreviewTab({
  systemPrompt,
  userPromptTemplate,
}: {
  systemPrompt: string
  userPromptTemplate: string
}) {
  const [sampleTitle, setSampleTitle] = useState('Sample Recording Title')
  const [sampleTranscript, setSampleTranscript] = useState(SAMPLE_TRANSCRIPT)

  const renderedUserPrompt = userPromptTemplate
    .replace(/\{\{title\}\}/g, sampleTitle || '{{title}}')
    .replace(/\{\{transcript\}\}/g, sampleTranscript || '{{transcript}}')

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">
        Edit the sample data below to see how your template renders before testing it against a real recording.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Sample Title</label>
          <input
            className="input w-full text-xs"
            value={sampleTitle}
            onChange={(e) => setSampleTitle(e.target.value)}
          />
        </div>
        <div className="text-xs text-zinc-500 flex items-end pb-1">
          Substituted for <code className="text-accent font-mono mx-1">{'{{title}}'}</code>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1">Sample Transcript</label>
        <textarea
          className="input w-full font-mono text-xs resize-y"
          rows={6}
          value={sampleTranscript}
          onChange={(e) => setSampleTranscript(e.target.value)}
        />
        <p className="text-xs text-zinc-500 mt-0.5">
          Substituted for <code className="text-accent font-mono">{'{{transcript}}'}</code>
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-xs font-medium text-zinc-400 mb-1">Rendered System Prompt</div>
          <pre className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-300 whitespace-pre-wrap font-mono overflow-auto max-h-48">
            {systemPrompt || <span className="text-zinc-600 italic">(empty)</span>}
          </pre>
        </div>
        <div>
          <div className="text-xs font-medium text-zinc-400 mb-1">Rendered User Message</div>
          <pre className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-300 whitespace-pre-wrap font-mono overflow-auto max-h-64">
            {renderedUserPrompt || <span className="text-zinc-600 italic">(empty)</span>}
          </pre>
        </div>
      </div>
    </div>
  )
}

// ─── Test tab ─────────────────────────────────────────────────────────────────

function TestTab({
  systemPrompt,
  userPromptTemplate,
}: {
  systemPrompt: string
  userPromptTemplate: string
}) {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [recordingId, setRecordingId] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ text: string; model: string; provider: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providerMap = useSettingsStore((s) => s.providerMap)
  const modelMap = useSettingsStore((s) => s.modelMap)
  const provider = (providerMap['summarization'] ?? 'ollama') as LLMProviderType
  const model = modelMap['summarization'] ?? ''

  useEffect(() => {
    window.api.recording.getAll().then(({ recordings: list }) => {
      const withTranscripts = list.filter((r) => r.status === 'complete')
      setRecordings(withTranscripts)
      if (withTranscripts.length > 0) setRecordingId(withTranscripts[0].id)
    }).catch(() => {})
  }, [])

  const handleRun = useCallback(async () => {
    if (!recordingId || !systemPrompt.trim() || !userPromptTemplate.trim()) return
    setRunning(true)
    setResult(null)
    setError(null)
    try {
      const res = await window.api.template.test({
        systemPrompt,
        userPromptTemplate,
        recordingId,
        model,
        provider
      })
      setResult({ text: res.result, model: res.model, provider: res.provider })
    } catch (err) {
      setError((err as Error).message ?? 'Unknown error')
    } finally {
      setRunning(false)
    }
  }, [recordingId, systemPrompt, userPromptTemplate, model, provider])

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">
        Run your template against a real recording to see the LLM output before saving. Uses your current{' '}
        <span className="text-zinc-200">summarization</span> provider ({provider}).
      </p>

      {recordings.length === 0 ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-4 text-xs text-zinc-500 text-center">
          No transcribed recordings found. Record and transcribe something first.
        </div>
      ) : (
        <>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Recording to test against</label>
            <select
              className="input w-full text-sm"
              value={recordingId}
              onChange={(e) => setRecordingId(e.target.value)}
            >
              {recordings.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary flex items-center gap-1.5 text-sm"
              disabled={running || !systemPrompt.trim() || !userPromptTemplate.trim()}
              onClick={() => void handleRun()}
            >
              {running ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" />Running…</>
              ) : (
                <><FlaskConical className="w-3.5 h-3.5" />Run Test</>
              )}
            </button>
            {result && (
              <span className="text-xs text-zinc-500">
                via {result.provider} · {result.model}
              </span>
            )}
          </div>
        </>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div>
          <div className="text-xs font-medium text-zinc-400 mb-1">Generated Output</div>
          <div className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-3 text-xs text-zinc-200 whitespace-pre-wrap font-mono overflow-auto max-h-96">
            {result.text}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Editor form (create or edit) ─────────────────────────────────────────────

interface EditorProps {
  initial?: Partial<SummaryTemplate>
  onSave: (fields: { name: string; systemPrompt: string; userPromptTemplate: string }) => Promise<void>
  onCancel: () => void
  saving: boolean
}

function TemplateEditor({ initial, onSave, onCancel, saving }: EditorProps) {
  const [tab, setTab] = useState<EditorTab>('edit')
  const [name, setName] = useState(initial?.name ?? '')
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '')
  const [userPromptTemplate, setUserPromptTemplate] = useState(initial?.userPromptTemplate ?? '')

  const canSave = name.trim() && systemPrompt.trim() && userPromptTemplate.trim() && !saving

  return (
    <div className="space-y-4">
      {/* Name field always visible */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1">Template Name</label>
        <input
          className="input w-full"
          placeholder="e.g. Sales Call, Investor Meeting, Stand-up…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      </div>

      <TabBar active={tab} onChange={setTab} />

      {/* ── Edit tab ── */}
      {tab === 'edit' && (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">System Prompt</label>
            <HelpPanel>
              <p>
                The <strong className="text-zinc-200">system prompt</strong> is sent to the AI as a hidden "role" instruction before any content. Use it to define the AI&apos;s persona, output format, and tone.
              </p>
              <p className="text-zinc-400">Example:</p>
              <pre className="rounded bg-zinc-900 px-2 py-1.5 text-zinc-300 font-mono text-[10px] whitespace-pre-wrap">{`You are an expert sales coach reviewing call recordings.
Produce a structured debrief with:
1. Deal Stage & Customer Sentiment
2. Objections Raised
3. Next Steps & Owner
4. Coaching Notes for the rep

Be concise and use bullet points.`}</pre>
            </HelpPanel>
            <textarea
              className="input w-full font-mono text-xs resize-y"
              rows={8}
              placeholder="Instructions sent to the AI as the system role…"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">User Prompt Template</label>
            <HelpPanel>
              <p>
                The <strong className="text-zinc-200">user prompt template</strong> is the message that gets sent to the AI with the recording&apos;s content filled in. Use the placeholders below anywhere in the text:
              </p>
              <ul className="space-y-1 mt-1">
                <li><code className="text-accent font-mono">{'{{title}}'}</code> — replaced with the recording&apos;s title</li>
                <li><code className="text-accent font-mono">{'{{transcript}}'}</code> — replaced with the full transcript (timestamped, speaker-labeled)</li>
              </ul>
              <p className="text-zinc-400 mt-1">Example:</p>
              <pre className="rounded bg-zinc-900 px-2 py-1.5 text-zinc-300 font-mono text-[10px] whitespace-pre-wrap">{`Please create a sales call debrief for "{{title}}":

{{transcript}}`}</pre>
              <p className="text-zinc-400 mt-1.5">
                Tip: keep the user prompt short and let the system prompt do the heavy lifting for format and tone.
              </p>
            </HelpPanel>
            <textarea
              className="input w-full font-mono text-xs resize-y"
              rows={4}
              placeholder={'Please create a full debrief for "{{title}}":\n\n{{transcript}}'}
              value={userPromptTemplate}
              onChange={(e) => setUserPromptTemplate(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              className="btn btn-primary flex items-center gap-1.5"
              disabled={!canSave}
              onClick={() => void onSave({ name: name.trim(), systemPrompt, userPromptTemplate })}
            >
              <Check className="w-3.5 h-3.5" />
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-ghost flex items-center gap-1.5" onClick={onCancel}>
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Preview tab ── */}
      {tab === 'preview' && (
        <PreviewTab systemPrompt={systemPrompt} userPromptTemplate={userPromptTemplate} />
      )}

      {/* ── Test tab ── */}
      {tab === 'test' && (
        <TestTab systemPrompt={systemPrompt} userPromptTemplate={userPromptTemplate} />
      )}

      {/* Save/Cancel always visible on preview and test tabs too */}
      {tab !== 'edit' && (
        <div className="flex items-center gap-2 pt-1 border-t border-zinc-800">
          <button
            className="btn btn-primary flex items-center gap-1.5"
            disabled={!canSave}
            onClick={() => void onSave({ name: name.trim(), systemPrompt, userPromptTemplate })}
          >
            <Check className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save Template'}
          </button>
          <button className="btn btn-ghost flex items-center gap-1.5" onClick={onCancel}>
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Single template card ─────────────────────────────────────────────────────

interface TemplateCardProps {
  template: SummaryTemplate
  onEdit: (t: SummaryTemplate) => void
  onClone: (t: SummaryTemplate) => void
  onDelete: (t: SummaryTemplate) => void
  onExport: (t: SummaryTemplate) => void
}

function TemplateCard({ template, onEdit, onClone, onDelete, onExport }: TemplateCardProps) {
  const preview = template.systemPrompt.slice(0, 140).replace(/\n/g, ' ')
  return (
    <div className="card space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-100 text-sm truncate">{template.name}</span>
            {template.isDefault && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-full px-2 py-0.5 shrink-0">
                <Star className="w-2.5 h-2.5" />
                Default
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{preview}…</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            title="Edit"
            className="btn btn-ghost p-1.5"
            onClick={() => onEdit(template)}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            title="Duplicate"
            className="btn btn-ghost p-1.5"
            onClick={() => onClone(template)}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            title="Export as JSON"
            className="btn btn-ghost p-1.5"
            onClick={() => onExport(template)}
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          {!template.isDefault && (
            <button
              title="Delete"
              className="btn btn-ghost p-1.5 text-red-400 hover:text-red-300"
              onClick={() => onDelete(template)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<SummaryTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // null = no editor open; 'new' = creating; template = editing
  const [editing, setEditing] = useState<SummaryTemplate | 'new' | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const { templates: list } = await window.api.template.getAll()
      setTemplates(list)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleSave = useCallback(async (fields: { name: string; systemPrompt: string; userPromptTemplate: string }) => {
    setSaving(true)
    try {
      if (editing === 'new') {
        await window.api.template.create(fields)
      } else if (editing) {
        await window.api.template.update({ templateId: editing.id, ...fields })
      }
      setEditing(null)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [editing, load])

  const handleDelete = useCallback(async (template: SummaryTemplate) => {
    if (!window.confirm(`Delete "${template.name}"? Recordings using it will fall back to the default template.`)) return
    try {
      await window.api.template.delete({ templateId: template.id })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }, [load])

  const handleClone = useCallback(async (template: SummaryTemplate) => {
    try {
      await window.api.template.clone({ templateId: template.id })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }, [load])

  const handleExport = useCallback(async (template: SummaryTemplate) => {
    try {
      await window.api.template.export({ templateId: template.id })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (!msg.includes('cancelled')) setError(msg)
    }
  }, [])

  const handleImport = useCallback(async () => {
    try {
      const { template } = await window.api.template.import()
      setTemplates((prev) => [...prev, template])
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (!msg.includes('cancelled')) setError(msg)
    }
  }, [])

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="text-sm text-zinc-500">Loading templates…</div>
      </div>
    )
  }

  const editingTemplate = editing !== null && editing !== 'new' ? editing : undefined

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Summary Templates</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Templates control the AI prompt used to generate debriefs. Assign one to any recording for a custom output style.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="btn btn-ghost flex items-center gap-1.5 text-sm"
            onClick={() => void handleImport()}
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
          <button
            className="btn btn-primary flex items-center gap-1.5 text-sm"
            onClick={() => setEditing('new')}
          >
            <Plus className="w-4 h-4" />
            New Template
          </button>
        </div>
      </div>

      {/* Inline error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-start gap-2">
          <X className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
          <button className="ml-auto" onClick={() => setError(null)}><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* New template editor */}
      {editing === 'new' && (
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <FileText className="w-4 h-4 text-accent" />
            New Template
          </h2>
          <TemplateEditor
            onSave={handleSave}
            onCancel={() => setEditing(null)}
            saving={saving}
          />
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 && editing !== 'new' ? (
        <div className="text-sm text-zinc-500 text-center py-12">No templates yet.</div>
      ) : (
        <div className="space-y-3">
          {templates.map((t) =>
            editing !== 'new' && editingTemplate?.id === t.id ? (
              <div key={t.id} className="card space-y-3">
                <h2 className="text-sm font-semibold text-zinc-200">Editing: {t.name}</h2>
                <TemplateEditor
                  initial={editingTemplate}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                  saving={saving}
                />
              </div>
            ) : (
              <TemplateCard
                key={t.id}
                template={t}
                onEdit={setEditing}
                onClone={(tpl) => void handleClone(tpl)}
                onDelete={(tpl) => void handleDelete(tpl)}
                onExport={(tpl) => void handleExport(tpl)}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}
