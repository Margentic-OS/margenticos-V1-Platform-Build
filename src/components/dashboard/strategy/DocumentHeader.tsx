// Version badge and living status row — shown at top of every strategy document view.
// Design spec: "v2.1 — Updated 3 days ago · Trigger added" + pulse dot + status line.

function formatRelativeDate(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const days = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return '1 week ago'
  return `${Math.floor(days / 7)} weeks ago`
}

interface DocumentHeaderProps {
  version: string
  updatedAt: string
  updateTrigger: string | null
}

export function DocumentHeader({ version, updatedAt, updateTrigger }: DocumentHeaderProps) {
  const updatedText = formatRelativeDate(updatedAt)

  return (
    <div className="flex items-start justify-between mb-6">
      <div className="space-y-1.5">
        {/* Version + date line */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-text-secondary bg-[#F0ECE4] px-1.5 py-0.5 rounded-[4px]">
            v{version}
          </span>
          <span className="text-[11px] text-text-secondary">
            Updated {updatedText}
            {updateTrigger && (
              <span className="text-text-muted"> · {updateTrigger}</span>
            )}
          </span>
        </div>

        {/* Living status */}
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-green-success shrink-0" />
          <span className="text-[11px] text-text-secondary">
            Strategy is learning from campaign data
          </span>
        </div>
      </div>
    </div>
  )
}
