// A personalised Email 1 needs a follow-up that carries its thread forward (operator note
// 4, 2026-10-01). The verdict is a pure function of a composed sequence; the upload acts on
// it, and that join is tested in handleUploadLeads.thread-hold.test.ts.

import { describe, it, expect } from 'vitest'
import { THREAD_NOT_CARRIED, describeThreadHold, threadVerdict } from '../thread-carried'
import type { ComposedSequence, FollowupFallbackReason } from '../compose-sequence'

type Tier = ComposedSequence['opening']['tier']

function composed(tier: Tier, two: FollowupFallbackReason | null, three: FollowupFallbackReason | null) {
  const position = (reason: FollowupFallbackReason | null) =>
    ({ mode: reason === null ? 'generated' as const : 'template' as const, fell_back_reason: reason })
  return {
    opening: { tier, detail: null },
    followups: { arm: 'generated' as const, email1_fingerprint: 'f', positions: { 2: position(two), 3: position(three) } },
  }
}

describe('threadVerdict', () => {
  it('PLANTED: a personalised Email 1 with two template follow-ups does not carry its thread', () => {
    const verdict = threadVerdict(composed('research', 'none_stored', 'none_stored'))
    expect(verdict).toEqual({ required: true, carried: false, reasons: { 2: 'none_stored', 3: 'none_stored' } })
  })

  it('one personalised follow-up carries it, whichever position it is in', () => {
    expect(threadVerdict(composed('research', null, 'none_stored'))).toMatchObject({ required: true, carried: true, reasons: { 2: null, 3: 'none_stored' } })
    expect(threadVerdict(composed('research', 'email1_changed', null))).toMatchObject({ required: true, carried: true, reasons: { 2: 'email1_changed', 3: null } })
  })

  it('PLANTED: every reason a position can fall back for is a hold when both positions fall back', () => {
    const reasons: FollowupFallbackReason[] = ['not_assigned', 'none_stored', 'email1_changed', 'unreadable_frame']
    for (const reason of reasons) {
      expect(threadVerdict(composed('research', reason, reason)).carried).toBe(false)
    }
  })

  it('the rule does not apply to a firm-fact or a template Email 1', () => {
    for (const tier of ['firm_fact', 'template'] as const) {
      expect(threadVerdict(composed(tier, 'not_assigned', 'not_assigned'))).toMatchObject({ required: false, carried: true })
    }
  })

  it('PLANTED: a sequence with no follow-up record at all is a hold, never a pass', () => {
    // A record missing a position must not read as "nothing fell back".
    const verdict = threadVerdict({ opening: { tier: 'research', detail: null }, followups: { arm: 'generated', email1_fingerprint: 'f', positions: {} } })
    expect(verdict).toEqual({ required: true, carried: false, reasons: { 2: 'none_stored', 3: 'none_stored' } })
  })
})

describe('describeThreadHold', () => {
  it('names the reason code, both positions and the next step', () => {
    const sentence = describeThreadHold(threadVerdict(composed('research', 'none_stored', 'email1_changed')))
    expect(sentence.startsWith(`${THREAD_NOT_CARRIED}: `)).toBe(true)
    expect(sentence).toContain('Email 2: none has been written')
    expect(sentence).toContain('Email 3: the one on file was written against a different Email 1')
    expect(sentence).toContain('Run the follow-up backfill, then upload again.')
  })
})
