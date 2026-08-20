// Guards the two bugs found on 2026-08-19 in what research writes to prospects.
//
// BUG 1: the ICP pain proxy was written to prospects.personalisation_trigger even when
// no candidate passed. Composition treats any non-null value as researched, so three
// prospects on three different variants received the same opening paragraph.
//
// BUG 2: trigger_text was the model's free text and never tied to the selected winner,
// so a 6/6 winner could sit on file while the prospect got generic ICP framing.

import { describe, it, expect } from 'vitest'
import { contentOverlap, TRIGGER_WINNER_MIN_OVERLAP } from '../synthesize'

describe('contentOverlap, the winner-to-trigger check', () => {
  it('scores a faithful rephrasing well above the threshold', () => {
    const winner = 'All of her recent LinkedIn posts are client work: intern questions, performance review coaching, HR policy for founders. UpLevel has been a solo operation since 2018.'
    const trigger = 'Your recent LinkedIn posts are all client work: intern questions, performance reviews. UpLevel has been solo since 2018.'
    expect(contentOverlap(trigger, winner)).toBeGreaterThan(TRIGGER_WINNER_MIN_OVERLAP)
  })

  it('scores the real Daedra mismatch at zero', () => {
    const winner = 'All five recent LinkedIn posts are civil rights advocacy content. The website is a minimal Wix brochure with no blog, no case studies, and no dated content.'
    const trigger = 'Most founders of boutique DEI consultancies at this stage hit the same wall. Referrals carry the pipeline for a stretch, then a quarter goes dry with nothing behind it.'
    expect(contentOverlap(trigger, winner)).toBeLessThan(TRIGGER_WINNER_MIN_OVERLAP)
  })

  it('scores the real Corral mismatch below the threshold', () => {
    const winner = 'Richard has run Corral Consulting solo since August 2007, now 18 years, with headcount still at approximately one person.'
    const trigger = 'Most solo consulting principals running on referrals and community relationships for years hit the same point. A project wraps, and the next conversation is not already in the diary.'
    expect(contentOverlap(trigger, winner)).toBeLessThan(TRIGGER_WINNER_MIN_OVERLAP)
  })

  it('returns 0 when either side is empty', () => {
    expect(contentOverlap('', 'something here entirely')).toBe(0)
    expect(contentOverlap('something here entirely', '')).toBe(0)
  })

  it('ignores stopwords so shared grammar alone cannot pass', () => {
    expect(contentOverlap('the pipeline of the firm', 'the diary of the founder')).toBeLessThan(TRIGGER_WINNER_MIN_OVERLAP)
  })
})
