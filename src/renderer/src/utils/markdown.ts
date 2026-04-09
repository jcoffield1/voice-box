/**
 * Lightweight, dependency-free Markdown → safe HTML renderer.
 * Handles the subset typically output by LLMs:
 *   - **bold** / *italic* / `inline code`
 *   - ## / ### headings
 *   - - bullet lists and 1. numbered lists
 *   - Blank-line paragraph separation
 * All input text is HTML-escaped BEFORE applying markup patterns,
 * so injected user content can never become executable HTML/JS.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function processInline(text: string): string {
  return (
    text
      // Bold+italic: ***text***
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      // Bold: **text**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic: *text* or _text_ (not preceded by word char to avoid mid-word _)
      .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>')
      .replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>')
      // Inline code: `code`
      .replace(/`([^`]+)`/g, '<code class="text-xs font-mono bg-surface-600 px-1 rounded">$1</code>')
  )
}

export function renderMarkdown(raw: string): string {
  // Split into lines for block-level processing
  const lines = escapeHtml(raw).split('\n')
  const out: string[] = []
  let inUl = false
  let inOl = false

  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false }
    if (inOl) { out.push('</ol>'); inOl = false }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Headings  ## / ###
    const h3Match = /^###\s+(.+)$/.exec(line)
    const h2Match = /^##\s+(.+)$/.exec(line)
    const h1Match = /^#\s+(.+)$/.exec(line)
    if (h3Match ?? h2Match ?? h1Match) {
      closeList()
      const lvl = h1Match ? 'h3' : h2Match ? 'h4' : 'h5'
      const content = processInline((h1Match ?? h2Match ?? h3Match)![1])
      const cls = 'font-semibold text-zinc-100 mt-3 mb-1'
      out.push(`<${lvl} class="${cls}">${content}</${lvl}>`)
      continue
    }

    // Unordered list: - item or * item
    const ulMatch = /^[\-\*]\s+(.+)$/.exec(line)
    if (ulMatch) {
      if (!inUl) { closeList(); out.push('<ul class="list-disc pl-5 my-1 space-y-0.5">'); inUl = true }
      out.push(`<li>${processInline(ulMatch[1])}</li>`)
      continue
    }

    // Ordered list: 1. item
    const olMatch = /^\d+\.\s+(.+)$/.exec(line)
    if (olMatch) {
      if (!inOl) { closeList(); out.push('<ol class="list-decimal pl-5 my-1 space-y-0.5">'); inOl = true }
      out.push(`<li>${processInline(olMatch[1])}</li>`)
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      closeList()
      out.push('<hr class="border-surface-600 my-2" />')
      continue
    }

    // Blank line closes any open list, becomes paragraph break
    if (line.trim() === '') {
      closeList()
      // Only add a paragraph break if there's pending text (avoid double-spacing)
      if (out.length > 0 && out[out.length - 1] !== '<br>' && !out[out.length - 1].endsWith('</ul>') && !out[out.length - 1].endsWith('</ol>')) {
        out.push('<br>')
      }
      continue
    }

    // Regular paragraph line
    closeList()
    out.push(`<span>${processInline(line)}</span><br>`)
  }

  closeList()

  // Trim trailing <br> tags
  while (out.length > 0 && out[out.length - 1] === '<br>') out.pop()

  return out.join('\n')
}
