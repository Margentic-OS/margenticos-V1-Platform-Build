// Status variant controls the pill colour and dot — matches design.md status pill spec.

interface DashboardTopbarProps {
  eyebrow: string
  title: string
  subtitle: string
  statusLabel: string
  statusVariant: 'setup' | 'warming' | 'live'
  orgInitials: string
}

const STATUS_STYLES: Record<
  DashboardTopbarProps['statusVariant'],
  { pill: string; text: string; dot: string }
> = {
  setup: {
    pill: 'bg-[#F0ECE4]',
    text: 'text-text-secondary',
    dot: 'bg-text-muted',
  },
  warming: {
    pill: 'bg-[#FEF7E6]',
    text: 'text-[#7A4800]',
    dot: 'bg-brand-amber',
  },
  live: {
    pill: 'bg-[#EBF5E6]',
    text: 'text-brand-green-success',
    dot: 'bg-brand-green-success',
  },
}

export function DashboardTopbar({
  eyebrow,
  title,
  subtitle,
  statusLabel,
  statusVariant,
  orgInitials,
}: DashboardTopbarProps) {
  const s = STATUS_STYLES[statusVariant]

  return (
    <header className="h-14 bg-surface-content border-b border-border-card flex items-center justify-between px-7 shrink-0">
      <div>
        <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-[2px]">
          {eyebrow}
        </p>
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[18px] font-medium text-text-primary leading-none">
            {title}
          </h1>
          {subtitle && (
            <span className="text-[12px] text-text-secondary">{subtitle}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Status pill */}
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full ${s.pill}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
          <span className={`text-[11px] font-medium ${s.text}`}>{statusLabel}</span>
        </div>

        {/* Avatar initials */}
        <div className="w-8 h-8 rounded-full bg-brand-green flex items-center justify-center shrink-0">
          <span className="text-[10px] font-medium text-[#F5F0E8] tracking-[0.04em]">
            {orgInitials}
          </span>
        </div>
      </div>
    </header>
  )
}
