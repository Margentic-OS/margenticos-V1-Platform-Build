'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import type { StrategyNavState } from '@/lib/dashboard/strategy-nav-state'
import { appendClientParam } from '@/lib/dashboard/client-param'
import { ClientSwitcher } from './ClientSwitcher'

export type DashboardState = 'intake_incomplete' | 'strategy_in_review' | 'documents_active'

interface SidebarProps {
  orgName: string
  pipelineUnlocked: boolean
  dashboardState: DashboardState
  pendingProspectsCount: number
  rosterProspectsCount?: number
  // True once a single email has actually gone out. The setup checklist below cannot be
  // derived from dashboardState alone: 'documents_active' is where a client sits both the
  // day their documents are approved and six weeks later with mail in the field, and the
  // checklist was telling the second client their campaigns were not live yet.
  outreachStarted: boolean
  // Whether the Strategy section starts collapsed, and why. Derived in
  // src/lib/dashboard/strategy-nav-state.ts. It is never collapsed while a document is
  // unapproved, because an unapproved document is what blocks the lead upload.
  strategyNav: StrategyNavState
  // Provided only when the layout knows the user is an operator. Used to
  // resolve the correct client name from ?client= (O-3) and to preserve
  // ?client= across nav links (O-4). Real clients receive an empty array.
  allOrgs?: { id: string; name: string }[]
}

// TODO: Restore Campaigns at T-10 days pre-launch when campaigns are provisioned
// TODO: Restore Approvals when the client-facing approvals page is built
//
// Replies sits first, above Pipeline. It is the only page here that shows a client
// something a person said to them, and it had no nav entry at all: the route existed, the
// chokepoint behind it existed and enforced both filters, and nothing anywhere linked to
// it. It was reachable only by typing the URL.
const NAV_RESULTS = [
  { label: 'Replies', href: '/dashboard/replies' },
  { label: 'Pipeline', href: '/dashboard/pipeline' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks' },
]

const NAV_STRATEGY = [
  { label: 'Prospect profile', href: '/dashboard/strategy/icp' },
  { label: 'Positioning', href: '/dashboard/strategy/positioning' },
  { label: 'Voice guide', href: '/dashboard/strategy/tov' },
  { label: 'Messaging', href: '/dashboard/strategy/messaging' },
]

const SETUP_STEPS = [
  { label: 'Complete intake' },
  { label: 'Documents ready' },
  { label: 'Integrations connected' },
  { label: 'Campaigns live' },
]

function getStepStatus(
  stepIndex: number,
  state: DashboardState,
  outreachStarted: boolean
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
  // documents_active.
  //
  // Emails in the field settle every step. Integrations cannot be unconnected and
  // campaigns cannot be un-live once mail has gone out, whatever the derived setup status
  // says, so all four read done. Without this the last step said "Campaigns live:
  // pending" while the client's sequence was running.
  if (outreachStarted) return 'done'
  if (stepIndex <= 1) return 'done'
  if (stepIndex === 2) return 'active'
  return 'pending'
}

export function Sidebar({ orgName, pipelineUnlocked, dashboardState, pendingProspectsCount, rosterProspectsCount, outreachStarted, strategyNav, allOrgs }: SidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // O-3: when an operator is viewing a client via ?client=, resolve the
  // client's name from the passed org list rather than the operator's own name.
  const clientId = allOrgs && allOrgs.length > 0 ? searchParams.get('client') : null

  // THE LAYOUT CANNOT SEE ?client=. A Next.js App Router layout gets `params` but never
  // `searchParams`, so the server-rendered counts above are computed for the viewer's own
  // organisation. That is correct for every real client, because resolveViewingOrg pins a
  // client to their own org whatever the URL says, and it is WRONG for an operator using
  // "View as client": the sidebar counted "MargenticOS (archived April 2026)" at 0 while
  // the page rendered "MargenticOS" at 103.
  //
  // So when, and only when, a client param is present, ask the route that CAN see it. The
  // route uses the same resolveViewingOrg the page uses, which is what stops the two
  // disagreeing. Failure leaves the server-rendered counts untouched.
  const [correctedCounts, setCorrectedCounts] = useState<
    { pendingProspectsCount: number; rosterProspectsCount: number } | null
  >(null)

  useEffect(() => {
    if (!clientId) {
      setCorrectedCounts(null)
      return
    }
    let cancelled = false
    fetch(`/api/dashboard/client/nav-counts?client=${encodeURIComponent(clientId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(json => {
        if (cancelled || !json || typeof json.rosterProspectsCount !== 'number') return
        setCorrectedCounts({
          pendingProspectsCount: json.pendingProspectsCount ?? 0,
          rosterProspectsCount: json.rosterProspectsCount ?? 0,
        })
      })
      .catch(() => {
        // Keep the server-rendered counts. A failed correction must not empty the nav.
      })
    return () => { cancelled = true }
  }, [clientId])

  const effectivePendingCount = correctedCounts?.pendingProspectsCount ?? pendingProspectsCount
  const effectiveRosterCount = correctedCounts?.rosterProspectsCount ?? rosterProspectsCount
  const resolvedOrgName = clientId
    ? (allOrgs?.find(o => o.id === clientId)?.name ?? orgName)
    : orgName

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  // ─── THE PERMANENT WAY BACK INTO INTAKE ─────────────────────────────────────
  //
  // The only link to /intake used to live inside IntakeIncompleteState, the overview card
  // shown while critical answers are still missing. It vanished the moment the client
  // crossed the completeness threshold, so a client who had finished intake could not reach
  // their own answers from anywhere in the product. The route worked the whole time and the
  // answers stayed editable; there was simply nothing to click.
  //
  // It lives in the sidebar because the sidebar is the only chrome rendered on EVERY client
  // route in EVERY dashboard state. Putting it back on the overview cards instead would mean
  // three copies of one link, one per state, and the next state added to DashboardState
  // would silently have none. This entry cannot go missing for a state, because it does not
  // read the state.
  //
  // THIS LINK DELIBERATELY DOES NOT CARRY ?client=.
  //
  // /intake resolves the CALLER's own organisation and ignores the query string entirely:
  // src/app/intake/page.tsx calls loadIntakeResponses and loadBuyerProfile, and both resolve
  // the organisation from auth.getUser() and that user's own row in `users`. Passing the
  // param through appendClientParam would therefore be worse than useless: an operator using
  // "View as client" would be shown THEIR OWN answers under the client's name, with an
  // editable form, which is the wrong-org failure mode that bites the operator and that no
  // client can reproduce. The operator already has a read-only view of a client's answers,
  // and that is the honest destination for them.
  const intakeHref = clientId
    ? `/dashboard/operator/clients/${clientId}/intake`
    : '/intake'

  // No active styling. /intake sits outside the (client) route group, so this sidebar is
  // never rendered while it is open and the highlight could not fire. Claiming otherwise
  // would be dead code that reads as a covered case.

  // A collapsed section must never hide the page the client is looking at, so being on a
  // strategy route forces it open regardless of the derived default.
  const onStrategyRoute = pathname.startsWith('/dashboard/strategy')
  const [strategyOpen, setStrategyOpen] = useState(
    !strategyNav.collapsedByDefault || onStrategyRoute
  )
  const strategyExpanded = strategyOpen || onStrategyRoute

  return (
    <aside className="w-[210px] min-h-screen bg-brand-green flex flex-col shrink-0 print:hidden">
      {/* Wordmark */}
      <div className="px-5 pt-6 pb-4">
        <Link href="/dashboard" className="text-[#F5F0E8] text-[15px] font-medium tracking-[-0.01em] hover:opacity-80 transition-opacity">
          MargenticOS
        </Link>
      </div>

      {/* Viewing label + org name */}
      <div className="px-5 pb-5">
        <p className="text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-[3px]">
          Viewing
        </p>
        {clientId && allOrgs && allOrgs.length > 0 ? (
          <ClientSwitcher
            clients={allOrgs}
            currentClientId={clientId}
            buttonClassName="text-[#F5F0E8] text-[12px] font-medium leading-snug hover:opacity-80 transition-opacity inline-flex items-center gap-1"
          />
        ) : (
          <p className="text-[#F5F0E8] text-[12px] font-medium leading-snug">
            {resolvedOrgName || 'Your organisation'}
          </p>
        )}
      </div>

      <div className="mx-5 border-t border-[rgba(245,240,232,0.08)] mb-5" />

      {/* Navigation */}
      <nav className="flex-1 px-3 overflow-y-auto">
        {/* Overview — exact-match only so /dashboard/strategy etc. don't activate it */}
        <ul className="space-y-0.5 mb-4">
          <li>
            <Link
              href={appendClientParam('/dashboard', clientId)}
              className={[
                'flex items-center px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
                pathname === '/dashboard'
                  ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                  : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
              ].join(' ')}
            >
              Overview
            </Link>
          </li>
          <li>
            <Link
              href={intakeHref}
              className="flex items-center px-2 py-[6px] rounded-[6px] text-[13px] transition-colors text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]"
            >
              Your answers
            </Link>
          </li>
        </ul>

        {/* Results section */}
        <p className="px-2 mb-2 text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Results
        </p>
        <ul className="space-y-0.5 mb-6">
          {NAV_RESULTS.map((item) => {
            const active = isActive(item.href)
            const locked = item.href === '/dashboard/pipeline' && !pipelineUnlocked

            return (
              <li key={item.href}>
                <Link
                  href={locked ? '#' : appendClientParam(item.href, clientId)}
                  aria-disabled={locked}
                  className={[
                    'flex items-center justify-between px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
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

        {/* Prospects section.
            THE ENTRY PERSISTS AFTER APPROVAL. It used to render only while something was
            pending, which combined with the page's own redirect to make the list of
            people being contacted unreachable the moment the client approved. The roster
            is a permanent record now, so the nav shows whenever there is a roster at all.
            See Decisions Log 2026-09-07, superseding the 2026-08-11 decision.
            rosterProspectsCount is optional so existing callers keep working; when it is
            not supplied the pending count alone decides, which is the old behaviour. */}
        {(effectiveRosterCount ?? effectivePendingCount) > 0 && (
          <>
            <p className="px-2 mb-2 text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
              Prospects
            </p>
            <ul className="space-y-0.5 mb-6">
              <li>
                <Link
                  href={appendClientParam('/dashboard/prospect-tiers', clientId)}
                  className={[
                    'flex items-center justify-between px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
                    pathname.startsWith('/dashboard/prospect-tiers')
                      ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                      : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                  ].join(' ')}
                >
                  <span>{effectivePendingCount > 0 ? 'Review prospects' : 'Your prospects'}</span>
                  {effectivePendingCount > 0 && (
                    <span className="text-[9px] font-medium text-[#F5F0E8] bg-brand-green-accent px-1.5 py-0.5 rounded-[4px]">
                      {effectivePendingCount}
                    </span>
                  )}
                </Link>
              </li>
            </ul>
          </>
        )}

        {/* Strategy section.
            Collapses only once all four documents are approved and nothing is pending.
            While a document is unapproved it stays open, because that is the state
            blocking the lead upload and hiding it behind a chevron would leave the client
            waiting on us while we wait on them. */}
        {/* The control collapsed correctly but did not look like a control: a 7px chevron
            at 28% opacity, inside what otherwise reads as a section label. The arrow is
            now 12px in its own contrasting hit area, and the whole row takes a hover
            background, so it is discoverable as a button rather than by accident. */}
        <button
          type="button"
          onClick={() => setStrategyOpen(o => !o)}
          aria-expanded={strategyExpanded}
          aria-controls="sidebar-strategy-nav"
          disabled={onStrategyRoute}
          className="group w-full flex items-center justify-between gap-2 px-2 py-1.5 mb-2 rounded-[6px] text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.45)] hover:text-[rgba(245,240,232,0.85)] hover:bg-[rgba(245,240,232,0.05)] transition-colors disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[rgba(245,240,232,0.45)]"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            Strategy
            {strategyNav.needsAttention.length > 0 && (
              <span className="text-[9px] font-medium text-[#F5F0E8] bg-brand-green-accent px-1.5 py-px rounded-[3px] normal-case tracking-normal shrink-0">
                {strategyNav.reason === 'blocking_upload' ? 'Not ready yet' : 'New version'}
              </span>
            )}
          </span>
          {!onStrategyRoute && (
            <span className="flex items-center justify-center w-5 h-5 rounded-[4px] bg-[rgba(245,240,232,0.07)] group-hover:bg-[rgba(245,240,232,0.14)] transition-colors shrink-0">
              <svg
                width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
                className={strategyExpanded ? 'rotate-90 transition-transform' : 'transition-transform'}
              >
                <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
        </button>
        {strategyExpanded && (
          <ul id="sidebar-strategy-nav" className="space-y-0.5">
            {NAV_STRATEGY.map((item) => {
              const active = isActive(item.href)
              const flagged = strategyNav.needsAttention.includes(item.label)
              return (
                <li key={item.href}>
                  <Link
                    href={appendClientParam(item.href, clientId)}
                    className={[
                      'flex items-center justify-between px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
                      active
                        ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                        : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                    ].join(' ')}
                  >
                    <span>{item.label}</span>
                    {flagged && <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </nav>

      {/* Setup progress steps — shown until pipeline unlocked */}
      {!pipelineUnlocked && (
        <div className="px-5 py-5 border-t border-[rgba(245,240,232,0.08)]">
          <p className="text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-3">
            Setup progress
          </p>
          <ol className="space-y-2.5">
            {SETUP_STEPS.map((step, i) => {
              const status = getStepStatus(i, dashboardState, outreachStarted)
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
