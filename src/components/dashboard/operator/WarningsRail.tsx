'use client'

import { useState } from 'react'

interface Warning {
  id: string
  clientName: string
  description: string
  severity: 'amber' | 'red'
  detail: string
  action: string
}

// TODO: Replace with real warnings query when the warnings engine is implemented.
// Warnings should come from a dedicated table (e.g. client_warnings or alerts),
// joined with organisations to get client names, filtered to status = 'active'.
const PLACEHOLDER_WARNINGS: Warning[] = [
  {
    id: 'w1',
    clientName: 'Apex Consulting',
    description: 'Reply rate dropped to 1.8% over 7 days. Worth investigating.',
    severity: 'amber',
    detail: 'Reply rate has been below the 3% amber threshold for 7 consecutive days. The previous 7-day average was 4.1%. Subject line variance may be the cause.',
    action: 'Check subject line performance and sending domain reputation in Instantly. Consider pausing lowest-performing sequences while investigating.',
  },
  {
    id: 'w2',
    clientName: 'Meridian Group',
    description: 'Bounce rate at 3.4%. Campaign auto-paused.',
    severity: 'red',
    detail: 'Bounce rate exceeded the 3% auto-pause threshold on 18 April. Campaign paused automatically. 47 bounces recorded this week against 1,382 sends.',
    action: 'Verify email list hygiene in Apollo before resuming. Re-validate contacts for affected sequences. Check MX records for target domains.',
  },
]

function WarningRow({ warning }: { warning: Warning }) {
  const [expanded, setExpanded] = useState(false)

  const isAmber = warning.severity === 'amber'
  const styles = isAmber
    ? {
        bg: 'bg-[#FEF7E6]',
        border: 'border-[#F0D080]',
        dot: 'bg-brand-amber',
        text: 'text-[#7A4800]',
        chevron: '#7A4800',
      }
    : {
        bg: 'bg-[#FDEEE8]',
        border: 'border-[#EFBCAA]',
        dot: 'bg-[#8B2020]',
        text: 'text-[#8B2020]',
        chevron: '#8B2020',
      }

  return (
    <div className={`border ${styles.border} ${styles.bg} rounded-[6px] overflow-hidden`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:opacity-90 transition-opacity"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot}`} />
        <span className={`text-[11px] flex-1 ${styles.text}`}>
          <span className="font-medium">{warning.clientName}</span>
          {' — '}
          <span className="font-normal">{warning.description}</span>
        </span>
        <svg
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path
            d="M1 1L5 5L9 1"
            stroke={styles.chevron}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {expanded && (
        <div className={`px-4 pb-3 border-t ${styles.border}`}>
          <p className={`text-[11px] ${styles.text} mt-2.5 leading-relaxed`}>
            {warning.detail}
          </p>
          <p className={`text-[11px] ${styles.text} mt-2 leading-relaxed`}>
            <span className="font-medium">Recommended action: </span>
            {warning.action}
          </p>
        </div>
      )}
    </div>
  )
}

export function WarningsRail({ warnings = PLACEHOLDER_WARNINGS }: { warnings?: Warning[] }) {
  if (warnings.length === 0) return null

  return (
    <div className="px-7 py-3 border-b border-border-card space-y-2 bg-surface-content">
      {warnings.map((w) => (
        <WarningRow key={w.id} warning={w} />
      ))}
    </div>
  )
}
