// The queued-research message must describe the path that is actually live.
//
// WHY THIS FILE EXISTS AT ALL
//
// This defect has now been found twice in the same flow. The REFUSAL message in
// enqueue/research.ts told every operator they might be "waiting on a batch for up to 24
// hours" while the batch path was switched off; it was fixed on 2026-09-01 after it
// triggered a full investigation into a problem that did not exist. That fix did not look
// one file over, where the SUCCESS message carried the mirror-image bug: a hardcoded
// "roughly a minute per prospect" that would have been wrong by a factor of about 1,400
// the moment the batch path went on.
//
// So the tests below assert on BOTH directions, because a message that is right for one
// path and wrong for the other is exactly what shipped twice.
//
// The concurrency assertion deliberately reads QUEUE_CONFIG rather than hardcoding 20. A
// test that hardcodes the number it is protecting cannot notice when the config moves,
// which is the same class of mistake as the message it is guarding.

import { describe, it, expect } from 'vitest'
import { describeQueuedResearch } from '@/lib/operator/research-verdict'
import { QUEUE_CONFIG } from '@/lib/queue/config'

describe('describeQueuedResearch', () => {
  describe('single-job path', () => {
    const msg = describeQueuedResearch(12, 0, 'queue:single-job')

    it('names the configured concurrency, not a literal', () => {
      expect(msg).toContain(`up to ${QUEUE_CONFIG.research.maxInFlight} at a time`)
    })

    it('does not promise a minute per prospect, which was measured at 145 seconds', () => {
      expect(msg).not.toMatch(/roughly a minute per prospect/)
      expect(msg).toMatch(/2 to 3 minutes per prospect/)
    })

    it('never mentions a batch or a 24-hour wait on this path', () => {
      expect(msg.toLowerCase()).not.toContain('batch')
      expect(msg).not.toContain('24 hours')
    })

    it('reports the count it was given', () => {
      expect(msg).toContain('12 prospect(s) queued')
    })
  })

  describe('batch path', () => {
    const msg = describeQueuedResearch(8, 0, 'queue:batch')

    it('says the wait can be up to 24 hours', () => {
      expect(msg).toContain('24 hours')
    })

    it('does not describe the single-job timing', () => {
      expect(msg).not.toMatch(/minutes per prospect/)
      expect(msg).not.toContain(`up to ${QUEUE_CONFIG.research.maxInFlight} at a time`)
    })

    it('warns that a waiting prospect still reads as unresearched', () => {
      // The one operator-visible consequence of the wait that is NOT a failure: during the
      // batch, current_research_result_id is still null, so every count shows the prospect
      // as not yet researched. Saying so is what stops it being reported as a bug.
      expect(msg).toContain('still reads as unresearched')
    })

    it('reports the count it was given', () => {
      expect(msg).toContain('8 prospect(s) queued')
    })
  })

  describe('nothing new to queue', () => {
    it('is the same sentence on both paths, because no work was created either way', () => {
      const single = describeQueuedResearch(0, 5, 'queue:single-job')
      const batch  = describeQueuedResearch(0, 5, 'queue:batch')
      expect(single).toBe(batch)
      expect(single).toContain('all 5 eligible prospect(s) are already in the queue')
    })

    it('does not describe timing for work that was not enqueued', () => {
      const msg = describeQueuedResearch(0, 5, 'queue:batch')
      expect(msg).not.toContain('24 hours')
    })
  })

  // THE MUTATION GUARD. Delete the branch in describeQueuedResearch and this is the test
  // that goes red: the two paths must not produce the same sentence when work was created.
  it('produces a different message per path when work was actually queued', () => {
    expect(describeQueuedResearch(3, 0, 'queue:single-job'))
      .not.toBe(describeQueuedResearch(3, 0, 'queue:batch'))
  })
})
