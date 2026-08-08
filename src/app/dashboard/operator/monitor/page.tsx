'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

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
}

interface Event {
  id: number
  check_code: string
  state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  created_at: string
  resolved_at: string | null
}

interface CheckState {
  check: Check
  current_state: 'PROBLEM' | 'OK' | 'UNKNOWN'
  detail: string | null
  last_event_at: string | null
  resolved_at: string | null
}

export default function MonitorPage() {
  const supabase = createClient()
  const [checks, setChecks] = useState<CheckState[]>([])
  const [recentEvents, setRecentEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadMonitorData = async () => {
      try {
        // Fetch all monitor checks
        const { data: checksData, error: checksError } = await supabase
          .from('monitor_checks')
          .select('*')
          .order('code')

        if (checksError) throw checksError

        // Fetch latest event per check
        const { data: eventsData, error: eventsError } = await supabase
          .from('monitor_events')
          .select('*')
          .order('created_at', { ascending: false })

        if (eventsError) throw eventsError

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
          }
          const lastEvent = latestEventPerCheck.get(typedCheck.code)
          return {
            check: typedCheck,
            current_state: (lastEvent?.state ?? 'UNKNOWN') as 'PROBLEM' | 'OK' | 'UNKNOWN',
            detail: lastEvent?.detail ?? null,
            last_event_at: lastEvent?.created_at ?? null,
            resolved_at: lastEvent?.resolved_at ?? null,
          }
        }) ?? []

        setChecks(checksWithState)

        // Fetch recent events for audit trail (last 50)
        const { data: recent, error: recentError } = await supabase
          .from('monitor_events')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)

        if (recentError) throw recentError
        const typedRecent = (recent ?? []).map((e: any) => ({
          id: e.id,
          check_code: e.check_code,
          state: e.state as 'PROBLEM' | 'OK' | 'UNKNOWN',
          detail: e.detail,
          created_at: e.created_at,
          resolved_at: e.resolved_at,
        }))
        setRecentEvents(typedRecent)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadMonitorData()

    // Refresh every 30 seconds
    const interval = setInterval(loadMonitorData, 30000)
    return () => clearInterval(interval)
  }, [supabase])

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
  const blindSpots = checks.filter(c => c.check.category === 'unscheduled')
  const problemChecks = checks.filter(c => c.current_state === 'PROBLEM')

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

      {problemChecks.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
          <h2 className="font-bold text-red-900 mb-2">Active Problems ({problemChecks.length})</h2>
          <ul className="space-y-1">
            {problemChecks.map(c => (
              <li key={c.check.code} className="text-red-800 text-sm">
                <strong>{c.check.code}:</strong> {c.check.title}
                {c.detail && <span className="ml-2 text-red-700">— {c.detail}</span>}
              </li>
            ))}
          </ul>
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

        {/* Blind Spots */}
        {blindSpots.length > 0 && (
          <section>
            <h2 className="text-xl font-bold mb-4">Blind Spots (Unscheduled)</h2>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-800 mb-4">
                These checks are not yet scheduled. They are listed here as reminders for future implementation.
              </p>
              <div className="space-y-3">
                {blindSpots.map(check => (
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
    </div>
  )
}
