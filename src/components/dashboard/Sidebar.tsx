'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export type DashboardState = 'intake_incomplete' | 'strategy_in_review' | 'documents_active'

interface SidebarProps {
  orgName: string
  pipelineUnlocked: boolean
  dashboardState: DashboardState
}

const NAV_RESULTS = [
  { label: 'Pipeline', href: '/dashboard/pipeline' },
  { label: 'Campaigns', href: '/dashboard/campaigns' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks' },
  { label: 'Approvals', href: '/dashboard/approvals' },
]

const NAV_STRATEGY = [
  { label: 'Prospect profile', href: '/dashboard/strategy/icp' },
  { label: 'Positioning', href: '/dashboard/strategy/positioning' },
  { label: 'Voice guide', href: '/dashboard/strategy/tov' },
  { label: 'Messaging', href: '/dashboard/strategy/messaging' },
]

const SETUP_STEPS = [
  { label: 'Complete intake' },
  { label: 'Documents generated' },
  { label: 'Integrations connected' },
  { label: 'Campaigns live' },
]

function getStepStatus(
  stepIndex: number,
  state: DashboardState
): 'done' | 'active' | 'pending' {
  if (state === 'intake_incomplete') {
    if (stepIndex === 0) return 'active'
    return 'pending'
  }
  if (state === 'strategy_in_review') {
    if (stepIndex === 0) return 'done'
    if (stepIndex === 1) return 'active'
    return 'pending'
  }
  // documents_active
  if (stepIndex <= 1) return 'done'
  if (stepIndex === 2) return 'active'
  return 'pending'
}

export function Sidebar({ orgName, pipelineUnlocked, dashboardState }: SidebarProps) {
  const pathname = usePathname()

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <aside className="w-[210px] min-h-screen bg-brand-green flex flex-col shrink-0">
      {/* Wordmark */}
      <div className="px-5 pt-6 pb-4">
        <span className="text-[#F5F0E8] text-[15px] font-medium tracking-[-0.01em]">
          MargenticOS
        </span>
      </div>

      {/* Viewing label + org name */}
      <div className="px-5 pb-5">
        <p className="text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-[3px]">
          Viewing
        </p>
        <p className="text-[#F5F0E8] text-[12px] font-medium leading-snug">
          {orgName || 'Your organisation'}
        </p>
      </div>

      <div className="mx-5 border-t border-[rgba(245,240,232,0.08)] mb-5" />

      {/* Navigation */}
      <nav className="flex-1 px-3 overflow-y-auto">
        {/* Results section */}
        <p className="px-2 mb-2 text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Results
        </p>
        <ul className="space-y-0.5 mb-6">
          {NAV_RESULTS.map((item) => {
            const active = isActive(item.href)
            const locked = item.href === '/dashboard/pipeline' && !pipelineUnlocked

            return (
              <li key={item.href}>
                <Link
                  href={locked ? '#' : item.href}
                  aria-disabled={locked}
                  className={[
                    'flex items-center justify-between px-2 py-[6px] rounded-[6px] text-[12px] transition-colors',
                    active
                      ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                      : locked
                      ? 'text-[rgba(245,240,232,0.28)] cursor-default pointer-events-none'
                      : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                  ].join(' ')}
                >
                  <span>{item.label}</span>
                  {locked && (
                    <span className="text-[9px] font-medium text-[rgba(245,240,232,0.28)] bg-[rgba(245,240,232,0.06)] px-1.5 py-0.5 rounded-[4px]">
                      Soon
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>

        {/* Strategy section */}
        <p className="px-2 mb-2 text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Strategy
        </p>
        <ul className="space-y-0.5">
          {NAV_STRATEGY.map((item) => {
            const active = isActive(item.href)
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={[
                    'flex items-center px-2 py-[6px] rounded-[6px] text-[12px] transition-colors',
                    active
                      ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                      : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                  ].join(' ')}
                >
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Setup progress steps — shown until pipeline unlocked */}
      {!pipelineUnlocked && (
        <div className="px-5 py-5 border-t border-[rgba(245,240,232,0.08)]">
          <p className="text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-3">
            Setup progress
          </p>
          <ol className="space-y-2.5">
            {SETUP_STEPS.map((step, i) => {
              const status = getStepStatus(i, dashboardState)
              return (
                <li key={i} className="flex items-center gap-2.5">
                  <span
                    className={[
                      'w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0',
                      status === 'done'
                        ? 'bg-brand-green-accent'
                        : status === 'active'
                        ? 'bg-[rgba(245,240,232,0.12)] ring-1 ring-[rgba(245,240,232,0.25)]'
                        : 'bg-[rgba(245,240,232,0.05)]',
                    ].join(' ')}
                  >
                    {status === 'done' ? (
                      <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                        <path d="M1 3L3 5L7 1" stroke="#1C3A2A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <span className={[
                        'text-[8px] font-medium',
                        status === 'active' ? 'text-[#F5F0E8]' : 'text-[rgba(245,240,232,0.28)]',
                      ].join(' ')}>
                        {i + 1}
                      </span>
                    )}
                  </span>
                  <span
                    className={[
                      'text-[11px]',
                      status === 'done'
                        ? 'text-[rgba(245,240,232,0.40)] line-through'
                        : status === 'active'
                        ? 'text-[#F5F0E8] font-medium'
                        : 'text-[rgba(245,240,232,0.28)]',
                    ].join(' ')}
                  >
                    {step.label}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </aside>
  )
}
