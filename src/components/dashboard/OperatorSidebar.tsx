'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect } from 'react'
import { appendClientParam } from '@/lib/dashboard/client-param'

// Where the last viewed client is remembered. Per-browser, not per-account: this is a
// convenience about where the operator was, not a permission or a preference, so it does
// not belong in the database and must never be treated as authoritative about access.
const LAST_CLIENT_KEY = 'margenticos.operator.lastClientId'

export interface ClientOrg {
  id: string
  name: string
  pipeline_unlocked: boolean
}

interface OperatorSidebarProps {
  clients: ClientOrg[]
}

// TODO: Restore Campaigns at T-10 days pre-launch when campaigns are provisioned
const NAV_RESULTS = [
  { label: 'Pipeline', href: '/dashboard/pipeline' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks' },
]

const NAV_STRATEGY = [
  { label: 'Prospect profile', href: '/dashboard/strategy/icp' },
  { label: 'Positioning', href: '/dashboard/strategy/positioning' },
  { label: 'Voice guide', href: '/dashboard/strategy/tov' },
  { label: 'Messaging', href: '/dashboard/strategy/messaging' },
]

// 'Reply queue' is a STATIC entry, not one of the per-client ones built below, because the
// triage queue is cross-organisation: GET /api/reply-drafts applies no organisation_id
// filter (ADR-021, operator endpoints are cross-org) and the page takes no client param.
// Putting it in the per-client list would have made it unreachable whenever no client was
// selected, which is the same class of bug as having no entry at all.
//
// It is SEPARATE from 'Replies' rather than replacing it. They are different screens:
// 'Replies' is per-client and read-only, and the triage queue is cross-client and is the
// only screen in the product with an approve button. Merging them would lose one or the
// other. The label matches the page's own <OperatorTopbar title>, so the nav and the page
// agree on what the thing is called.
//
// `perClient: true` marks an entry whose page reads ?client= and shows one organisation.
// Those carry the selected client through the link; the rest are cross-organisation and
// deliberately do not. Before this flag existed the distinction was implicit, and 'FAQs'
// is exactly the entry that would have got it wrong: its page header says
// "searchParams.client is the selected org ID — set by the sidebar client picker", and
// the sidebar had no such link, so a bare href would have silently shown whichever
// organisation the page defaults to.
const NAV_OPERATOR: { label: string; href: string; perClient?: boolean }[] = [
  { label: 'All clients', href: '/dashboard/operator' },
  { label: 'Monitor', href: '/dashboard/operator/monitor' },
  { label: 'Reply queue', href: '/dashboard/operator/triage' },
  { label: 'Sourcing review', href: '/dashboard/operator/sourcing-review' },
  { label: 'Approvals', href: '/dashboard/operator/approvals' },
  // ADDED 2026-09-12 with the meeting outcome lifecycle (ADR-057). Cross-organisation: the
  // screen shows every client's meetings awaiting an outcome and every one about to bill
  // unconfirmed, so it takes no client param. It is the only surface where a person can
  // record held or no-show, and the only place the reason a meeting became billable is
  // visible, so an unlinked version of it would leave the billing rule unoperable.
  { label: 'Meetings', href: '/dashboard/operator/meetings' },
  // ADDED 2026-09-09. The page has existed and been reachable only by typing the URL.
  // It is the ONLY surface for curating FAQs, and the FAQ store is empty across every live
  // organisation, so the screen that would fix that could not be found. Third instance of
  // this defect in one week after the triage queue and the client prospect list, which is
  // why operator-page-reachability.test.tsx now checks the whole directory rather than
  // one more page at a time.
  { label: 'FAQs', href: '/dashboard/operator/faqs', perClient: true },
  // RE-LINKED 2026-09-09, after establishing why they were unlinked. Both were added on
  // 2026-04-19 with their pages, and both were removed from this list on 2026-06-05 by
  // commit 1afeb94, whose message records: "remove four stub nav items (Reply queue, FAQ
  // curation, Agent activity, Signals log) — all four were 404ing."
  //
  // ALL FOUR PAGE FILES EXISTED AT THAT COMMIT, verified against the tree at 1afeb94. They
  // were not stubs and they were not missing. Four working pages were unlinked on a stated
  // reason that was not true, and the other two of the four were each reported as a fresh
  // defect months later. See the Knowledge Base entry.
  //
  // Both are cross-organisation: each reads its table across all clients and takes no client
  // param, so neither carries perClient.
  { label: 'Agent activity', href: '/dashboard/operator/activity' },
  { label: 'Signals log', href: '/dashboard/operator/signals' },
  // perClient ADDED 2026-09-10, with the rewrite that made this page read real records.
  // The page shows one organisation's settings and renders an explicit "No client
  // selected" state without ?client=, so without this flag the only way to reach a
  // populated Settings page was to hand-edit the URL.
  { label: 'Settings', href: '/dashboard/operator/settings', perClient: true },
]

function clientStatus(client: ClientOrg): 'active' | 'setup' {
  return client.pipeline_unlocked ? 'active' : 'setup'
}

export function OperatorSidebar({ clients }: OperatorSidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [badgeCount, setBadgeCount] = useState(0)
  const [replyQueueCount, setReplyQueueCount] = useState(0)
  const [rememberedClientId, setRememberedClientId] = useState<string | null>(null)

  useEffect(() => {
    const fetchBadgeCount = async () => {
      try {
        const response = await fetch('/api/operator/monitor-badge-count')
        if (response.ok) {
          const { count } = await response.json()
          setBadgeCount(count)
        }
      } catch (err) {
        // Silent fail — badge is not critical
      }
    }

    // The reply queue's own count. Read from the SAME endpoint the queue page polls, so the
    // badge and the page can never disagree about how many replies are waiting. A separate
    // count endpoint would be a second source of truth for one number.
    const fetchReplyQueueCount = async () => {
      try {
        const response = await fetch('/api/reply-drafts', { credentials: 'same-origin' })
        if (response.ok) {
          const { drafts } = await response.json()
          setReplyQueueCount(Array.isArray(drafts) ? drafts.length : 0)
        }
      } catch {
        // Silent fail — the badge is an aid, and its absence must not hide the nav entry.
      }
    }

    const refresh = () => { fetchBadgeCount(); fetchReplyQueueCount() }

    refresh()
    // Refresh badges every 30 seconds. One timer for both, so adding the reply count did
    // not add a second polling loop to every operator page.
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [])

  // ── Which client is selected ────────────────────────────────────────────────
  //
  // WHAT THIS REPLACED. `searchParams.get('client') ?? clients[0]?.id`. `clients[0]` is
  // whichever organisation sorts first, so arriving anywhere without ?client= landed the
  // operator on an alphabetical accident rather than where they were. With one live client
  // that is invisible; with three it means the sidebar routinely claims a client the
  // operator was not looking at, and every per-client nav link then points at that one.
  //
  // NOTHING CLIENT-SPECIFIC IN THE FALLBACK. When there is no ?client= and no history, the
  // selection is NULL, not "the first one". The picker already renders `'All clients'` for
  // null, so the neutral state was always representable; it was simply never reachable.
  // Guessing a client is worse than showing none, because a wrong guess looks like a
  // choice the operator made.
  //
  // THE REMEMBERED ID IS VALIDATED against the loaded list on every render rather than
  // trusted. An organisation can be archived or deleted between visits, and a stale id in
  // localStorage would otherwise select a client that no longer exists and render as if
  // nothing were selected while every per-client link carried the dead id.
  const rememberedIfStillValid =
    rememberedClientId && clients.some(c => c.id === rememberedClientId)
      ? rememberedClientId
      : null

  const selectedId = searchParams.get('client') ?? rememberedIfStillValid
  const selectedClient = clients.find(c => c.id === selectedId) ?? null

  // Replies had no nav entry anywhere. The route existed, the operator read behind it
  // existed, and nothing linked to it, so it was reachable only by typing a URL with an
  // organisation UUID in it. Every reply a client is not allowed to see (opt-outs,
  // out-of-office, unclear) was therefore invisible inside our own product to the person
  // running it. It takes the selected client in its path, so it is built here rather than
  // in the static list above.
  const navOperator = selectedId
    ? [
        NAV_OPERATOR[0],
        { label: 'Replies', href: `/dashboard/operator/clients/${selectedId}/replies` },  // id in the path, not the query
        ...NAV_OPERATOR.slice(1),
      ]
    : NAV_OPERATOR

  function isActive(href: string) {
    if (href === '/dashboard/operator') return pathname === '/dashboard/operator'
    return pathname.startsWith(href)
  }

  // Read the remembered client AFTER mount. Reading localStorage during render would
  // differ between the server pass and the client pass and produce a hydration mismatch;
  // this way the first paint is the neutral state and the remembered client arrives with
  // the first effect.
  useEffect(() => {
    try {
      setRememberedClientId(window.localStorage.getItem(LAST_CLIENT_KEY))
    } catch {
      // Private browsing or a blocked storage partition. The neutral state is a correct
      // fallback, so this failing costs a convenience and never a correctness.
    }
  }, [])

  // Remember whatever the URL says, not only what the picker sets. An operator who arrives
  // by a link carrying ?client= has just as clearly chosen that client, and without this
  // the memory would only ever record picker clicks.
  useEffect(() => {
    const fromUrl = searchParams.get('client')
    if (!fromUrl) return
    setRememberedClientId(fromUrl)
    try {
      window.localStorage.setItem(LAST_CLIENT_KEY, fromUrl)
    } catch {
      // See above.
    }
  }, [searchParams])

  function selectClient(id: string) {
    setDropdownOpen(false)
    setRememberedClientId(id)
    try {
      window.localStorage.setItem(LAST_CLIENT_KEY, id)
    } catch {
      // See above.
    }
    const params = new URLSearchParams(searchParams.toString())
    params.set('client', id)

    // On a client-scoped route the organisation is in the PATH, not in ?client=, so
    // setting the query param alone left the page showing the previous client while the
    // sidebar claimed the new one. Swap the id segment instead. Exposed by giving Replies
    // a nav entry: before that, no sidebar link reached a /clients/[id]/ route at all.
    const scoped = pathname.match(/^(\/dashboard\/operator\/clients\/)[^/]+(\/.*)?$/)
    const nextPath = scoped ? `${scoped[1]}${id}${scoped[2] ?? ''}` : pathname

    router.push(`${nextPath}?${params.toString()}`)
  }

  return (
    <aside className="w-[210px] min-h-screen bg-brand-green-operator flex flex-col shrink-0 print:hidden">
      {/* Wordmark */}
      <div className="px-5 pt-6 pb-4">
        <span className="text-[#F5F0E8] text-[15px] font-medium tracking-[-0.01em]">
          MargenticOS
        </span>
      </div>

      {/* Operator mode badge */}
      <div className="px-5 pb-4">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#FEF7E6] border border-[#F0D080]">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
          <span className="text-[10px] font-medium text-[#7A4800]">Operator mode</span>
        </div>
      </div>

      {/* Client selector */}
      <div className="px-5 pb-5 relative">
        <p className="text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-[4px]">
          Viewing
        </p>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          // The nav also contains an entry labelled 'All clients', so the picker's own
          // label is ambiguous by text alone. This names the control that reports WHICH
          // CLIENT IS SELECTED, which is the thing worth asserting on.
          data-testid="client-picker"
          className="w-full flex items-center justify-between text-left bg-[rgba(245,240,232,0.06)] hover:bg-[rgba(245,240,232,0.09)] border border-[rgba(245,240,232,0.10)] rounded-[6px] px-2.5 py-1.5 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-green-accent shrink-0" />
            <span className="text-[12px] font-medium text-[#F5F0E8] truncate">
              {selectedClient?.name ?? 'All clients'}
            </span>
          </div>
          <svg
            width="10" height="6" viewBox="0 0 10 6" fill="none"
            className={`shrink-0 ml-1.5 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
          >
            <path
              d="M1 1L5 5L9 1"
              stroke="rgba(245,240,232,0.40)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {dropdownOpen && clients.length > 0 && (
          <div className="absolute left-5 right-5 top-full z-50 mt-1 bg-[#223322] border border-[rgba(245,240,232,0.10)] rounded-[8px] shadow-lg overflow-hidden">
            {clients.map((client) => (
              <button
                key={client.id}
                onClick={() => selectClient(client.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[rgba(245,240,232,0.06)] transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  client.id === selectedClient?.id
                    ? 'bg-brand-green-accent'
                    : 'bg-[rgba(245,240,232,0.20)]'
                }`} />
                <span className={`text-[12px] truncate ${
                  client.id === selectedClient?.id
                    ? 'text-[#F5F0E8] font-medium'
                    : 'text-[rgba(245,240,232,0.60)]'
                }`}>
                  {client.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mx-5 border-t border-[rgba(245,240,232,0.08)] mb-5" />

      {/* Navigation */}
      <nav className="flex-1 px-3 overflow-y-auto">
        {/* Results */}
        <p className="px-2 mb-2 text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Results
        </p>
        <ul className="space-y-0.5 mb-6">
          {NAV_RESULTS.map((item) => (
            <li key={item.href}>
              <Link
                href={appendClientParam(item.href, selectedId)}
                className={[
                  'flex items-center px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                    : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Strategy */}
        <p className="px-2 mb-2 text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Strategy
        </p>
        <ul className="space-y-0.5 mb-6">
          {NAV_STRATEGY.map((item) => (
            <li key={item.href}>
              <Link
                href={appendClientParam(item.href, selectedId)}
                className={[
                  'flex items-center px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                    : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Operator only — amber-tinted to visually distinguish from client nav */}
        <p className="px-2 mb-2 text-[10px] font-normal uppercase tracking-[0.09em] text-brand-amber opacity-60">
          Operator only
        </p>
        <ul className="space-y-0.5">
          {navOperator.map((item) => (
            <li key={item.href}>
              <Link
                href={item.perClient ? appendClientParam(item.href, selectedId) : item.href}
                className={[
                  'flex items-center justify-between px-2 py-[6px] rounded-[6px] text-[13px] transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(239,159,39,0.10)] border-l-2 border-brand-amber text-brand-amber font-medium'
                    : 'text-brand-amber opacity-60 hover:opacity-100 hover:bg-[rgba(239,159,39,0.07)]',
                ].join(' ')}
              >
                <span>{item.label}</span>
                {item.href === '/dashboard/operator/monitor' && badgeCount > 0 && (
                  <span className="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold text-white bg-red-600 rounded-full">
                    {badgeCount > 99 ? '99+' : badgeCount}
                  </span>
                )}
                {item.href === '/dashboard/operator/triage' && replyQueueCount > 0 && (
                  <span className="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold text-white bg-red-600 rounded-full">
                    {replyQueueCount > 99 ? '99+' : replyQueueCount}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Compact client list */}
      <div className="px-5 py-5 border-t border-[rgba(245,240,232,0.08)]">
        <p className="text-[10px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-3">
          All clients
        </p>
        {clients.length === 0 ? (
          <p className="text-[11px] text-[rgba(245,240,232,0.28)] leading-relaxed">
            No clients yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {clients.slice(0, 5).map((client) => {
              const status = clientStatus(client)
              return (
                <li key={client.id}>
                  <button
                    onClick={() => selectClient(client.id)}
                    className="w-full flex items-center gap-2 text-left hover:bg-[rgba(245,240,232,0.04)] rounded-[4px] px-1 py-0.5 transition-colors"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      status === 'active'
                        ? 'bg-brand-green-success'
                        : 'bg-[rgba(245,240,232,0.28)]'
                    }`} />
                    <span className="text-[11px] text-[rgba(245,240,232,0.60)] truncate flex-1">
                      {client.name}
                    </span>
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] shrink-0 ${
                      status === 'active'
                        ? 'text-brand-green-success bg-[rgba(59,109,17,0.15)]'
                        : 'text-[rgba(245,240,232,0.40)] bg-[rgba(245,240,232,0.06)]'
                    }`}>
                      {status === 'active' ? 'Live' : 'Setup'}
                    </span>
                  </button>
                </li>
              )
            })}
            {clients.length > 5 && (
              <li className="text-[10px] text-[rgba(245,240,232,0.28)] px-1">
                +{clients.length - 5} more
              </li>
            )}
          </ul>
        )}
      </div>
    </aside>
  )
}
