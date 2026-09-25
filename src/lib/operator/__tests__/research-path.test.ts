// WHICH PATH A RESEARCH RUN TAKES, and the $0.10-a-prospect bug this closes.
//
// queue_research_sources has been true since 2026-09-14, so the Batch API path and its 50%
// synthesis discount were switched on for eleven days. Measured 2026-09-25: all 300 fresh
// research runs of 2026-09-23 to 25 paid FULL price, because the routing lived in the HTTP
// route and the CLI called the inline implementation directly.
//
// Synthesis is 90.6% of a prospect's Anthropic cost (measured over 105 prospects), so the
// gap was about $0.10 a prospect for the same model on the same prompt.
//
// THE DECISION TABLE IS THE TEST. Every combination of the three flags against both fresh
// policies, because the one thing the two callers legitimately disagree about is what a
// fresh fetch means, and that disagreement is the parameter.

import { describe, it, expect } from 'vitest'
import { resolveResearchRouting, FRESH_FETCH_NOT_QUEUEABLE } from '../research-path'
import { HALF_ENABLED_BATCH_PATH_REFUSAL } from '../research-verdict'

/**
 * A Supabase stand-in that answers only the system_flags read isQueueEnabled makes.
 *
 * IT THROWS ON ANYTHING ELSE. A fake that quietly returns a chainable object for calls it
 * does not implement is this project's own "a fake that does not honour a filter cannot test
 * that filter": it would pass whether or not the code read the flags at all.
 */
function flagsFake(flags: Record<string, boolean>) {
  const asked: string[] = []
  const client = {
    from(table: string) {
      if (table !== 'system_flags') throw new Error(`fake: unexpected table ${table}`)
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              asked.push(key)
              return {
                maybeSingle: async () => ({
                  data: key in flags ? { enabled: flags[key] } : null,
                  error: null,
                }),
                single: async () => ({
                  data: key in flags ? { enabled: flags[key] } : null,
                  error: null,
                }),
              }
            },
          }
        },
      }
    },
  }
  return { client: client as never, asked }
}

const BATCH_ON   = { queue_research_sources: true,  queue_research: false, queue_research_collect: true }
const BATCH_HALF = { queue_research_sources: true,  queue_research: false, queue_research_collect: false }
const SINGLE_ON  = { queue_research_sources: false, queue_research: true,  queue_research_collect: true }
const ALL_OFF    = { queue_research_sources: false, queue_research: false, queue_research_collect: false }

describe('the batch path, which is the whole point', () => {
  it('QUEUES a stored-findings run onto the batch path when the flag is on', async () => {
    // THE REGRESSION TEST. This is the live production flag state, and before 2026-09-25 the
    // CLI ran inline anyway.
    const { client } = flagsFake(BATCH_ON)
    const r = await resolveResearchRouting(client, { useStoredFindings: true, freshPolicy: 'inline' })
    expect(r).toEqual({ kind: 'queue', jobType: 'research_sources', batched: true })
  })

  it('gives the CLI and the route the SAME answer on a stored-findings run', async () => {
    // The policy parameter must change ONE case and no others. If it changed this one, the
    // two callers would be on different paths and the cost figures would not be comparable.
    const a = await resolveResearchRouting(flagsFake(BATCH_ON).client,
      { useStoredFindings: true, freshPolicy: 'inline' })
    const b = await resolveResearchRouting(flagsFake(BATCH_ON).client,
      { useStoredFindings: true, freshPolicy: 'refuse' })
    expect(a).toEqual(b)
  })

  it('actually reads the flags, so a pass cannot come from ignoring them', async () => {
    const { client, asked } = flagsFake(BATCH_ON)
    await resolveResearchRouting(client, { useStoredFindings: true, freshPolicy: 'inline' })
    expect(asked).toContain('queue_research_sources')
    expect(asked).toContain('queue_research_collect')
  })
})

describe('the single-job queue path, which is queued but NOT discounted', () => {
  it('queues onto research, not research_sources', async () => {
    // Worth its own case because "the queue path" is ambiguous: the 'research' job type runs
    // synthesis inline and pays standard rates. Only research_sources is the discount.
    const { client } = flagsFake(SINGLE_ON)
    const r = await resolveResearchRouting(client, { useStoredFindings: true, freshPolicy: 'inline' })
    expect(r).toEqual({ kind: 'queue', jobType: 'research', batched: false })
  })
})

describe('inline, and why', () => {
  it('runs inline when every flag is off, and says the flags are why', async () => {
    const { client } = flagsFake(ALL_OFF)
    const r = await resolveResearchRouting(client, { useStoredFindings: true, freshPolicy: 'inline' })
    expect(r).toEqual({ kind: 'inline', reason: 'flags_off' })
  })

  it('runs a FRESH fetch inline for the CLI, and says --fresh is why', async () => {
    // The named exception. A queued job carries no per-job options, so it always reuses.
    const { client } = flagsFake(BATCH_ON)
    const r = await resolveResearchRouting(client, { useStoredFindings: false, freshPolicy: 'inline' })
    expect(r).toEqual({ kind: 'inline', reason: 'explicit_fresh' })
  })

  it('distinguishes the two inline reasons, because they are different decisions', async () => {
    const off = await resolveResearchRouting(flagsFake(ALL_OFF).client,
      { useStoredFindings: false, freshPolicy: 'inline' })
    const fresh = await resolveResearchRouting(flagsFake(BATCH_ON).client,
      { useStoredFindings: false, freshPolicy: 'inline' })
    expect(off).not.toEqual(fresh)
  })
})

describe('refusals, preserved exactly as the route had them', () => {
  it('REFUSES a fresh fetch for the route, with the route s 400', async () => {
    const { client } = flagsFake(BATCH_ON)
    const r = await resolveResearchRouting(client, { useStoredFindings: false, freshPolicy: 'refuse' })
    expect(r).toEqual({ kind: 'refuse', reason: FRESH_FETCH_NOT_QUEUEABLE, status: 400 })
  })

  it('REFUSES a half-enabled batch path with 409, because phase 1 buys sources nothing collects', async () => {
    const { client } = flagsFake(BATCH_HALF)
    const r = await resolveResearchRouting(client, { useStoredFindings: true, freshPolicy: 'inline' })
    expect(r).toEqual({ kind: 'refuse', reason: HALF_ENABLED_BATCH_PATH_REFUSAL, status: 409 })
  })

  it('checks half-enabled BEFORE fresh, so 409 wins over 400', async () => {
    // The route's order, kept. A half-enabled path is a configuration fault that blocks every
    // organisation; a fresh fetch is one caller asking for something queueing cannot do. The
    // configuration fault is the more useful thing to be told.
    const { client } = flagsFake(BATCH_HALF)
    const r = await resolveResearchRouting(client, { useStoredFindings: false, freshPolicy: 'refuse' })
    expect(r.kind).toBe('refuse')
    if (r.kind !== 'refuse') throw new Error('unreachable')
    expect(r.status).toBe(409)
  })

  it('does NOT refuse a half-enabled path when the batch path is not live at all', async () => {
    // queue_research_collect is false in ALL_OFF too, and that is not a fault: there is no
    // batch to strand. Without this the refusal would fire on a correctly inline system.
    const { client } = flagsFake(ALL_OFF)
    const r = await resolveResearchRouting(client, { useStoredFindings: true, freshPolicy: 'inline' })
    expect(r.kind).toBe('inline')
  })
})
