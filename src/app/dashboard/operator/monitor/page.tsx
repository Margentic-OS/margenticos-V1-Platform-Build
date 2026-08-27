'use client'

import { useEffect, useState } from 'react'
import { blindSpots } from '@/lib/monitor/blind-spots'
import { SendingDomainHealthPanel } from '@/components/dashboard/operator/SendingDomainHealthPanel'

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

interface Check {
  code: string
  title: string
  description: string
  category: string
  is_scheduled: boolean
  plain_meaning?: string
  plain_impact?: string
  plain_action?: string
}

interface Event {
  id: number
  check_code: string
  state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  created_at: string
  resolved_at: string | null
  acknowledged_at: string | null
  acknowledged_note: string | null
}

interface CheckState {
  check: Check
  current_state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  last_event_at: string | null
  resolved_at: string | null
  lastEvent: Event | undefined
}

export default function MonitorPage() {
  const [checks, setChecks] = useState<CheckState[]>([])
  const [recentEvents, setRecentEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acknowledgeModal, setAcknowledgeModal] = useState<{ checkCode: string; eventId: number } | null>(null)
  const [acknowledgeNote, setAcknowledgeNote] = useState('')
  const [acknowledging, setAcknowledging] = useState(false)
  const [acknowledgedProblemsExpanded, setAcknowledgedProblemsExpanded] = useState(false)
  const [blindSpotsExpanded, setBlindSpotsExpanded] = useState(false)

  useEffect(() => {
    const loadMonitorData = async () => {
      try {
        // Fetch via server route (uses service_role, bypasses RLS)
        const response = await fetch('/api/operator/monitor-data')
        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(errorData.error || `HTTP ${response.status}`)
        }

        const { checks: checksData, events: eventsData, recentEvents: recentEventsData } = await response.json()

        // Build map of check_code -> latest event
        const latestEventPerCheck = new Map<string, Event>()
        eventsData?.forEach((event: any) => {
          const typedEvent: Event = {
            id: event.id,
            check_code: event.check_code,
            state: event.state as 'PROBLEM' | 'OK' | 'UNKNOWN',
            detail: event.detail,
            created_at: event.created_at,
            resolved_at: event.resolved_at,
            acknowledged_at: event.acknowledged_at,
            acknowledged_note: event.acknowledged_note,
          }
          if (!latestEventPerCheck.has(typedEvent.check_code)) {
            latestEventPerCheck.set(typedEvent.check_code, typedEvent)
          }
        })

        // Combine checks with their latest events
        const checksWithState: CheckState[] = checksData?.map((check: any) => {
          const typedCheck: Check = {
            code: check.code,
            title: check.title,
            description: check.description,
            category: check.category,
            is_scheduled: check.is_scheduled,
            plain_meaning: check.plain_meaning,
            plain_impact: check.plain_impact,
            plain_action: check.plain_action,
          }
          const lastEvent = latestEventPerCheck.get(typedCheck.code)
          return {
            check: typedCheck,
            current_state: (lastEvent?.state ?? 'UNKNOWN') as 'PROBLEM' | 'OK' | 'UNKNOWN',
            detail: lastEvent?.detail ?? null,
            last_event_at: lastEvent?.created_at ?? null,
            resolved_at: lastEvent?.resolved_at ?? null,
            lastEvent,
          }
        }) ?? []

        setChecks(checksWithState)

        const typedRecent = (recentEventsData ?? []).map((e: any) => ({
          id: e.id,
          check_code: e.check_code,
          state: e.state as 'PROBLEM' | 'OK' | 'UNKNOWN',
          detail: e.detail,
          created_at: e.created_at,
          resolved_at: e.resolved_at,
          acknowledged_at: e.acknowledged_at,
          acknowledged_note: e.acknowledged_note,
        }))
        setRecentEvents(typedRecent)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Monitor data could not be loaded: Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadMonitorData()

    // Refresh every 30 seconds
    const interval = setInterval(loadMonitorData, 30000)
    return () => clearInterval(interval)
  }, [])

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
        // Reload data
        const dataResponse = await fetch('/api/operator/monitor-data')
        if (dataResponse.ok) {
          const { checks: checksData, events: eventsData, recentEvents: recentEventsData } = await dataResponse.json()
          const latestEventPerCheck = new Map<string, Event>()
          eventsData?.forEach((event: any) => {
            const typedEvent: Event = {
              id: event.id,
              check_code: event.check_code,
              state: event.state as 'PROBLEM' | 'OK' | 'UNKNOWN',
              detail: event.detail,
              created_at: event.created_at,
              resolved_at: event.resolved_at,
              acknowledged_at: event.acknowledged_at,
              acknowledged_note: event.acknowledged_note,
            }
            if (!latestEventPerCheck.has(typedEvent.check_code)) {
              latestEventPerCheck.set(typedEvent.check_code, typedEvent)
            }
          })
          const checksWithState: CheckState[] = checksData?.map((check: any) => {
            const typedCheck: Check = {
              code: check.code,
              title: check.title,
              description: check.description,
              category: check.category,
              is_scheduled: check.is_scheduled,
              plain_meaning: check.plain_meaning,
              plain_impact: check.plain_impact,
              plain_action: check.plain_action,
            }
            const lastEvent = latestEventPerCheck.get(typedCheck.code)
            return {
              check: typedCheck,
              current_state: (lastEvent?.state ?? 'UNKNOWN') as 'PROBLEM' | 'OK' | 'UNKNOWN',
              detail: lastEvent?.detail ?? null,
              last_event_at: lastEvent?.created_at ?? null,
              resolved_at: lastEvent?.resolved_at ?? null,
              lastEvent,
            }
          }) ?? []
          setChecks(checksWithState)
        }
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

  const livenessChecks = checks.filter(c => c.check.category === 'liveness')
  const tier1Checks = checks.filter(c => c.check.category === 'tier1')
  const unscheduledChecks = checks.filter(c => c.check.category === 'unscheduled')
  const allProblems = checks.filter(c => c.current_state === 'PROBLEM' && c.resolved_at === null)
  const activeProblemChecks = allProblems.filter(c => !c.lastEvent?.acknowledged_at)
  const acknowledgedProblemChecks = allProblems.filter(c => c.lastEvent?.acknowledged_at)

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

  return (
    <div className="p-8 max-w-7xl">
      <h1 className="text-3xl font-bold mb-2">Monitor Dashboard</h1>
      <p className="text-gray-600 mb-8">Real-time system health monitoring</p>

      {activeProblemChecks.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
          <h2 className="font-bold text-red-900 mb-4">Active Problems ({activeProblemChecks.length})</h2>
          <div className="space-y-4">
            {activeProblemChecks.map(c => (
              <div key={c.check.code} className="bg-white border border-red-200 rounded p-3">
                <div className="flex items-start justify-between mb-2">
                  <div className="font-bold text-red-900">{c.check.code}: {c.check.title}</div>
                  <button
                    onClick={() => setAcknowledgeModal({ checkCode: c.check.code, eventId: c.lastEvent?.id || 0 })}
                    className="px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                  >
                    Acknowledge
                  </button>
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
          </button>
          {acknowledgedProblemsExpanded && (
            <div className="space-y-3 mt-4">
              {acknowledgedProblemChecks.map(c => (
                <div key={c.check.code} className="bg-white border border-yellow-200 rounded p-3">
                  <div className="font-bold text-yellow-900 mb-1">{c.check.code}: {c.check.title}</div>
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
        {/* Liveness Checks */}
        <section>
          <h2 className="text-xl font-bold mb-4">Liveness Checks (Scheduled Crons)</h2>
          <div className="space-y-3">
            {livenessChecks.map(check => (
              <div key={check.check.code} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold">{check.check.code}: {check.check.title}</h3>
                      {getStatusBadge(check.current_state)}
                    </div>
                    <p className="text-sm text-gray-600 mb-2">{check.check.description}</p>
                    {check.detail && <p className="text-sm text-gray-700">{check.detail}</p>}
                  </div>
                  <div className="text-right">
                    {check.last_event_at && (
                      <div className="text-xs text-gray-500">
                        {formatDistanceToNow(new Date(check.last_event_at), { addSuffix: true })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Sending domain health — the detail behind MON-023 */}
        <section>
          <h2 className="text-xl font-bold mb-4">Sending Domain Health</h2>
          <SendingDomainHealthPanel />
        </section>

        {/* Tier 1 Checks */}
        {tier1Checks.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-4">Tier 1 Checks (Signal-Based)</h2>
            <div className="space-y-3">
              {tier1Checks.map(check => (
                <div key={check.check.code} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-bold">{check.check.code}: {check.check.title}</h3>
                        {getStatusBadge(check.current_state)}
                      </div>
                      <p className="text-sm text-gray-600 mb-2">{check.check.description}</p>
                      {check.detail && <p className="text-sm text-gray-700">{check.detail}</p>}
                    </div>
                    <div className="text-right">
                      {check.last_event_at && (
                        <div className="text-xs text-gray-500">
                          {formatDistanceToNow(new Date(check.last_event_at), { addSuffix: true })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Unscheduled Checks */}
        {unscheduledChecks.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-4">Unscheduled Checks ({unscheduledChecks.length})</h2>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-800 mb-4">
                These checks are not yet scheduled. They are listed here as reminders for future implementation.
              </p>
              <div className="space-y-3">
                {unscheduledChecks.map(check => (
                  <div key={check.check.code} className="border border-yellow-200 rounded p-3 bg-white">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-bold text-sm">{check.check.code}: {check.check.title}</h4>
                      {getStatusBadge(check.current_state)}
                    </div>
                    <p className="text-xs text-gray-600">{check.check.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

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
