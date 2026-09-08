'use client'

// THE CONTROL THAT DID NOT EXIST.
//
// Before this, stopping a prospect who was already being emailed meant opening the sending
// vendor's own UI and clicking there. That worked, and it left no record in this product of
// who did it or why, which is how three rows came to hold a decision with no reason attached
// and no rule behind them.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE REASON IS A REQUIRED INPUT AND NOT AN OPTIONAL NOTE
//
// An optional field would be left empty, and an empty reason is exactly the state that makes
// a hold indistinguishable from a bug months later. The route refuses a blank reason and so
// does the module underneath it; this component simply does not offer a way to submit one.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT REPORTS THE TWO HALVES SEPARATELY
//
// A stop is a database write plus a call to the sending provider, and they can disagree. The
// write is what blocks the person and puts them in front of the reconciliation monitor; the
// provider call is what stops the sequence already in flight.
//
// If the provider call fails, THE STOP STILL HAPPENED and must not be presented as a failure,
// or an operator retries something already correct. It is shown as stopped, with a plain note
// that the sending tool has not confirmed yet and that the monitor is watching. That is the
// truth, and it is more useful than a red error.

import { useState } from 'react'

type Phase = 'idle' | 'asking' | 'working' | 'stopped' | 'error'

interface StopProspectControlProps {
  prospectId: string
  /** Already stopped, from prospects.suppressed. Renders as state, never as a button. */
  alreadyStopped: boolean
}

export function StopProspectControl({ prospectId, alreadyStopped }: StopProspectControlProps) {
  const [phase, setPhase] = useState<Phase>(alreadyStopped ? 'stopped' : 'idle')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  async function submit() {
    setPhase('working')
    setMessage(null)
    try {
      const response = await fetch('/api/operator/prospects/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospect_id: prospectId, reason }),
      })
      const body = await response.json()

      if (!response.ok) {
        setPhase('error')
        setMessage(body.error ?? 'The stop was not recorded.')
        return
      }

      setPhase('stopped')
      // carry_status is the provider half. 'confirmed' means the lead was read back carrying
      // the value we wrote; 'not_required' means there was no lead to stop, because this
      // person was never uploaded.
      setMessage(
        body.carry_status === 'failed'
          ? 'Stopped here. The sending tool has not confirmed yet, and the reconciliation check is watching it.'
          : null
      )
    } catch {
      setPhase('error')
      setMessage('The stop could not be sent.')
    }
  }

  if (phase === 'stopped') {
    return (
      <div className="text-xs">
        <span className="inline-block px-2 py-0.5 rounded-sm font-medium bg-[#F4E7E7] text-[#8B2020] border border-[#DDBDBD]">
          Stopped
        </span>
        {message && <div className="mt-1 text-text-secondary max-w-[200px]">{message}</div>}
      </div>
    )
  }

  if (phase === 'asking' || phase === 'working' || phase === 'error') {
    return (
      <div className="text-xs space-y-1 max-w-[200px]">
        <input
          type="text"
          value={reason}
          onChange={event => setReason(event.target.value)}
          placeholder="Why are we stopping?"
          disabled={phase === 'working'}
          className="w-full px-2 py-1 border border-[#DDD8D0] rounded-sm text-xs"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            // The guard that makes the reason genuinely required rather than nominally so.
            disabled={phase === 'working' || reason.trim().length === 0}
            className="px-2 py-1 rounded-sm font-medium bg-[#8B2020] text-white disabled:opacity-40"
          >
            {phase === 'working' ? 'Stopping...' : 'Confirm stop'}
          </button>
          <button
            type="button"
            onClick={() => { setPhase('idle'); setReason(''); setMessage(null) }}
            disabled={phase === 'working'}
            className="px-2 py-1 rounded-sm text-text-secondary"
          >
            Cancel
          </button>
        </div>
        {phase === 'error' && message && <div className="text-[#8B2020]">{message}</div>}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setPhase('asking')}
      className="text-xs font-medium text-[#8B2020] hover:underline"
    >
      Stop contacting
    </button>
  )
}
