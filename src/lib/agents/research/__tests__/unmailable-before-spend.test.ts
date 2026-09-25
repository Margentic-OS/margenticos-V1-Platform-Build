// DO NOT SPEND ON A PROSPECT THE SYSTEM ALREADY KNOWS IT WILL NOT EMAIL.
//
// ═══ WHAT WAS ACTUALLY MISSING, WHICH IS NARROWER THAN IT FIRST LOOKED ═══════
//
// checkResearchEligibility has gated SELECTION and ENQUEUE since 2026-08-25, in a commit
// called "do not pay for research on prospects already known to be unmailable". Measured
// 2026-09-25: of the 23 researched prospects that are send-ineligible, 21 were researched on
// or before the day that gate landed. Only 2 are later, both operator holds with no hold
// timestamp to date them. So the selection gate works.
//
// What it cannot cover is the WINDOW. A queued job waits between being enqueued and being
// claimed; on the batch path phase 1 waits again for a batch that may take hours. A prospect
// can be suppressed, held, or verified undeliverable inside those windows.
//
// Phase 2 of the batch path already re-read the row and refused. The single-job executor and
// every inline caller did not, and that is what this closes.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import {
  checkResearchEligibility,
  ProspectUnmailableError,
} from '@/lib/sourcing/send-eligibility-policy'

const VERIFIED_OK = {
  independent_verified_at: '2026-09-20T10:00:00Z',
  independent_email_status: 'Valid',
  email_send_ineligible_reason: null,
  verification_provider: 'myemailverifier',
  second_pass_status: null,
  second_pass_provider: null,
}

describe('the policy the re-check applies', () => {
  it('lets a verified, deliverable prospect through', () => {
    // The positive control. Without it, every refusal assertion below could pass on a
    // function that refuses everything, which would stop research entirely.
    expect(checkResearchEligibility(VERIFIED_OK)).toEqual({ eligible: true })
  })

  it('refuses a prospect with no verdict at all', () => {
    const v = checkResearchEligibility({ ...VERIFIED_OK, independent_verified_at: null })
    expect(v.eligible).toBe(false)
    if (v.eligible) throw new Error('unreachable')
    expect(v.reason).toBe('no_verdict')
  })

  it('refuses an undeliverable address', () => {
    const v = checkResearchEligibility({ ...VERIFIED_OK, independent_email_status: 'Invalid' })
    expect(v.eligible).toBe(false)
    if (v.eligible) throw new Error('unreachable')
    expect(v.reason).toBe('undeliverable')
  })

  it('refuses an operator hold, and names it as a hold rather than a country rule', () => {
    // Measured 2026-09-25: operator_hold is the reason on 5 of the 23 ineligible-but-
    // researched prospects, and the only reason appearing AFTER the selection gate landed.
    const v = checkResearchEligibility({ ...VERIFIED_OK, email_send_ineligible_reason: 'operator_hold' })
    expect(v.eligible).toBe(false)
    if (v.eligible) throw new Error('unreachable')
    expect(v.reason).toBe('operator_hold')
  })

  it('refuses an excluded country', () => {
    const v = checkResearchEligibility({ ...VERIFIED_OK, email_send_ineligible_reason: 'country_excluded_de' })
    expect(v.eligible).toBe(false)
    if (v.eligible) throw new Error('unreachable')
    expect(v.reason).toBe('country_excluded')
  })

  it('an operator hold beats a second pass that says deliverable', () => {
    // The ordering matters and 2 real prospects have exactly this shape: a catch-all resolved
    // to deliverable, with a hold placed on top. The hold is a decision about the PERSON and
    // must outrank good news about the address.
    const v = checkResearchEligibility({
      ...VERIFIED_OK,
      independent_email_status: 'Catch All',
      second_pass_status: 'deliverable',
      second_pass_provider: 'bouncer',
      email_send_ineligible_reason: 'operator_hold',
    })
    expect(v.eligible).toBe(false)
  })
})

describe('ProspectUnmailableError carries what a caller needs to act', () => {
  it('names the reason, so a batch can report WHY it skipped', () => {
    const e = new ProspectUnmailableError('p-1', 'operator_hold', 'A hold is in place.')
    expect(e.ineligible_reason).toBe('operator_hold')
    expect(e.prospect_id).toBe('p-1')
  })

  it('says plainly that nothing was spent, because that is what makes it a skip', () => {
    const e = new ProspectUnmailableError('p-1', 'suppressed', 'Suppressed.')
    expect(e.message).toContain('No source or model call was made')
  })

  it('is distinguishable from an ordinary Error, which is how the skip is routed', () => {
    // Both the batch loop and the queue executor branch on `instanceof`. If the class were
    // not preserved through the throw, a skip would be counted as a failure and retried.
    const e: unknown = new ProspectUnmailableError('p-1', 'no_verdict', 'Never verified.')
    expect(e instanceof ProspectUnmailableError).toBe(true)
    expect(e instanceof Error).toBe(true)
    expect(new Error('plain') instanceof ProspectUnmailableError).toBe(false)
  })

  it('carries suppression as its own reason, separate from the address verdict', () => {
    // A suppressed person and an undeliverable address are different refusals: one is
    // compliance, the other is spend. Reporting either as the other hides what happened.
    const e = new ProspectUnmailableError('p-1', 'suppressed', 'Suppressed.')
    expect(e.ineligible_reason).toBe('suppressed')
  })
})
