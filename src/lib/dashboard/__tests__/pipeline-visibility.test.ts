// The pipeline opens because an operator opened it, and for no other reason.
//
// Until 2026-09-15 the client screen promised a rule nobody had implemented: "unlocks
// after your first 5 meetings or two months of sending, whichever comes first", with a
// progress bar toward five. organisations.pipeline_unlocked was read in 30 places and
// written in none, so the bar could fill and the screen stay locked for ever.
//
// These tests exist to make that promise unwritable again. The meeting-count cases are
// the point: they are not redundant with the boolean cases, because the failure being
// guarded is precisely someone reintroducing "...but open it once they have five".

import { describe, it, expect } from 'vitest'
import { isPipelineVisibleToClient } from '../pipeline-visibility'

describe('isPipelineVisibleToClient', () => {
  it('is closed when the operator has not opened it', () => {
    expect(isPipelineVisibleToClient({ pipeline_unlocked: false })).toBe(false)
  })

  it('is open when the operator has opened it', () => {
    expect(isPipelineVisibleToClient({ pipeline_unlocked: true })).toBe(true)
  })

  it('stays closed no matter how many meetings exist, because meetings are not the rule', () => {
    // The predicate takes no meeting count, by design. If a future change adds one, this
    // test is where the argument would have to appear, and that is the conversation to
    // have rather than a quiet reintroduction of the old promise.
    for (const meetings of [0, 1, 4, 5, 6, 99, 1000]) {
      expect(isPipelineVisibleToClient({ pipeline_unlocked: false })).toBe(false)
      // meetings is deliberately unused: it cannot reach the decision.
      expect(typeof meetings).toBe('number')
    }
  })

  it('stays open at zero meetings, because meetings are not the rule in that direction either', () => {
    expect(isPipelineVisibleToClient({ pipeline_unlocked: true })).toBe(true)
  })
})
