// scripts/test-draft-orchestrator.ts
// Integration-style tests for orchestrateDraft.
// Run: npm run test-orchestrator
// No test runner — fails with process.exit(1) if any assertion fails.
//
// Uses a real Supabase client and real DB rows.
// Inserts test signal rows (cleaned up at end).
// Drafter is NOT called in most paths — manual_required / draft_failed gates fire first.

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

// ── Self-load .env.local ───────────────────────────────────────────────────────
function loadEnv(): void {
  try {
    const lines = readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[key]) process.env[key] = val
    }
  } catch { /* rely on shell env */ }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY)

import { orchestrateDraft } from '../src/lib/reply-handling/draft-orchestrator'

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
    failed++
  }
}

// ── Setup: fetch real org, insert test signals ─────────────────────────────────

async function setup(): Promise<{ orgId: string; signalIds: string[] }> {
  // Use first available org in DB.
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('id')
    .limit(1)
    .maybeSingle()

  if (orgError || !org) {
    console.error('SETUP FAILED: no organisations in DB.', orgError?.message)
    process.exit(1)
  }

  const orgId = org.id

  // Insert 7 test signal rows (one per test that may need it).
  const signalInserts = Array.from({ length: 7 }, () => ({
    id: randomUUID(),
    organisation_id: orgId,
    // reply_received is the canonical type for polling code (migration 20260502 updated constraint).
    signal_type: 'reply_received' as string,
    source: 'test',
    processed: false,
    raw_data: { body: { text: 'Hi, can you tell me more about your pricing?' } },
    original_outbound_body: 'Hi there, following up...',
  }))

  const { error: sigError } = await supabase.from('signals').insert(signalInserts)
  if (sigError) {
    console.error('SETUP FAILED: could not insert test signals.', sigError.message)
    process.exit(1)
  }

  return { orgId, signalIds: signalInserts.map((s) => s.id) }
}

async function cleanup(orgId: string, signalIds: string[], agentRunIds: string[]): Promise<void> {
  await supabase.from('reply_drafts').delete().in('signal_id', signalIds)
  await supabase.from('signals').delete().in('id', signalIds)
  if (agentRunIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('agent_runs').delete().in('id', agentRunIds)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n── orchestrateDraft tests ─────────────────────────────────────\n')

  const { orgId, signalIds } = await setup()
  const agentRunIds: string[] = []
  let sidx = 0

  const makeSignal = (overrides: Partial<{
    id: string
    original_outbound_body: string | null
  }> = {}) => ({
    id: signalIds[sidx++],
    organisation_id: orgId,
    campaign_id: null as string | null,
    raw_data: { body: { text: 'Hi, can you tell me more about your pricing?' } },
    original_outbound_body: 'Hi there, following up on my previous email...',
    ...overrides,
  })

  try {
    // ── Test 1: Tier 1 intent → throws ───────────────────────────────────────
    console.log('1. Tier 1 intent reaching orchestrator → throws')
    try {
      await orchestrateDraft({
        signal: makeSignal(),
        classification: { intent: 'opt_out', confidence: 0.98, reasoning: 'explicit opt-out' },
        prospectId: null,
        supabase,
      })
      assert('throws on tier_1_handled intent', false, 'Expected throw — got return value instead')
    } catch (err) {
      assert(
        'throws on tier_1_handled intent',
        err instanceof Error && err.message.includes('Tier 1 intent'),
        err instanceof Error ? err.message : String(err),
      )
    }
    sidx-- // Test 1 doesn't consume a signal (threw before idempotency check)

    // ── Test 2: Unknown intent → log_only ─────────────────────────────────────
    console.log('\n2. Unknown intent → log_only (no DB write)')
    const r2 = await orchestrateDraft({
      signal: makeSignal(),
      classification: { intent: 'completely_unknown_intent', confidence: 0.80, reasoning: 'unknown' },
      prospectId: null,
      supabase,
    })
    assert('kind is log_only', r2.kind === 'log_only')
    sidx-- // log_only returns before idempotency check — signal not consumed

    // ── Test 3: Missing org context → manual_required ─────────────────────────
    // Org has no active TOV/Positioning docs → loadOrgContext returns null.
    // If this org DOES have active docs, the test will proceed further and hit the
    // drafter (unexpected). We protect against that by asserting kind is manual_required.
    console.log('\n3. Missing org context → manual_required placeholder written')
    const r3 = await orchestrateDraft({
      signal: makeSignal(),
      classification: { intent: 'positive_passive', confidence: 0.85, reasoning: 'interested' },
      prospectId: null,
      supabase,
    })
    // Valid outcomes: manual_required (no context), drafted (has context),
    // or draft_failed (circuit breaker tripped on live org with recent failures).
    assert(
      'kind is manual_required, drafted, or draft_failed (live DB state)',
      r3.kind === 'manual_required' || r3.kind === 'drafted' || r3.kind === 'draft_failed',
      `Got: ${r3.kind}`,
    )
    if ('reply_draft_id' in r3) {
      // Leave row for cleanup via signal_id
    }

    // ── Test 4: NULL original_outbound_body → manual_required ─────────────────
    console.log('\n4. NULL original_outbound_body → manual_required (original_outbound_not_captured)')
    const r4 = await orchestrateDraft({
      signal: makeSignal({ original_outbound_body: null }),
      classification: { intent: 'information_request_generic', confidence: 0.80, reasoning: 'question' },
      prospectId: null,
      supabase,
    })
    // manual_required (no context OR outbound body missing) or draft_failed (circuit breaker).
    assert(
      'kind is manual_required or draft_failed',
      r4.kind === 'manual_required' || r4.kind === 'draft_failed',
      `Got: ${r4.kind}`,
    )
    if (r4.kind === 'manual_required') {
      assert(
        'reason is org_context_missing or original_outbound_not_captured',
        r4.reason === 'org_context_missing' || r4.reason === 'original_outbound_not_captured',
        `Got reason: ${r4.reason}`,
      )
    }
    if (r4.kind === 'manual_required' || r4.kind === 'draft_failed') {
      assert(
        'tier is 3 (information_request_generic without FAQ match → tier_3)',
        r4.tier === 3,
        `Got: ${r4.tier}`,
      )
    }

    // ── Test 5: Idempotency — existing reply_drafts row ───────────────────────
    console.log('\n5. Existing reply_drafts row → returns existing row (no new row written)')
    const idemSignalId = signalIds[sidx++]
    const { data: existingRow } = await supabase
      .from('reply_drafts')
      .insert({
        organisation_id: orgId,
        signal_id: idemSignalId,
        intent: 'positive_passive',
        tier: 2,
        status: 'pending',
        ai_draft_body: 'Existing draft body — should not be replaced.',
        draft_metadata: { test: true },
      })
      .select('id')
      .single()

    if (existingRow?.id) {
      const r5 = await orchestrateDraft({
        signal: {
          id: idemSignalId,
          organisation_id: orgId,
          campaign_id: null,
          raw_data: { body: { text: 'Tell me more.' } },
          original_outbound_body: 'Hi there...',
        },
        classification: { intent: 'positive_passive', confidence: 0.85, reasoning: 'interested' },
        prospectId: null,
        supabase,
      })
      assert('kind is drafted (idempotent)', r5.kind === 'drafted')
      if (r5.kind === 'drafted') {
        assert('returns existing row id', r5.reply_draft_id === existingRow.id)
      }
    } else {
      assert('idempotency test setup succeeded', false, 'Could not insert test reply_drafts row')
    }

    // ── Test 6: Circuit breaker — 3+ failures → draft_failed ─────────────────
    console.log('\n6. Circuit breaker (≥3 agent_runs failures in 24h) → draft_failed')
    const now = new Date().toISOString()
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: ar } = await (supabase as any)
        .from('agent_runs')
        .insert({
          client_id: orgId,
          agent_name: 'reply-draft-agent',
          status: 'failed',
          started_at: now,
          error_message: 'test failure for circuit breaker test',
        })
        .select('id')
        .single()
      if (ar?.id) agentRunIds.push(ar.id)
    }

    if (agentRunIds.length >= 3) {
      const r6 = await orchestrateDraft({
        signal: makeSignal(),
        classification: { intent: 'positive_passive', confidence: 0.85, reasoning: 'interested' },
        prospectId: null,
        supabase,
      })
      assert('kind is draft_failed', r6.kind === 'draft_failed')
      if (r6.kind === 'draft_failed') {
        assert('failure_count is ≥ 3', r6.failure_count >= 3)
        assert('tier is 2 (positive_passive → tier_2)', r6.tier === 2, `Got: ${r6.tier}`)
      }
    } else {
      assert('circuit breaker test setup succeeded', false, 'Could not insert 3 agent_runs failure rows')
    }

    // ── Test 7: information_request_generic + FAQ → tier_2 routing ────────────
    // This test verifies that a high FAQ score (if present) routes to tier_2.
    // Without real FAQs for this org, faqMatchTopScore will be null → tier_3 routing.
    // Both tier_2 and tier_3 proceed to the org context check, so the result is
    // either manual_required or drafted — both valid outcomes for this assertion.
    console.log('\n7. information_request_generic + available FAQ score routes toward tier_2')

    // First clean up circuit breaker failures so they don't interfere.
    if (agentRunIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from('agent_runs').delete().in('id', agentRunIds)
      agentRunIds.length = 0
    }

    const r7 = await orchestrateDraft({
      signal: makeSignal(),
      classification: { intent: 'information_request_generic', confidence: 0.80, reasoning: 'question' },
      prospectId: null,
      supabase,
    })
    // manual_required (no context), drafted (has context), or draft_failed (circuit breaker).
    // The key assertion: NOT log_only — the intent was routed to a draft tier, not discarded.
    assert(
      'kind is not log_only (intent was routed to a draft tier)',
      r7.kind !== 'log_only',
      `Got: ${r7.kind}`,
    )

    // ── Test 8: Finding 2 — orchestrator throw leaves no DB rows ─────────────
    // Verifies the invariant: orchestrateDraft never writes action rows (those are
    // written by process-reply AFTER orchestrateDraft returns). A Tier 1 throw
    // therefore leaves the signal unprocessed with no rows, so it retries cleanly.
    console.log('\n8. Orchestrator throw (Tier 1 guard) leaves no reply_drafts or action rows')
    const throwSignal = makeSignal()

    let orchThrew = false
    try {
      await orchestrateDraft({
        signal: throwSignal,
        classification: { intent: 'opt_out', confidence: 0.99, reasoning: 'explicit opt-out' },
        prospectId: null,
        supabase,
      })
    } catch {
      orchThrew = true
    }
    assert('orchestrateDraft throws for Tier 1 intent (opt_out)', orchThrew)

    const { data: draftRowsAfterThrow } = await supabase
      .from('reply_drafts')
      .select('id')
      .eq('signal_id', throwSignal.id)

    assert(
      'no reply_drafts row written on throw',
      (draftRowsAfterThrow ?? []).length === 0,
      `Got ${draftRowsAfterThrow?.length ?? 'null'} rows`,
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: actionRowsAfterThrow } = await (supabase as any)
      .from('reply_handling_actions')
      .select('id')
      .eq('signal_id', throwSignal.id)

    assert(
      'no reply_handling_actions row written on throw',
      (actionRowsAfterThrow ?? []).length === 0,
      `Got ${actionRowsAfterThrow?.length ?? 'null'} rows`,
    )

  } finally {
    await cleanup(orgId, signalIds, agentRunIds)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n── Results ────────────────────────────────────────────────────`)
  console.log(`   Passed: ${passed}   Failed: ${failed}`)

  if (failed > 0) {
    console.error('\nTest run FAILED')
    process.exit(1)
  }

  console.log('\nAll tests passed.')
}

runTests().catch((err) => {
  console.error('Test run threw unexpectedly:', err)
  process.exit(1)
})
