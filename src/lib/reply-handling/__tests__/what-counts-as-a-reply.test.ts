// What counts as a reply, and what counts as a positive one.
//
// THE DEFECT BEHIND not_a_response. A prospect sent a security notice saying her mailbox
// was compromised and not to click the link. It contained "I would love to collaborate
// with you", classified as positive_passive, and rendered to the client as Interested.
//
// The first fix pointed those messages at `unclear`. That was right for routing and wrong
// for counting, because `unclear` then meant two different things: "a human replied and we
// cannot tell what they meant" (which IS a reply) and "this was not a reply to us at all"
// (which is not). One label carrying two meanings makes the reply count impossible to
// compute: exclude all of `unclear` and genuine ambiguous replies vanish; include it and a
// security notice counts as engagement.
//
// So not_a_response is its own intent. It routes EXACTLY as unclear does, so nothing
// changes operationally, and the two are separable when counting.

import { describe, it, expect } from 'vitest'
import {
  NON_REPLY_INTENTS,
  POSITIVE_REPLY_INTENTS,
  CLIENT_VISIBLE_INTENTS,
} from '../get-client-visible-replies'
import { routeIntent } from '../route-intent'
import { intentLabel } from '@/lib/intent-labels'

describe('what is NOT a reply', () => {
  it('excludes exactly the two things nobody wrote to us', () => {
    expect([...NON_REPLY_INTENTS].sort()).toEqual(['not_a_response', 'out_of_office'])
  })

  // A refusal is still a person engaging with what we sent, and every published
  // reply-rate figure we compare against counts it.
  it('counts an opt-out as a reply', () => {
    expect(NON_REPLY_INTENTS).not.toContain('opt_out')
  })

  // The distinction not_a_response exists to protect.
  it('counts unclear as a reply, because a human still replied to us', () => {
    expect(NON_REPLY_INTENTS).not.toContain('unclear')
  })

  it('counts a soft pushback as a reply', () => {
    expect(NON_REPLY_INTENTS).not.toContain('objection_mild')
  })
})

describe('what is a POSITIVE reply', () => {
  it('is interested, asked a question, or asked for a meeting', () => {
    expect([...POSITIVE_REPLY_INTENTS].sort()).toEqual([
      'information_request_commercial',
      'information_request_generic',
      'positive_direct_booking',
      'positive_passive',
    ])
  })

  // Deliberately narrower than what a client may SEE. "Come back next quarter" is a reply
  // worth showing and is not interest.
  it('excludes a soft pushback, unlike the client-visible list', () => {
    expect(POSITIVE_REPLY_INTENTS).not.toContain('objection_mild')
    expect(CLIENT_VISIBLE_INTENTS).toContain('objection_mild')
  })

  it('never counts anything that is not a reply at all', () => {
    for (const intent of NON_REPLY_INTENTS) {
      expect(POSITIVE_REPLY_INTENTS).not.toContain(intent)
    }
  })
})

describe('not_a_response routes exactly as unclear does', () => {
  const route = (intent: string) =>
    routeIntent({ intent, confidence: 0.9, faqMatchTopScore: null })

  it('goes to tier 3, a human, with nothing drafted or sent', () => {
    expect(route('not_a_response')).toBe('tier_3')
    expect(route('not_a_response')).toBe(route('unclear'))
  })

  // A route it does not know falls to log_only, which would make it invisible.
  it('is a known intent, so it cannot fall through to log_only', () => {
    expect(route('not_a_response')).not.toBe('log_only')
  })

  it('is never shown to the client', () => {
    expect(CLIENT_VISIBLE_INTENTS).not.toContain('not_a_response')
  })

  it('has a plain-language label rather than falling back to the raw value', () => {
    expect(intentLabel('not_a_response')).toBe('Not a reply to us')
  })
})

// The live shape on 2026-09-07, so a change that silently re-merges the two meanings fails
// here rather than on a client's dashboard.
describe('the live 2026-09-07 organisation', () => {
  const live = [
    { who: 'Bob', intent: 'opt_out' },
    { who: 'Katherine', intent: 'opt_out' },
    { who: 'April', intent: 'out_of_office' },
    { who: 'Lynn', intent: 'out_of_office' },
    { who: 'Jen', intent: 'not_a_response' },
  ]

  it('counts 2 replies from 5 people who sent something', () => {
    const replies = live.filter(
      r => !(NON_REPLY_INTENTS as readonly string[]).includes(r.intent),
    )
    expect(replies.map(r => r.who)).toEqual(['Bob', 'Katherine'])
  })

  it('counts 0 positive replies', () => {
    const positive = live.filter(r =>
      (POSITIVE_REPLY_INTENTS as readonly string[]).includes(r.intent),
    )
    expect(positive).toHaveLength(0)
  })
})
