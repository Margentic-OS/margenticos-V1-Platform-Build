// THE BANNER THAT TOLD A CLIENT THEIR LIST WOULD BE APPROVED FIVE WEEKS AGO.
//
// Reproduces the production state measured on 2026-09-17 and asserts the invariant that
// makes it impossible: a date is rendered only when it is in the future.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/dashboard/__tests__/auto-approval-notice.test.ts

import { describe, it, expect } from 'vitest'
import { autoApprovalNotice, AUTO_SANCTION_DAYS } from '../auto-approval-notice'

const NOW = new Date('2026-09-17T20:00:00Z')

const daysFromNow = (n: number) =>
  new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000).toISOString()

describe('autoApprovalNotice', () => {
  // ── THE INVARIANT THE WHOLE MODULE EXISTS FOR ──────────────────────────────
  //
  // Asserted over a spread of inputs rather than one, because the bug was not a single
  // wrong date: it was a date derived from an anchor that keeps receding, so ANY input
  // producing a past date is the same defect.
  describe('never returns a date that is not in the future', () => {
    const anchors = [
      ['the production anchor that produced "15 Aug 2026"', '2026-08-11T21:59:36Z'],
      ['a batch published today', daysFromNow(0)],
      ['a batch published a week ago', daysFromNow(-7)],
      ['a batch published five weeks ago', daysFromNow(-35)],
      ['a batch published exactly at the deadline', daysFromNow(-AUTO_SANCTION_DAYS)],
    ] as const

    for (const [name, published] of anchors) {
      it(`holds for ${name}`, () => {
        const notice = autoApprovalNotice({
          pendingPublishedAt: [published],
          locked: false,
          now: NOW,
        })

        if (notice.kind === 'scheduled') {
          expect(new Date(notice.onISO).getTime()).toBeGreaterThan(NOW.getTime())
        } else {
          // The only alternative to a future date is saying there is no automatic
          // approval. There is no third state in which a past date is rendered.
          expect(notice.kind).toBe('no_automatic_approval')
        }
      })
    }
  })

  // ── THE MEASURED PRODUCTION CASE ───────────────────────────────────────────
  it('does not promise a date for the anchor that read "15 Aug 2026" on 17 September', () => {
    // tier_1's earliest tier_published_at on production, which getTierData used as the
    // anchor for every batch published since. + 4 days = 2026-08-15, five weeks past.
    const notice = autoApprovalNotice({
      pendingPublishedAt: ['2026-08-11T21:59:36Z'],
      locked: false,
      now: NOW,
    })
    expect(notice.kind).toBe('no_automatic_approval')
  })

  it('anchors on the batch in front of the client, not on the oldest one', () => {
    // The correction. A batch published today, in a tier first published in August: the
    // old code produced 15 Aug 2026; the deadline is four days from the batch itself.
    const notice = autoApprovalNotice({
      pendingPublishedAt: [daysFromNow(0)],
      locked: false,
      now: NOW,
    })
    expect(notice.kind).toBe('scheduled')
    if (notice.kind !== 'scheduled') throw new Error('unreachable')
    expect(new Date(notice.onISO).getTime()).toBe(
      NOW.getTime() + AUTO_SANCTION_DAYS * 24 * 60 * 60 * 1000,
    )
  })

  it('uses the earliest PENDING batch when several are waiting', () => {
    const notice = autoApprovalNotice({
      pendingPublishedAt: [daysFromNow(-1), daysFromNow(0), daysFromNow(-2)],
      locked: false,
      now: NOW,
    })
    expect(notice.kind).toBe('scheduled')
    if (notice.kind !== 'scheduled') throw new Error('unreachable')
    // Earliest is two days ago, so the deadline is two days out, not four.
    expect(new Date(notice.onISO).getTime()).toBe(
      NOW.getTime() + (AUTO_SANCTION_DAYS - 2) * 24 * 60 * 60 * 1000,
    )
  })

  // ── THE HALF THAT IS NOT A DATE BUG ────────────────────────────────────────
  //
  // Measured 2026-09-17: all three tiers are locked (121, 36 and 3 uploaded rows), so the
  // auto-approval write is skipped and nothing will ever be approved automatically. A
  // perfectly plausible future date would still have been a false promise.
  it('promises nothing when the tier is locked, even for a batch published today', () => {
    const notice = autoApprovalNotice({
      pendingPublishedAt: [daysFromNow(0)],
      locked: true,
      now: NOW,
    })
    expect(notice.kind).toBe('no_automatic_approval')
  })

  it('says nothing at all when nothing is pending', () => {
    expect(autoApprovalNotice({ pendingPublishedAt: [], locked: false, now: NOW }).kind)
      .toBe('nothing_pending')
    // Locked changes nothing here: there is no promise to suppress.
    expect(autoApprovalNotice({ pendingPublishedAt: [], locked: true, now: NOW }).kind)
      .toBe('nothing_pending')
  })

  it('treats an unreadable date as no promise rather than guessing one', () => {
    const notice = autoApprovalNotice({
      pendingPublishedAt: ['not a date'],
      locked: false,
      now: NOW,
    })
    expect(notice.kind).toBe('no_automatic_approval')
  })
})
