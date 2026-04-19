import Link from 'next/link'

interface OperatorTopbarProps {
  eyebrow: string
  title: string
  subtitle?: string
}

export function OperatorTopbar({ eyebrow, title, subtitle }: OperatorTopbarProps) {
  return (
    <header className="h-14 bg-surface-content border-b border-border-card flex items-center justify-between px-7 shrink-0 print:hidden">
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
        {/* View as client — strips operator additions and shows the pure client experience */}
        <Link
          href="/dashboard"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] bg-[#F0ECE4] border border-[#E8E2D8] text-[12px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M6 2C3.79 2 2 3.79 2 6s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4Zm0 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0 5.7a3.2 3.2 0 0 1-2.67-1.43C3.35 7.04 4.67 6.7 6 6.7c1.33 0 2.65.34 2.67 1.07A3.2 3.2 0 0 1 6 9.2Z"
              fill="currentColor"
            />
          </svg>
          View as client
        </Link>

        {/* Operator avatar */}
        <div className="w-8 h-8 rounded-full bg-[#FEF7E6] border border-[#F0D080] flex items-center justify-center shrink-0">
          <span className="text-[10px] font-medium text-[#7A4800] tracking-[0.04em]">DP</span>
        </div>
      </div>
    </header>
  )
}
