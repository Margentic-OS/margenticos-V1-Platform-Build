// Tests for deriveCampaignLiveness — the one place that decides whether a client is told
// their outreach is running.
//
// The failure this guards against is specific. campaigns.status is INTENT and a campaign
// at 'active' can be sending nothing, so "live" must come from sending_state and from a
// reading that is still fresh. A stale reading is not evidence; it is a memory.

import { describe, it, expect } from 'vitest'
import { deriveCampaignLiveness, LIVENESS_STALE_AFTER_MS } from './campaign-liveness'
import type { LivenessInput } from './campaign-liveness'

const NOW = new Date('2026-08-24T15:30:00.000Z')
const EXT = 'cf695496-dba1-4bcb-beae-1b6ca28209d6'

function campaign(overrides: Partial<LivenessInput> = {}): LivenessInput {
  return {
    external_id: EXT,
    sending_state: 'sending',
    sending_status_checked_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

describe('deriveCampaignLiveness — when a client may be told "Sending"', () => {
  it('says sending for a fresh healthy reading', () => {
    const result = deriveCampaignLiveness([campaign()], NOW)
    expect(result.verdict).toBe('sending')
    expect(result.label).toBe('Sending')
  })

  it('one sending campaign is enough, even beside a blocked one', () => {
    const result = deriveCampaignLiveness(
      [campaign({ sending_state: 'blocked' }), campaign()],
      NOW,
    )
    expect(result.verdict).toBe('sending')
  })

  it('never says sending on the strength of a stale reading', () => {
    // Just past the threshold: four missed polls, so we no longer know.
    const stale = new Date(NOW.getTime() - LIVENESS_STALE_AFTER_MS - 1000).toISOString()
    const result = deriveCampaignLiveness([campaign({ sending_status_checked_at: stale })], NOW)

    expect(result.verdict).toBe('unknown')
    expect(result.label).toBe('Not reported')
  })

  it('accepts a reading exactly on the threshold', () => {
    const edge = new Date(NOW.getTime() - LIVENESS_STALE_AFTER_MS).toISOString()
    expect(deriveCampaignLiveness([campaign({ sending_status_checked_at: edge })], NOW).verdict)
      .toBe('sending')
  })

  it('treats a never-checked campaign as unknown, not as not-sending', () => {
    const result = deriveCampaignLiveness([campaign({ sending_status_checked_at: null })], NOW)
    expect(result.verdict).toBe('unknown')
  })

  it('treats an unparseable timestamp as no reading at all', () => {
    const result = deriveCampaignLiveness([campaign({ sending_status_checked_at: 'not a date' })], NOW)
    expect(result.verdict).toBe('unknown')
  })
})

describe('deriveCampaignLiveness — reporting why nothing is going out', () => {
  it.each([
    ['blocked', 'Sending paused by the email provider'],
    ['limit_reached', 'Daily sending limit reached'],
    ['waiting', 'Waiting to send'],
    ['paused', 'Paused'],
    ['draft', 'Not started'],
    ['completed', 'Sequence finished'],
  ])('reports %s as "%s"', (state, label) => {
    const result = deriveCampaignLiveness([campaign({ sending_state: state })], NOW)
    expect(result.verdict).toBe('not_sending')
    expect(result.label).toBe(label)
  })

  it('reports the most urgent reason when campaigns disagree', () => {
    // Nothing about 'blocked' resolves on its own, so it outranks a daily cap that clears
    // overnight and a schedule window that clears in the morning.
    const result = deriveCampaignLiveness(
      [campaign({ sending_state: 'waiting' }), campaign({ sending_state: 'blocked' }), campaign({ sending_state: 'limit_reached' })],
      NOW,
    )
    expect(result.label).toBe('Sending paused by the email provider')
  })

  it('ignores a stale blocked reading in favour of a fresh waiting one', () => {
    const stale = new Date(NOW.getTime() - LIVENESS_STALE_AFTER_MS - 1000).toISOString()
    const result = deriveCampaignLiveness(
      [campaign({ sending_state: 'blocked', sending_status_checked_at: stale }), campaign({ sending_state: 'waiting' })],
      NOW,
    )
    expect(result.label).toBe('Waiting to send')
  })

  it('never leaks an Instantly status code into client-facing copy', () => {
    const vendorCodes = [
      'healthy', 'campaign_paused', 'daily_limit_met', 'account_daily_limit_met',
      'out_of_schedule', 'campaign_account_suspended', 'no_accounts_available',
    ]
    for (const state of ['sending', 'blocked', 'limit_reached', 'waiting', 'paused', 'draft', 'completed']) {
      const { label, detail } = deriveCampaignLiveness([campaign({ sending_state: state })], NOW)
      const text = `${label} ${detail ?? ''}`
      for (const code of vendorCodes) expect(text).not.toContain(code)
    }
  })
})

describe('deriveCampaignLiveness — not knowing is a state, and it is never guessed', () => {
  it('says not set up when no campaign is registered in the sending tool', () => {
    const result = deriveCampaignLiveness([campaign({ external_id: null })], NOW)
    expect(result.verdict).toBe('unknown')
    expect(result.label).toBe('Not set up yet')
  })

  it('says not set up when there are no campaigns at all', () => {
    expect(deriveCampaignLiveness([], NOW).label).toBe('Not set up yet')
  })

  it('a fresh reading with a null state is unknown, not not-sending', () => {
    // Instantly answered and carried no status, or a code outside its own enum. Neither
    // "sending" nor "not sending" is safe to claim from that.
    const result = deriveCampaignLiveness([campaign({ sending_state: null })], NOW)
    expect(result.verdict).toBe('unknown')
    expect(result.label).toBe('Not reported')
  })

  it('ignores an unregistered campaign when judging the registered ones', () => {
    const result = deriveCampaignLiveness(
      [campaign({ external_id: null, sending_state: 'blocked' }), campaign()],
      NOW,
    )
    expect(result.verdict).toBe('sending')
  })
})
