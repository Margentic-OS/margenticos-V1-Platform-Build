'use client'

// Per-domain sending health, on the operator monitor page.
//
// This is the screen the MON-023 alert sends you to. The monitor gives one word; this
// answers the question that follows it: which domain, how bad, and out of how many.
//
// THREE STATES PER DOMAIN, RENDERED DISTINCTLY. 'insufficient_sends' is not a pass and
// must never be coloured like one. A domain that has not sent enough for the rate rule to
// mean anything is shown in grey with the words "not enough sends", because a check that
// looks healthy when it had nothing to judge is the failure CLAUDE.md names.
//
// Numerator and denominator are always shown together. "3.4%" alone is unreadable when
// the denominator might be 29.

import { useEffect, useState } from 'react'

interface DomainRow {
  domain:         string
  sends:          number
  bounces:        number
  bounceRate:     number | null
  rateState:      'insufficient_sends' | 'within_threshold' | 'breach'
  absoluteBreach: boolean
  domainState:    'healthy' | 'insufficient_sends' | 'breach'
}

interface SendingHealthResponse {
  healthState: 'healthy' | 'insufficient_sends' | 'stale' | 'failing' | 'no_data'
  detail:      string
  windowStart: string | null
  windowEnd:   string | null
  computedAt:  string | null
  domains:     DomainRow[]
  thresholds: {
    windowDays: number
    absoluteBounces: number
    ratePercent: number
    minimumSends: number
  }
}

const HEADLINE: Record<SendingHealthResponse['healthState'], { label: string; className: string }> = {
  healthy:            { label: 'All domains within threshold', className: 'bg-green-100 text-green-800 border-green-300' },
  insufficient_sends: { label: 'Not enough sends to judge yet',  className: 'bg-gray-100 text-gray-700 border-gray-300' },
  stale:              { label: 'Figures are stale',              className: 'bg-orange-100 text-orange-900 border-orange-300' },
  failing:            { label: 'A domain is over threshold',     className: 'bg-red-100 text-red-800 border-red-300' },
  no_data:            { label: 'No data yet',                    className: 'bg-gray-100 text-gray-700 border-gray-300' },
}

function domainBadge(row: DomainRow) {
  if (row.domainState === 'breach') {
    return <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-800">Over threshold</span>
  }
  if (row.domainState === 'insufficient_sends') {
    // Grey, and it says so in words. Never green.
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">Not enough sends</span>
  }
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Within threshold</span>
}

export function SendingDomainHealthPanel() {
  const [data, setData] = useState<SendingHealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/operator/sending-health')
      .then(async r => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`)
        return r.json() as Promise<SendingHealthResponse>
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(String(e.message ?? e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <p className="text-sm text-gray-500">Loading sending domain health...</p>
  }
  if (error || !data) {
    return <p className="text-sm text-red-700">Could not load sending domain health: {error}</p>
  }

  const headline = HEADLINE[data.healthState]
  const t = data.thresholds

  return (
    <div className="space-y-4">
      <div className={`border rounded-lg p-4 ${headline.className}`}>
        <p className="font-bold text-sm">{headline.label}</p>
        <p className="text-sm mt-1">{data.detail}</p>
      </div>

      <p className="text-xs text-gray-600">
        Our five sending domains over the last {t.windowDays} days
        {data.windowStart && data.windowEnd ? ` (${data.windowStart} to ${data.windowEnd})` : ''}.
        A domain is flagged at {t.absoluteBounces} or more bounces at any rate, or above{' '}
        {t.ratePercent}% once it has sent at least {t.minimumSends}. Below {t.minimumSends} sends the
        percentage is not meaningful, so it is not applied and the domain reads
        &ldquo;not enough sends&rdquo; rather than passing.
      </p>

      {data.domains.length === 0 ? (
        <p className="text-sm text-gray-600">No sending data in this window yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Sending domain</th>
                <th className="text-right px-3 py-2 font-semibold">Sent</th>
                <th className="text-right px-3 py-2 font-semibold">Bounced</th>
                <th className="text-right px-3 py-2 font-semibold">Bounce rate</th>
                <th className="text-left px-3 py-2 font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {data.domains.map(row => (
                <tr key={row.domain} className="border-t border-gray-200">
                  <td className="px-3 py-2 font-medium">{row.domain}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.sends}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.bounces}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {/* Never a bare percentage: the denominator is what makes it readable. */}
                    {row.bounceRate === null
                      ? <span className="text-gray-400">no sends</span>
                      : <>{(row.bounceRate * 100).toFixed(1)}%{' '}
                          <span className="text-gray-500">({row.bounces}/{row.sends})</span></>}
                  </td>
                  <td className="px-3 py-2">{domainBadge(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.computedAt && (
        <p className="text-xs text-gray-500">
          Figures refreshed {new Date(data.computedAt).toLocaleString()}. Updated every 15 minutes;
          MON-023 reports them as stale if they stop.
        </p>
      )}
    </div>
  )
}
