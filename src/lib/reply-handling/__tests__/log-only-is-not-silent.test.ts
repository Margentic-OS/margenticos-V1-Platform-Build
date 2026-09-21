// A reply that needs a person is never invisible, including the one nobody planned for.
//
// THE GAP THIS CLOSES.
//
// routeIntent returns 'log_only' for an intent it has no rule for. The orchestrator then
// returned { kind: 'log_only' } and wrote nothing. process-reply recorded an action row with
// action_succeeded TRUE and marked the signal processed, so:
//
//   MON-028 could not see it — it counts reply_drafts rows, and there was none.
//   MON-014 could not see it — it counts UNPROCESSED signals, and this one is processed.
//   MON-015 could not see it — it counts permanently_failed, and nothing failed.
//
// The operator notification does fire for such an intent, but once, after which the signal is
// closed. A lost email therefore lost the reply, with no second surface anywhere. That is the
// 'no backstop at all' case in the Notion row on notifications recording intent, not delivery.
//
// TWO HALVES, AND THEY ARE DELIBERATELY DIFFERENT IN KIND.
//
//   1. The DRIFT GUARD below keeps log_only unreachable: every intent the classifier can
//      produce must have a routing rule. Today the two sets agree, so log_only cannot occur
//      on the real path at all. This is a structural check, in the spirit of "derive the
//      second list from the first so the drift cannot be expressed" — the two sets are
//      declared in separate modules, so a test comparing them is the available form.
//   2. The BACKSTOP tests assert that if it happens anyway, a person can find the reply.
//
// A guard alone would be a guard that has never been seen to fire. A backstop alone would
// wait for the drift. Both, because the first is cheap and the second is the one that matters
// on the day the first is edited.
//
// MUTATION-PROVED:
//   Delete the insertDraftRow call in the orchestrator's log_only branch: 'writes a
//   manual_required row' and 'the row is one MON-028 counts' go red.
//   Add a tenth intent to the classifier's VALID_INTENTS and not to KNOWN_INTENTS: the drift
//   guard goes red naming it.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { routeIntent } from '../route-intent'
import { orchestrateDraft } from '../draft-orchestrator'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'

// The statuses MON-028 counts as waiting on a person. Kept here as a literal ON PURPOSE and
// read back from the migration below, so this test cannot drift away from the monitor it
// claims to feed.
const MON_028_WAITING_STATUSES = ['pending', 'manual_required', 'draft_failed', 'send_failed']

// ── Half one: the drift guard ─────────────────────────────────────────────────

describe('every intent the classifier can produce has a routing rule', () => {
  // Both sets are module-private, so they are read from source. A regex over source is a
  // weaker instrument than an import and it is the honest one here; it is guarded below by
  // asserting a non-empty parse, so a broken regex fails loudly rather than passing over
  // nothing. That vacuity is the failure mode this codebase has shipped twice.
  function intentsIn(relativePath: string, constName: string): string[] {
    const src = readFileSync(join(process.cwd(), relativePath), 'utf8')
    const block = new RegExp(`const ${constName}[^=]*=\\s*new Set[^(]*\\(\\[([^\\]]*)\\]`, 'm').exec(src)
    if (!block) throw new Error(`could not find ${constName} in ${relativePath}`)
    return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  }

  const classifierIntents = intentsIn('src/lib/agents/reply-classifier.ts', 'VALID_INTENTS')
  const routerIntents = intentsIn('src/lib/reply-handling/route-intent.ts', 'KNOWN_INTENTS')

  it('parsed both lists, so a silent regex failure cannot make this vacuous', () => {
    expect(classifierIntents.length).toBeGreaterThanOrEqual(8)
    expect(routerIntents.length).toBeGreaterThanOrEqual(8)
    expect(classifierIntents).toContain('opt_out')
    expect(routerIntents).toContain('opt_out')
  })

  it('no classifier intent is missing a routing rule', () => {
    const unrouted = classifierIntents.filter((i) => !routerIntents.includes(i))
    // Naming them matters: the failure message is the whole value of this test.
    expect(unrouted).toEqual([])
  })

  it('no intent routes to log_only, so the backstop below is a backstop and not the norm', () => {
    for (const intent of classifierIntents) {
      // Every confidence band, because positive_direct_booking's routing depends on it.
      for (const confidence of [0.0, 0.5, 0.75, 0.95, 1.0]) {
        expect(routeIntent({ intent, confidence, faqMatchTopScore: null })).not.toBe('log_only')
      }
    }
  })
})

// ── Half two: the backstop, for when half one is edited anyway ────────────────

function createFakeSupabase() {
  const draftInserts: Record<string, unknown>[] = []
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'reply_drafts') {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: (row: Record<string, unknown>) => {
            draftInserts.push(row)
            return {
              select: () => ({ single: async () => ({ data: { id: 'backstop-1' }, error: null }) }),
            }
          },
        }
        return b
      }
      throw new Error(`fake does not implement table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { client: client as ServiceRoleClient, draftInserts }
}

// findFaqMatches runs before routing, so it is stubbed; nothing else on the log_only path is.
vi.mock('@/lib/faq/matcher', () => ({ findFaqMatches: vi.fn(async () => []) }))

const UNROUTABLE = 'intent_route_intent_has_never_heard_of'

function input(supabase: ServiceRoleClient) {
  return {
    signal: {
      id: 'sig-unroutable',
      organisation_id: 'org-a',
      campaign_id: 'camp-a',
      raw_data: { body: { text: 'Something the classifier labelled oddly.' } },
      original_outbound_body: 'The original outbound email.',
    },
    classification: { intent: UNROUTABLE, confidence: 0.8, reasoning: 'r' },
    prospectId: 'prospect-1',
    supabase,
  }
}

describe('an unroutable intent leaves something a person can find', () => {
  it('confirms the premise: this intent really does route to log_only', () => {
    expect(routeIntent({ intent: UNROUTABLE, confidence: 0.8, faqMatchTopScore: null })).toBe('log_only')
  })

  it('writes a manual_required row rather than returning silently', async () => {
    const fake = createFakeSupabase()
    const result = await orchestrateDraft(input(fake.client))

    expect(result.kind).toBe('log_only')
    // Before this change: zero inserts, and nothing anywhere recorded a waiting reply.
    expect(fake.draftInserts).toHaveLength(1)

    const row = fake.draftInserts[0]
    expect(row.status).toBe('manual_required')
    expect(row.signal_id).toBe('sig-unroutable')
    expect(row.prospect_id).toBe('prospect-1')
    expect(row.ai_draft_body).toBeNull()
    expect(row.intent).toBe(UNROUTABLE)
    expect((row.draft_metadata as Record<string, unknown>).reason).toBe('unroutable_intent')
  })

  it('the row is one MON-028 counts, and tier satisfies the CHECK constraint', async () => {
    const fake = createFakeSupabase()
    await orchestrateDraft(input(fake.client))

    const row = fake.draftInserts[0]
    // A row the monitor does not count would be a backstop that backstops nothing.
    expect(MON_028_WAITING_STATUSES).toContain(row.status)
    // reply_drafts_tier_check permits 2 or 3 only; reply_drafts_body_required demands a null
    // body for manual_required. Both asserted because a violation is a runtime insert failure.
    expect([2, 3]).toContain(row.tier)
    expect(row.ai_draft_body).toBeNull()
  })

  it('carries the draft id back so the action row can point at the card', async () => {
    const fake = createFakeSupabase()
    const result = await orchestrateDraft(input(fake.client))

    expect(result).toEqual({ kind: 'log_only', reply_draft_id: 'backstop-1' })
  })

  it('throws rather than closing the signal when the backstop row cannot be written', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const failing: any = {
      from: () => {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: null, error: { message: 'insert failed' } }),
            }),
          }),
        }
        return b
      },
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // A throw leaves the signal unprocessed, so the next cron run retries. Returning
    // log_only here would mark it processed and lose the reply for good, which is the
    // behaviour this whole file exists to remove.
    await expect(orchestrateDraft(input(failing as ServiceRoleClient))).rejects.toThrow(
      'log_only backstop row insert failed',
    )
  })
})

// ── The statuses literal above is checked against the migration ───────────────

describe('MON_028_WAITING_STATUSES matches the monitor', () => {
  it('lists exactly the statuses the mon_028 view selects on', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260904211000_mon_028_ageing_reply_drafts.sql'),
      'utf8',
    )
    const m = /d\.status IN \(([^)]*)\)/.exec(sql)
    if (!m) throw new Error('could not find the status filter in the mon_028 migration')
    const fromView = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])

    // Guards itself: an empty parse must not pass.
    expect(fromView.length).toBeGreaterThan(0)
    expect(fromView.sort()).toEqual([...MON_028_WAITING_STATUSES].sort())

    // NOTE ON THE LIMIT OF THIS CHECK. A migration scan proves history, not present state: a
    // later migration could redefine mon_028 and this would still pass. MON-024 and the
    // monitor sweep are what read the live catalog. This is the cheap early warning.
  })
})
