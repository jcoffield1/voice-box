interface Props {
  /** 0–1 RMS level */
  level: number
  className?: string
}

const BARS = 12

export default function AudioLevelBar({ level, className = '' }: Props) {
  const filled = Math.round(level * BARS)

  return (
    <div className={`flex items-end gap-0.5 h-4 ${className}`} role="meter" aria-valuenow={Math.round(level * 100)}>
      {Array.from({ length: BARS }, (_, i) => (
        <div
          key={i}
          className={`w-1 rounded-sm transition-all duration-75 ${
            i < filled ? 'bg-accent' : 'bg-surface-600'
          }`}
          style={{ height: `${30 + (i / BARS) * 70}%` }}
        />
      ))}
    </div>
  )
}
