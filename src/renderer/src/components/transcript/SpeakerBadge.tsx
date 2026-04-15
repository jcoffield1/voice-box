interface Props {
  name: string | null | undefined
  confidence?: number | null
}

const COLORS = [
  'bg-violet-500/20 text-violet-300 border-violet-500/30',
  'bg-sky-500/20 text-sky-300 border-sky-500/30',
  'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  'bg-amber-500/20 text-amber-300 border-amber-500/30',
  'bg-rose-500/20 text-rose-300 border-rose-500/30',
  'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30'
]

function colorForLabel(label: string) {
  let h = 0
  for (let i = 0; i < label.length; i++) h += label.charCodeAt(i)
  return COLORS[h % COLORS.length]
}

export default function SpeakerBadge({ name, confidence }: Props) {
  if (!name) return null
  const color = colorForLabel(name)
  const pct = confidence != null ? Math.round(confidence * 100) : null

  return (
    <div className="flex flex-col items-start gap-0.5">
      <span
        className={`inline-block text-xs px-2 py-0.5 rounded-full border truncate max-w-full ${color}`}
        title={name}
      >
        {name}
      </span>
      {pct != null && (
        <span
          className={`text-[10px] font-mono pl-0.5 ${
            pct < 70 ? 'text-amber-400' : 'text-zinc-500'
          }`}
          title={`Speaker confidence: ${pct}%`}
        >
          {pct}%
        </span>
      )}
    </div>
  )
}
