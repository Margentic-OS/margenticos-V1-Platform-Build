'use client'

// The operator's meeting board. Three sections, in the order a person needs them:
//
//   1. Due to bill unconfirmed   closest to its deadline first. Act now or it bills.
//   2. Awaiting an outcome       asked, or not yet asked, with plenty of time left.
//   3. Decided                   what is billable, and HOW it became billable.
//
// EVERY BILLABLE MEETING SHOWS ITS BASIS IN WORDS. "Confirmed by the client", "Marked by
// you", or "Billed unconfirmed at month end" are three different commercial facts and a
// client asking about an invoice is asking which one. A billable meeting with no basis is
// rendered as a fault in red rather than left blank: the database forbids it
// (meetings_billable_records_its_basis), so seeing one means something has gone wrong.

import { useState } from 'react'

export interface OutcomeRow {
  id: string
  organisationName: string
  prospectLabel: string | null
  unmatched: boolean
  meetingStatus: string
  decided: boolean
  decidedBy: string | null
  isBillable: boolean
  billableBasis: string | null
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  deadline: string | null
  daysLeft: number | null
  asked: boolean
  remindersSent: number
}

interface MeetingOutcomesBoardProps {
  rows: OutcomeRow[]
  warningDays: number
  truncated: boolean
}

const BASIS_IN_WORDS: Record<string, string> = {
  client_confirmed: 'Confirmed by the client',
  operator_marked: 'Marked by you',
  unconfirmed_backstop: 'Billed unconfirmed at month end',
}

const DECIDED_BY_IN_WORDS: Record<string, string> = {
  client: 'the client',
  operator: 'you',
  host: 'the host, in the booking tool',
  auto: 'the retired 72 hour job',
}

function formatDate(value: string | null): string {
  if (!value) return 'no date recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function MeetingOutcomesBoard({ rows, warningDays, truncated }: MeetingOutcomesBoardProps) {
  // Answers recorded in this session, so a row updates without a reload. Keyed by meeting.
  const [recorded, setRecorded] = useState<Record<string, { decision: string; message: string; ok: boolean }>>({})
  const [saving, setSaving] = useState<string | null>(null)

  async function record(meetingId: string, decision: 'held' | 'no_show') {
    setSaving(meetingId)
    try {
      const response = await fetch('/api/meetings/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ meeting_id: meetingId, decision }),
      })
      const body = await response.json()
      // The route says plainly whether it wrote anything. This screen repeats its answer
      // rather than assuming success from a 200, because "recorded" is the only field that
      // means the row actually changed.
      setRecorded(prev => ({
        ...prev,
        [meetingId]: { decision, message: String(body.message ?? 'No answer from the server.'), ok: body.recorded === true },
      }))
    } catch (error) {
      setRecorded(prev => ({
        ...prev,
        [meetingId]: {
          decision,
          message: `Nothing was recorded: ${error instanceof Error ? error.message : 'the request failed'}.`,
          ok: false,
        },
      }))
    } finally {
      setSaving(null)
    }
  }

  const undecided = rows.filter(row => !row.decided && !(row.id in recorded && recorded[row.id].ok))
  const dueToBill = undecided
    .filter(row => row.daysLeft !== null && row.daysLeft <= warningDays)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
  const awaiting = undecided.filter(row => !(row.daysLeft !== null && row.daysLeft <= warningDays))
  const settled = rows.filter(row => row.decided || (row.id in recorded && recorded[row.id].ok))

  function DecisionButtons({ row }: { row: OutcomeRow }) {
    const answer = recorded[row.id]
    if (answer) {
      return (
        <p className={`text-[12px] ${answer.ok ? 'text-brand-green-success' : 'text-red-700'}`}>
          {answer.message}
        </p>
      )
    }
    return (
      <div className="flex gap-2">
        <button
          onClick={() => record(row.id, 'held')}
          disabled={saving === row.id}
          className="px-3 py-1.5 rounded-[6px] text-[12px] font-medium bg-brand-green-operator text-[#F5F0E8] hover:opacity-90 disabled:opacity-50"
        >
          It happened
        </button>
        <button
          onClick={() => record(row.id, 'no_show')}
          disabled={saving === row.id}
          className="px-3 py-1.5 rounded-[6px] text-[12px] font-medium border border-[#E8E2D8] text-[#1A1916] hover:bg-[#F5F0E8] disabled:opacity-50"
        >
          It did not happen
        </button>
      </div>
    )
  }

  function Row({ row, showDeadline }: { row: OutcomeRow; showDeadline: boolean }) {
    return (
      <li className="border-b border-[#E8E2D8] py-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-[#1A1916]">
            {row.organisationName}
            {row.unmatched && (
              <span className="ml-2 text-[11px] font-medium text-brand-amber">
                no prospect matched, never billable
              </span>
            )}
          </p>
          <p className="text-[12px] text-[#6B6B6B]">
            {row.prospectLabel ?? 'prospect not identified'}. Met {formatDate(row.scheduledStartAt)}.
          </p>
          {showDeadline && (
            <p className="text-[12px] text-[#6B6B6B]">
              {row.asked
                ? `Asked, ${row.remindersSent} reminder(s) sent.`
                : 'NOT YET ASKED, so it will not bill unconfirmed.'}
              {row.daysLeft !== null && ` Bills unconfirmed after ${formatDate(row.deadline)}, ${row.daysLeft} day(s) left.`}
            </p>
          )}
        </div>
        <DecisionButtons row={row} />
      </li>
    )
  }

  return (
    <div className="px-7 py-6 flex flex-col gap-8">
      {truncated && (
        <p className="text-[12px] text-brand-amber">
          This screen shows the most recent meetings only, so the list below is not the whole
          set.
        </p>
      )}

      <section>
        <h2 className="text-[14px] font-medium text-[#1A1916] mb-1">
          Due to bill unconfirmed ({dueToBill.length})
        </h2>
        <p className="text-[12px] text-[#6B6B6B] mb-3">
          Within {warningDays} days of the deadline. If the client does not answer and nobody
          records an outcome, each of these bills unconfirmed, which is the term agreed on
          2026-08-24. There is still time to chase them.
        </p>
        {dueToBill.length === 0 ? (
          <p className="text-[12px] text-[#6B6B6B]">Nothing is close to its deadline.</p>
        ) : (
          <ul>{dueToBill.map(row => <Row key={row.id} row={row} showDeadline />)}</ul>
        )}
      </section>

      <section>
        <h2 className="text-[14px] font-medium text-[#1A1916] mb-1">
          Awaiting an outcome ({awaiting.length})
        </h2>
        <p className="text-[12px] text-[#6B6B6B] mb-3">
          Booked, undecided, and not yet near the deadline. You can record an outcome here at
          any time, and doing so takes the meeting out of reach of the monthly backstop.
        </p>
        {awaiting.length === 0 ? (
          <p className="text-[12px] text-[#6B6B6B]">No meetings are waiting.</p>
        ) : (
          <ul>{awaiting.map(row => <Row key={row.id} row={row} showDeadline />)}</ul>
        )}
      </section>

      <section>
        <h2 className="text-[14px] font-medium text-[#1A1916] mb-1">
          Decided ({settled.length})
        </h2>
        <p className="text-[12px] text-[#6B6B6B] mb-3">
          Every billable meeting shows how it became billable. A client asking about an
          invoice is asking exactly that.
        </p>
        {settled.length === 0 ? (
          <p className="text-[12px] text-[#6B6B6B]">Nothing decided yet.</p>
        ) : (
          <ul>
            {settled.map(row => {
              const answer = recorded[row.id]
              const status = answer?.ok ? answer.decision : row.meetingStatus
              const basis = answer?.ok
                ? (answer.decision === 'held' ? 'operator_marked' : null)
                : row.billableBasis
              const billable = answer?.ok ? answer.decision === 'held' : row.isBillable
              return (
                <li key={row.id} className="border-b border-[#E8E2D8] py-3">
                  <p className="text-[13px] font-medium text-[#1A1916]">{row.organisationName}</p>
                  <p className="text-[12px] text-[#6B6B6B]">
                    {row.prospectLabel ?? 'prospect not identified'}. Met {formatDate(row.scheduledStartAt)}.
                    {' '}Recorded as {status}
                    {row.decidedBy && ` by ${DECIDED_BY_IN_WORDS[row.decidedBy] ?? row.decidedBy}`}.
                  </p>
                  {billable ? (
                    basis && BASIS_IN_WORDS[basis] ? (
                      <p className="text-[12px] font-medium text-brand-green-success">
                        Billable. {BASIS_IN_WORDS[basis]}.
                      </p>
                    ) : (
                      <p className="text-[12px] font-medium text-red-700">
                        Billable with NO basis recorded. This should be impossible and needs
                        looking at.
                      </p>
                    )
                  ) : (
                    <p className="text-[12px] text-[#6B6B6B]">Not billable.</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
