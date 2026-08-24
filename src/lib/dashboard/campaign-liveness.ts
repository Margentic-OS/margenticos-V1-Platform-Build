// src/lib/dashboard/campaign-liveness.ts
//
// Turns stored campaign rows into the one sentence a client is allowed to read about
// whether their outreach is running.
//
// DETERMINISTIC. Pure function, no I/O, no LLM. It is threshold evaluation and a lookup
// table, which is exactly the kind of work ADR-018 says must not involve a model.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE EXISTS TO ENFORCE
//
// "Live" is never derived from campaigns.status. That column is INTENT: it says what
// somebody meant the campaign to do. A campaign at 'active' can be sending nothing at
// all. Liveness is read from sending_state, which comes from Instantly's sending-status
// endpoint where 'healthy' is the only unobstructed value.
//
// And a reading is only worth using while it is fresh. The poll runs every fifteen
// minutes. If the last successful check is over an hour old we have missed four ticks and
// we no longer know, so the answer becomes "not reported" rather than a stale "live".
// Not knowing is a state a client can be shown. Guessing is not.

export type LivenessVerdict = 'sending' | 'not_sending' | 'unknown'

export interface CampaignLiveness {
  verdict: LivenessVerdict
  // Client-facing. Never contains an Instantly status code or any vendor vocabulary.
  label: string
  // One plain sentence under the label, or null when the label says enough.
  detail: string | null
}

export interface LivenessInput {
  sending_state: string | null
  sending_status_checked_at: string | null
  external_id: string | null
}

// Four missed polls. Beyond this the stored reading stops counting as evidence.
export const LIVENESS_STALE_AFTER_MS = 60 * 60 * 1000

// Ordered most urgent first. When several campaigns are not sending for different
// reasons, the client is told about the one that matters most rather than an arbitrary
// one. 'blocked' outranks everything because nothing about it resolves on its own.
const REASON_PRIORITY = ['blocked', 'limit_reached', 'waiting', 'paused', 'draft', 'completed'] as const

// Client-facing copy per stored state. No Instantly strings reach this table: it is keyed
// on our own seven-value vocabulary, so a change to Instantly's enum cannot change what a
// client reads without going through the handler first.
const REASON_COPY: Record<string, { label: string; detail: string | null }> = {
  blocked: {
    label: 'Sending paused by the email provider',
    detail: 'Nothing is going out until this is cleared. We have been alerted and are on it.',
  },
  limit_reached: {
    label: 'Daily sending limit reached',
    detail: 'Today’s emails have all gone out. Sending picks up again tomorrow.',
  },
  waiting: {
    label: 'Waiting to send',
    detail: 'Either outside the sending window, or nobody is due an email right now.',
  },
  paused: {
    label: 'Paused',
    detail: 'Sending is stopped. It stays stopped until somebody restarts it.',
  },
  draft: {
    label: 'Not started',
    detail: 'The campaign is built but has not begun sending.',
  },
  completed: {
    label: 'Sequence finished',
    detail: 'Everyone on this list has had the full sequence.',
  },
}

/**
 * Derives what a client may be told about whether their outreach is running.
 *
 * @param campaigns rows for ONE organisation. The caller owns the org filter.
 * @param now       injected so the staleness rule is testable without faking clocks.
 */
export function deriveCampaignLiveness(
  campaigns: LivenessInput[],
  now: Date = new Date(),
): CampaignLiveness {
  // Only campaigns that exist in the sending tool can have a sending state at all.
  const registered = campaigns.filter(c => c.external_id !== null)

  if (registered.length === 0) {
    return {
      verdict: 'unknown',
      label: 'Not set up yet',
      detail: 'Your campaign has not been connected to the sending tool.',
    }
  }

  const fresh = registered.filter(c => {
    if (!c.sending_status_checked_at) return false
    const checked = new Date(c.sending_status_checked_at).getTime()
    if (Number.isNaN(checked)) return false
    return now.getTime() - checked <= LIVENESS_STALE_AFTER_MS
  })

  // Every reading is stale or missing. We genuinely do not know, so we say so. This is
  // the branch that stops a dashboard printing "live" off a reading from last Tuesday.
  if (fresh.length === 0) {
    return {
      verdict: 'unknown',
      label: 'Not reported',
      detail: 'We have not been able to confirm sending status recently.',
    }
  }

  // One campaign genuinely sending is enough for the client's answer to be yes.
  if (fresh.some(c => c.sending_state === 'sending')) {
    return { verdict: 'sending', label: 'Sending', detail: 'Emails are going out.' }
  }

  // Nothing is sending. Report the most urgent reason among the fresh readings.
  for (const reason of REASON_PRIORITY) {
    if (fresh.some(c => c.sending_state === reason)) {
      const copy = REASON_COPY[reason]
      return { verdict: 'not_sending', label: copy.label, detail: copy.detail }
    }
  }

  // Fresh readings exist but every sending_state is null: Instantly answered and carried
  // no status, or carried a code outside its own enum. Not sending is NOT the safe
  // assumption here, and neither is sending. Say we do not know.
  return {
    verdict: 'unknown',
    label: 'Not reported',
    detail: 'The sending tool did not report a status for this campaign.',
  }
}
