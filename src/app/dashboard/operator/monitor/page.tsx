'use client'

import { useCallback, useEffect, useState } from 'react'
import { blindSpots } from '@/lib/monitor/blind-spots'
import { SendingDomainHealthPanel } from '@/components/dashboard/operator/SendingDomainHealthPanel'
import {
  buildCheckStates,
  categoriesInOrder,
  categoryTitle,
  type Check,
  type CheckState,
  type LiveReading,
  type MonitorEvent,
} from '@/lib/monitor/check-state'

function formatDistanceToNow(date: Date, options?: { addSuffix?: boolean }): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  let result = ''
  if (diffDays > 0) result = `${diffDays}d`
  else if (diffHours > 0) result = `${diffHours}h`
  else if (diffMins > 0) result = `${diffMins}m`
  else result = 'just now'

  if (options?.addSuffix && result !== 'just now') return `${result} ago`
  return result
}

export default function MonitorPage() {
  const [checks, setChecks] = useState<CheckState[]>([])
  const [recentEvents, setRecentEvents] = useState<MonitorEvent[]>([])
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acknowledgeModal, setAcknowledgeModal] = useState<{ checkCode: string; eventId: number } | null>(null)
  const [acknowledgeNote, setAcknowledgeNote] = useState('')
  const [acknowledging, setAcknowledging] = useState(false)
  const [acknowledgedProblemsExpanded, setAcknowledgedProblemsExpanded] = useState(false)
  const [blindSpotsExpanded, setBlindSpotsExpanded] = useState(false)

  // One loader, used by the initial mount, the 30s refresh, and both
  // acknowledgement actions. It was duplicated inline before; two copies of the
  // same mapping is how a board tells the truth until you interact with it.
  const loadMonitorData = useCallback(async () => {
    // Fetch via server route (uses service_role, bypasses RLS)
    const response = await fetch('/api/operator/monitor-data')
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || `HTTP ${response.status}`)
    }

    const {
      checks: checksData,
      events: eventsData,
      recentEvents: recentEventsData,
      live,
      liveErrors,
      checkedAt: checkedAtData,
    } = await response.json()

    setChecks(
      buildCheckStates(
        (checksData ?? []) as Check[],
        (eventsData ?? []) as MonitorEvent[],
        (live ?? {}) as Record<string, LiveReading>,
        (liveErrors ?? {}) as Record<string, string>,
      )
    )
    setRecentEvents((recentEventsData ?? []) as MonitorEvent[])
    setCheckedAt(checkedAtData ?? null)
  }, [])

  useEffect(() => {
    const run = async () => {
      try {
        await loadMonitorData()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Monitor data could not be loaded: Unknown error')
      } finally {
        setLoading(false)
      }
    }

    run()

    // Refresh every 30 seconds
    const interval = setInterval(run, 30000)
    return () => clearInterval(interval)
  }, [loadMonitorData])

  const handleAcknowledge = async () => {
    if (!acknowledgeModal) return
    setAcknowledging(true)
    try {
      const response = await fetch('/api/operator/monitor-acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: acknowledgeModal.eventId,
          note: acknowledgeNote || null,
        }),
      })
      if (response.ok) {
        setAcknowledgeModal(null)
        setAcknowledgeNote('')
        await loadMonitorData()
      } else {
        const errorData = await response.json()
        alert(`Failed to acknowledge: ${errorData.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setAcknowledging(false)
    }
  }

  const handleUnacknowledge = async (eventId: number) => {
    try {
      const response = await fetch('/api/operator/monitor-unacknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eventId }),
      })
      if (response.ok) {
        await loadMonitorData()
      } else {
        const errorData = await response.json()
        alert(`Failed to un-acknowledge: ${errorData.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  if (loading) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Monitor Dashboard</h1>
        <div className="text-gray-500">Loading monitors...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Monitor Dashboard</h1>
        <div className="bg-red-50 text-red-700 p-4 rounded border border-red-200">
          Error loading monitors: {error}
        </div>
      </div>
    )
  }

  const allProblems = checks.filter(c => c.current_state === 'PROBLEM')
  const activeProblemChecks = allProblems.filter(c => !c.is_acknowledged)
  const acknowledgedProblemChecks = allProblems.filter(c => c.is_acknowledged)
  const staleChecks = checks.filter(c => !c.from_live && c.live_error !== null)
  const sections = categoriesInOrder(checks)

  const getStatusBadge = (state: string) => {
    if (state === 'PROBLEM')
      return (
        <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 px-2 py-1 rounded text-sm font-medium">
          ● PROBLEM
        </span>
      )
    if (state === 'OK')
      return (
        <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 px-2 py-1 rounded text-sm font-medium">
          ● OK
        </span>
      )
    return (
      <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 px-2 py-1 rounded text-sm font-medium">
        ● UNKNOWN
      </span>
    )
  }

  // What the timestamp on a card actually means. Views that track a cron expose
  // last_run; views computed entirely at read time do not, and for those the
  // honest answer is when we read them, not when a row was last written.
  const renderTimestamp = (check: CheckState) => {
    if (!check.from_live) {
      return (
        <div className="text-xs text-red-600 font-semibold">
          live read failed
          {check.lastEvent && (
            <div className="font-normal text-gray-500">
              showing state from {formatDistanceToNow(new Date(check.lastEvent.created_at), { addSuffix: true })}
            </div>
          )}
        </div>
      )
    }
    if (check.last_run) {
      return (
        <div className="text-xs text-gray-500">
          last run {formatDistanceToNow(new Date(check.last_run), { addSuffix: true })}
        </div>
      )
    }
    return (
      <div className="text-xs text-gray-500">
        checked {checkedAt ? formatDistanceToNow(new Date(checkedAt), { addSuffix: true }) : 'just now'}
      </div>
    )
  }

  const renderCheckCard = (check: CheckState, compact = false) => (
    <div
      key={check.check.code}
      className={
        compact
          ? 'border border-yellow-200 rounded p-3 bg-white'
          : 'border border-gray-200 rounded-lg p-4'
      }
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className={compact ? 'font-bold text-sm' : 'font-bold'}>
              {check.check.code}: {check.check.title}
            </h3>
            {getStatusBadge(check.current_state)}
          </div>
          <p className="text-sm text-gray-600 mb-2">{check.check.description}</p>
          {check.detail && <p className="text-sm text-gray-700">{check.detail}</p>}
          {check.live_error && (
            <p className="text-xs text-red-600 mt-2">
              Live view could not be read: {check.live_error}
            </p>
          )}
        </div>
        <div className="text-right ml-4 shrink-0">{renderTimestamp(check)}</div>
      </div>
    </div>
  )

  return (
    <div className="p-8 max-w-7xl">
      <h1 className="text-3xl font-bold mb-2">Monitor Dashboard</h1>
      <p className="text-gray-600 mb-8">
        Live system health. State and detail are read from the monitor views on every refresh.
      </p>

      {staleChecks.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-8">
          <h2 className="font-bold text-orange-900 mb-2">
            {staleChecks.length} monitor(s) could not be read live
          </h2>
          <p className="text-sm text-orange-800">
            These are showing their last recorded state, which may be old. This banner exists so a
            failed read can never look like a healthy one.
          </p>
          <ul className="mt-2 space-y-1">
            {staleChecks.map(c => (
              <li key={c.check.code} className="text-xs text-orange-900 font-mono">
                {c.check.code}: {c.live_error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeProblemChecks.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
          <h2 className="font-bold text-red-900 mb-4">Active Problems ({activeProblemChecks.length})</h2>
          <div className="space-y-4">
            {activeProblemChecks.map(c => (
              <div key={c.check.code} className="bg-white border border-red-200 rounded p-3">
                <div className="flex items-start justify-between mb-2">
                  <div className="font-bold text-red-900">{c.check.code}: {c.check.title}</div>
                  {c.is_open_problem && c.lastEvent ? (
                    <button
                      onClick={() => setAcknowledgeModal({ checkCode: c.check.code, eventId: c.lastEvent!.id })}
                      className="px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                    >
                      Acknowledge
                    </button>
                  ) : (
                    // Live says PROBLEM but the sweep has not recorded a transition yet, so
                    // there is no row to acknowledge. Saying so beats a button that 404s.
                    <span className="text-xs text-red-700 italic">not yet recorded by the sweep</span>
                  )}
                </div>
                {c.check.plain_meaning && (
                  <div className="text-sm text-gray-700 mb-2">
                    <span className="font-semibold">What it means:</span> {c.check.plain_meaning}
                  </div>
                )}
                {c.check.plain_impact && (
                  <div className="text-sm text-red-700 mb-2">
                    <span className="font-semibold">Impact:</span> {c.check.plain_impact}
                  </div>
                )}
                {c.check.plain_action && (
                  <div className="text-sm text-red-800 mb-2">
                    <span className="font-semibold">Action:</span> {c.check.plain_action}
                  </div>
                )}
                {c.detail && <div className="text-xs text-gray-600 mt-2 italic">Detail: {c.detail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {acknowledgedProblemChecks.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-8">
          <button
            onClick={() => setAcknowledgedProblemsExpanded(!acknowledgedProblemsExpanded)}
            className="font-bold text-yellow-900 mb-4 cursor-pointer hover:text-yellow-800"
          >
            {acknowledgedProblemsExpanded ? '▼' : '▶'} Acknowledged Problems ({acknowledgedProblemChecks.length})
            {acknowledgedProblemChecks.some(c => c.detail_changed_since_ack) && (
              <span className="ml-2 bg-orange-200 text-orange-900 px-2 py-0.5 rounded text-xs">
                {acknowledgedProblemChecks.filter(c => c.detail_changed_since_ack).length} changed since acknowledged
              </span>
            )}
          </button>
          {acknowledgedProblemsExpanded && (
            <div className="space-y-3 mt-4">
              {acknowledgedProblemChecks.map(c => (
                <div key={c.check.code} className="bg-white border border-yellow-200 rounded p-3">
                  <div className="flex items-start justify-between mb-1">
                    <div className="font-bold text-yellow-900">{c.check.code}: {c.check.title}</div>
                    {c.lastEvent && (
                      <button
                        onClick={() => handleUnacknowledge(c.lastEvent!.id)}
                        className="px-2 py-1 border border-yellow-600 text-yellow-800 text-xs rounded hover:bg-yellow-100"
                      >
                        Un-acknowledge
                      </button>
                    )}
                  </div>

                  {/* The MON-011 case, made visible. Acknowledged against one reading,
                      the live reading has since moved, and no new row was written
                      because the state never left PROBLEM. */}
                  {c.detail_changed_since_ack && (
                    <div className="bg-orange-50 border border-orange-300 rounded p-2 my-2">
                      <div className="text-xs font-bold text-orange-900 mb-1">
                        Changed since acknowledged
                      </div>
                      <div className="text-xs text-gray-700">
                        <span className="font-semibold">Now:</span> {c.detail}
                      </div>
                      <div className="text-xs text-gray-500">
                        <span className="font-semibold">When acknowledged:</span>{' '}
                        {c.lastEvent?.detail ?? '—'}
                      </div>
                    </div>
                  )}

                  {!c.detail_changed_since_ack && c.detail && (
                    <div className="text-xs text-gray-600 mb-2 italic">Detail: {c.detail}</div>
                  )}

                  {c.lastEvent?.acknowledged_note && (
                    <div className="text-sm text-gray-700 mb-2">
                      <span className="font-semibold">Note:</span> {c.lastEvent.acknowledged_note}
                    </div>
                  )}
                  {c.lastEvent?.acknowledged_at && (
                    <div className="text-xs text-gray-500">
                      Acknowledged {formatDistanceToNow(new Date(c.lastEvent.acknowledged_at), { addSuffix: true })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-8">
        {/*
          Sections are DERIVED from the categories present in monitor_checks, not
          hardcoded. Three names were hardcoded here and monitor_checks held five,
          so seven monitors rendered nowhere, the privilege audit and the
          suppression audit among them.
        */}
        {sections.map(category => {
          const inCategory = checks.filter(c => c.check.category === category)
          if (inCategory.length === 0) return null

          if (category === 'unscheduled') {
            return (
              <section key={category}>
                <h2 className="text-xl font-bold mb-4">
                  {categoryTitle(category)} ({inCategory.length})
                </h2>
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-sm text-yellow-800 mb-4">
                    These checks are not yet scheduled. They are listed here as reminders for future implementation.
                  </p>
                  <div className="space-y-3">
                    {inCategory.map(check => renderCheckCard(check, true))}
                  </div>
                </div>
              </section>
            )
          }

          return (
            <section key={category}>
              <h2 className="text-xl font-bold mb-4">
                {categoryTitle(category)} ({inCategory.length})
              </h2>
              <div className="space-y-3">
                {inCategory.map(check => renderCheckCard(check))}
              </div>
            </section>
          )
        })}

        {/* Sending domain health — the detail behind MON-023 */}
        <section>
          <h2 className="text-xl font-bold mb-4">Sending Domain Health</h2>
          <SendingDomainHealthPanel />
        </section>

        {/* What This Monitor Cannot See */}
        <section>
          <button
            onClick={() => setBlindSpotsExpanded(!blindSpotsExpanded)}
            className="w-full text-left"
          >
            <h2 className="text-xl font-bold mb-4 cursor-pointer hover:text-gray-700">
              {blindSpotsExpanded ? '▼' : '▶'} What This Monitor Cannot See
            </h2>
          </button>
          {blindSpotsExpanded && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 space-y-6">
              {/* Silent Error Paths */}
              <div>
                <h3 className="font-bold text-red-900 mb-3">
                  {blindSpots.silentErrorPaths.title}
                </h3>
                <p className="text-sm text-gray-700 mb-3">{blindSpots.silentErrorPaths.description}</p>
                <div className="space-y-2">
                  {blindSpots.silentErrorPaths.categories.map((cat, idx) => (
                    <div key={idx} className="bg-white border border-gray-200 rounded p-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h4 className="font-semibold text-sm text-gray-900">{cat.name}</h4>
                          <p className="text-xs text-gray-600 mt-1">Example: {cat.example}</p>
                        </div>
                        <span className="text-xs font-bold text-red-600 ml-2 shrink-0">{cat.count} known</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Deliverability */}
              <div>
                <h3 className="font-bold text-orange-900 mb-3">
                  {blindSpots.deliverability.title}
                </h3>
                <p className="text-sm text-gray-700 mb-3">{blindSpots.deliverability.description}</p>
                <ul className="space-y-2">
                  {blindSpots.deliverability.gaps.map((gap, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                      <span className="text-orange-600 font-bold">•</span>
                      <span>{gap}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Trends */}
              <div>
                <h3 className="font-bold text-amber-900 mb-3">
                  {blindSpots.trends.title}
                </h3>
                <p className="text-sm text-gray-700 mb-3">{blindSpots.trends.description}</p>
                <ul className="space-y-2">
                  {blindSpots.trends.examples.map((example, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                      <span className="text-amber-600 font-bold">•</span>
                      <span>{example}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Root Cause */}
              <div>
                <h3 className="font-bold text-blue-900 mb-3">
                  {blindSpots.rootCause.title}
                </h3>
                <p className="text-sm text-gray-700 mb-3">{blindSpots.rootCause.description}</p>
                <ul className="space-y-2">
                  {blindSpots.rootCause.examples.map((example, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                      <span className="text-blue-600 font-bold">•</span>
                      <span>{example}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Bottom note */}
              <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-900">
                <span className="font-semibold">When the monitor is green but something feels wrong:</span> Check Sentry logs, email delivery reports, campaign reply trends, enrichment data quality, and upstream API rate limits.
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Audit Trail */}
      <section className="mt-8">
        <h2 className="text-xl font-bold mb-4">Recent State Transitions (Audit Trail)</h2>
        <p className="text-sm text-gray-600 mb-4">
          Transitions only. A monitor holding the same state writes no row here, which is why the
          cards above read the views rather than this table.
        </p>
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 text-left font-bold">Check</th>
                <th className="px-4 py-2 text-left font-bold">State</th>
                <th className="px-4 py-2 text-left font-bold">Detail</th>
                <th className="px-4 py-2 text-left font-bold">When</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-2 text-gray-500">
                    No events yet
                  </td>
                </tr>
              ) : (
                recentEvents.map(event => (
                  <tr key={event.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono text-xs">{event.check_code}</td>
                    <td className="px-4 py-2">{getStatusBadge(event.state)}</td>
                    <td className="px-4 py-2 text-gray-700 text-xs">{event.detail || '—'}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">
                      {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Acknowledge Modal */}
      {acknowledgeModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold mb-4">Acknowledge Problem</h3>
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-2">Check: <span className="font-mono font-bold">{acknowledgeModal.checkCode}</span></p>
              <label className="block text-sm font-semibold mb-2">Note (optional)</label>
              <textarea
                value={acknowledgeNote}
                onChange={(e) => setAcknowledgeNote(e.target.value)}
                className="w-full border border-gray-300 rounded p-2 text-sm"
                rows={3}
                placeholder="E.g., 'pre-fix hang failures, resolved 7 Aug'"
              />
              <p className="text-xs text-gray-500 mt-2">
                This hides the check until you un-acknowledge it. If the problem gets worse, the
                board will show the new reading and mark it changed rather than staying silent.
              </p>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setAcknowledgeModal(null)
                  setAcknowledgeNote('')
                }}
                disabled={acknowledging}
                className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAcknowledge}
                disabled={acknowledging}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {acknowledging ? 'Acknowledging...' : 'Acknowledge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
