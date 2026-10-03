// The email's second line is read back against the client's approved reason (operator note
// 5 on the second reading, 2026-10-01). What the model is asked is a reading; what CODE
// verifies about its answer is tested here without a model.
//
// What these tests cannot show: whether the model reads a real line correctly. That is
// measured by running the writer on real prospects. These hold everything around it: what
// counts as a verdict, what a verdict rejects, and which way a missing verdict falls.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { FatalApiError } from '@/lib/agents/fatal-api-error'
import {
  REASON_MATCH_SYSTEM_PROMPT, checkBridgeStatesReason, readReasonMatchReply, reasonMatchFailures,
  type ReasonMatchClient,
} from '../reason-match'

const REASON = 'A second machine points to growth, and growth needs more orders.'
const GOOD = 'A second machine usually means a firm is set on growing.'
const LOADED = 'A second machine needs a full order book from the day it is switched on.'

const reply = (says: string, same: 'yes' | 'no', adds: string[]) => JSON.stringify({ says, same, adds })

describe('readReasonMatchReply', () => {
  it('a line that says what the reason says, and adds nothing, is a match', () => {
    expect(readReasonMatchReply(reply('a firm is set on growing', 'yes', []), GOOD))
      .toEqual({ says: 'a firm is set on growing', same: true, adds: [] })
  })

  it('PLANTED: "says" must be words of the sentence, or the line is treated as saying nothing', () => {
    // The model reports a meaning the sentence does not contain. That is not a verdict
    // about this sentence, so it cannot pass it.
    expect(readReasonMatchReply(reply('the firm wants more orders', 'yes', []), GOOD))
      .toEqual({ says: '', same: false, adds: [] })
  })

  it('an addition quoted from the sentence is kept', () => {
    const v = readReasonMatchReply(reply('needs a full order book', 'no', ['from the day it is switched on']), LOADED)
    expect(v?.adds).toEqual(['from the day it is switched on'])
  })

  it('PLANTED: an addition the model did not quote word for word makes the reply NO VERDICT, with "same" yes or no', () => {
    // The model saw something added and code cannot confirm what. The first version dropped
    // the addition, and with same "yes" that read as a clean match and the line shipped.
    expect(readReasonMatchReply(reply('a second machine', 'yes', ['needs a full order book from day one']), LOADED)).toBeNull()
    expect(readReasonMatchReply(reply('needs a full order book', 'no', ['from the day it is switched on', 'by next quarter']), LOADED)).toBeNull()
  })

  it('an empty string in the list is not an addition', () => {
    expect(readReasonMatchReply(reply('a firm is set on growing', 'yes', ['', '  ']), GOOD)).toEqual({ says: 'a firm is set on growing', same: true, adds: [] })
  })

  it('folds case and punctuation when looking for the copy', () => {
    expect(readReasonMatchReply(reply('A FIRM IS SET ON GROWING.', 'yes', []), GOOD)?.same).toBe(true)
  })

  it('PLANTED: a reply that is not a verdict is null, never a pass', () => {
    expect(readReasonMatchReply('The sentence matches the reason.', GOOD)).toBeNull()
    expect(readReasonMatchReply('{"says": "x", "same": "maybe", "adds": []}', GOOD)).toBeNull()
    expect(readReasonMatchReply('{"says": "x", "same": "yes"}', GOOD)).toBeNull()
    expect(readReasonMatchReply('{"same": "yes", "adds": []}', GOOD)).toBeNull()
    expect(readReasonMatchReply('{"says": ', GOOD)).toBeNull()
  })
})

describe('reasonMatchFailures', () => {
  it('a match produces none', () => {
    expect(reasonMatchFailures({ says: 'a firm is set on growing', same: true, adds: [] }, REASON)).toEqual([])
  })

  it('PLANTED: a line that says something else is rejected, and the writer is shown the reason again', () => {
    const failures = reasonMatchFailures({ says: '', same: false, adds: [] }, REASON)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('does not say what the approved reason says')
    expect(failures[0]).toContain(REASON)
  })

  it('PLANTED: a line that says the reason AND adds to it is rejected for each addition', () => {
    const failures = reasonMatchFailures({ says: 'points to growth', same: true, adds: ['from the day it is switched on', 'a full order book'] }, REASON)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('"from the day it is switched on"')
    expect(failures[1]).toContain('"a full order book"')
  })

  it('PLANTED: no verdict is a rejection of the attempt, not a pass', () => {
    const failures = reasonMatchFailures(null, REASON)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('could not be checked')
  })
})

describe('checkBridgeStatesReason', () => {
  const client = (text: string | Error): { client: ReasonMatchClient; calls: unknown[] } => {
    const calls: unknown[] = []
    return {
      calls,
      client: { messages: { create: async body => {
        calls.push(body)
        if (text instanceof Error) throw text
        return { content: [{ type: 'text', text }], usage: { input_tokens: 120, output_tokens: 30 } }
      } } },
    }
  }

  it('shows the model the approved reason and the sentence, at temperature 0, and reports what it cost', async () => {
    const c = client(reply('a firm is set on growing', 'yes', []))
    const out = await checkBridgeStatesReason({ apiKey: 'k', approvedReason: REASON, bridge: GOOD, prospectId: 'p', client: c.client })
    expect(out.failures).toEqual([])
    expect(out.usage).toMatchObject({ input_tokens: 120, output_tokens: 30, calls: 1 })
    const body = c.calls[0] as { temperature: number; messages: Array<{ content: string }> }
    expect(body.temperature).toBe(0)
    expect(body.messages[0].content).toBe(`APPROVED REASON: ${REASON}\n\nSENTENCE: ${GOOD}`)
  })

  it('PLANTED: the loaded line is rejected, naming what it added', async () => {
    const c = client(reply('needs a full order book', 'no', ['from the day it is switched on']))
    const out = await checkBridgeStatesReason({ apiKey: 'k', approvedReason: REASON, bridge: LOADED, prospectId: 'p', client: c.client })
    expect(out.failures.join(' | ')).toContain('does not say what the approved reason says')
    expect(out.failures.join(' | ')).toContain('"from the day it is switched on"')
  })

  it('PLANTED: a call that fails rejects the attempt; an unchecked line does not ship', async () => {
    const c = client(new Error('overloaded'))
    const out = await checkBridgeStatesReason({ apiKey: 'k', approvedReason: REASON, bridge: GOOD, prospectId: 'p', client: c.client })
    expect(out.verdict).toBeNull()
    expect(out.failures).toHaveLength(1)
  })

  it('PLANTED: a reply that does not parse rejects the attempt too', async () => {
    const out = await checkBridgeStatesReason({ apiKey: 'k', approvedReason: REASON, bridge: GOOD, prospectId: 'p', client: client('It matches.').client })
    expect(out.verdict).toBeNull()
    expect(out.failures).toHaveLength(1)
  })

  it('PLANTED: a spent balance is not one rejected attempt: it stops the run', async () => {
    // Every other failure rejects the attempt and the writer tries again. A credit balance
    // that has run out fails every later call too, so it has to abort the batch.
    const c = client(new Error('Your credit balance is too low to access the Anthropic API.'))
    await expect(checkBridgeStatesReason({ apiKey: 'k', approvedReason: REASON, bridge: GOOD, prospectId: 'p', client: c.client }))
      .rejects.toBeInstanceOf(FatalApiError)
  })

  it('PLANTED: asks about five named kinds of addition, and says naming the event is never one', () => {
    // The first version asked for "every claim the reason does not make" and rejected a
    // line for naming the event, which every second line has to do.
    expect(REASON_MATCH_SYSTEM_PROMPT).toContain('of these five kinds ONLY')
    for (const kind of ['a time or a deadline', 'an amount or a quantity', 'who has to do something', 'lack or are short of', 'how things stand for the reader today']) {
      expect(REASON_MATCH_SYSTEM_PROMPT).toContain(kind)
    }
    expect(REASON_MATCH_SYSTEM_PROMPT).toContain('Words that name or describe the event are never an addition')
  })

  it('Rule Zero: the prompt names no market', () => {
    const lower = REASON_MATCH_SYSTEM_PROMPT.toLowerCase()
    const MARKET_WORDS = ['referral', 'consult', 'pipeline', 'diary', 'margentic', 'founder', 'agency', 'outbound', 'client', 'hire', 'hiring']
    expect(MARKET_WORDS.filter(w => lower.includes(w))).toEqual([])
  })
})
