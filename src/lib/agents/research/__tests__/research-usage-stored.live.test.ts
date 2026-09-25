// WHAT EVERY MODEL CALL COST REACHES A REAL ROW, ON EVERY PATH.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A LIVE TEST AND NOT A FAKE
//
// The defect being guarded is that the numbers were computed correctly and never inserted.
// ResearchResult.token_usage summed them, both production callers returned it, and nothing
// wrote it down: prospect_research_results has no usage column. A fake would have accepted
// an insert into a table that did not exist, which is the exact class of failure the live
// tier is for.
//
// And it goes through storeResearchResult, the function all four callers reach, rather than
// inserting into research_usage directly. Inserting directly would prove the table accepts
// jsonb and nothing about whether any path puts anything in it: both ends green, the hop
// untested, which is this project's own "half-tests cannot see a join".
//
// ONE CASE PER PATH, because `path` exists so that "every path records" is a query rather
// than an audit of call sites, and a column nobody has written all four values into cannot
// answer that question.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/agents/research/__tests__/research-usage-stored.live.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient, requireTestDatabaseCredentials } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { storeResearchResult } from '@/lib/agents/prospect-research-agent-v2'
import { RESEARCH_PATHS, type ResearchPath } from '@/lib/agents/research/types'
import type { OpeningResult } from '@/lib/agents/research/write-opening'

const STAMP = Date.now()

// DISTINCT NUMBERS IN EVERY SLOT, on purpose. If two stages shared a value, a write that
// put the opening usage into the synthesis column would still pass.
const SYNTHESIS_USAGE = {
  input_tokens: 1101, output_tokens: 12731,
  cache_creation_input_tokens: 1969, cache_read_input_tokens: 6808, calls: 1,
}
const OPENING_USAGE = {
  input_tokens: 3016, output_tokens: 6610,
  cache_creation_input_tokens: 3018, cache_read_input_tokens: 21421, calls: 5,
}
const FOLLOWUP_USAGE = {
  input_tokens: 2400, output_tokens: 310,
  cache_creation_input_tokens: 1800, cache_read_input_tokens: 4300, calls: 3,
}

const OPENING = {
  attempts: [],
  usage: OPENING_USAGE,
  followup_usage: FOLLOWUP_USAGE,
  opening: 'A researched observation that would ship.',
  observation: 'A researched observation that would ship.',
  bridge: null,
  question: 'Is that something you are working on?',
  subject: 'a subject',
  written_won: true,
  retry_used: false,
  retries_used: 0,
  strong_material: true,
  judge_reasoning: 'scaffolding',
  comparisons: [],
  gate_failures: [],
} as unknown as OpeningResult

/** The template arm: Email 1 lost, so no follow-up call was made and none was billed. */
const OPENING_NO_FOLLOWUPS = { ...OPENING, followup_usage: null } as unknown as OpeningResult

// The web-search source, with the token fields the handler returns and used to discard.
const RAW = {
  linkedin:   { available: false, error: 'not set' },
  apollo:     { available: false, error: 'not set' },
  website:    { available: false, error: 'not set' },
  web_search: {
    available: false, error: 'no substantive findings',
    providers: ['anthropic_native'], search_count: 3, result_count: 0,
    input_tokens: 9487, output_tokens: 368, model: 'claude-haiku-4-5-20251001',
  },
}

const SYNTHESIS = {
  usage: SYNTHESIS_USAGE,
  icp_fit: 'unassessed', has_dateable_signal: true, signal_observation: 'Scaffolding.',
  qualification_status: 'qualified', qualification_reason: null, icp_pain_proxy: null,
  trigger_source: 'research', reasoning: 'scaffolding', confidence: null, relevance_reason: null,
  candidates: [], selected_candidate_id: null, selection_reason: null, selection_basis: null,
  prospect_reason: null, prospect_reason_source: 'none', supporting_candidate_id: null,
}

let supabase: SupabaseClient<Database>
let orgId: string
let prospectId: string

/** Stores one result through the production write site and hands back its ledger row. */
async function storeAndReadBack(
  path: ResearchPath,
  opts: { synthesisBatched: boolean; opening?: OpeningResult } = { synthesisBatched: false },
) {
  const resultId = await storeResearchResult(
    { id: prospectId, organisation_id: orgId } as never,
    RAW as never,
    SYNTHESIS as never,
    null,
    opts.opening ?? OPENING,
    { path, synthesisBatched: opts.synthesisBatched },
  )
  const { data, error } = await supabase
    .from('research_usage')
    .select('*')
    .eq('research_result_id', resultId)
    .single()
  if (error) throw new Error(`no research_usage row for ${path}: ${error.message}`)
  return data as unknown as Record<string, unknown>
}

// See writer-attempts-stored.live.test.ts for why the poisoned env vars are restubbed with
// the TEST project's own credentials, and why that keeps the production-isolation guard.
beforeAll(async () => {
  const creds = requireTestDatabaseCredentials('research-usage-stored.live.test.ts')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', creds.url)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', creds.serviceRoleKey)

  supabase = createTestServiceClient('research-usage-stored.live.test.ts')
  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .insert({
      name: `Research Usage Test ${STAMP}`,
      slug: `research-usage-${STAMP}`,
      founder_first_name: 'Test',
    } as never)
    .select('id').single()
  if (orgErr || !org) throw new Error(`org insert failed: ${orgErr?.message}`)
  orgId = (org as { id: string }).id

  const { data: p, error: pErr } = await supabase
    .from('prospects').insert({ organisation_id: orgId } as never).select('id').single()
  if (pErr || !p) throw new Error(`prospect insert failed: ${pErr?.message}`)
  prospectId = (p as { id: string }).id
})

afterAll(async () => {
  if (orgId) await deleteTestOrganisations(supabase, [orgId], 'research-usage-stored.live.test.ts')
  vi.unstubAllEnvs()
})

describe('every path records what it spent', () => {
  // The CLI, the operator route, the queue's full_run executor and the Batch API's collect
  // phase. Four cases because the question is per path.
  it.each<[ResearchPath, boolean]>([
    ['cli', false],
    ['inline', false],
    ['queue', false],
    // The collect path's synthesis was billed on the Batch API at half price hours earlier.
    ['collect', true],
  ])('records a row for the %s path', async (path, batched) => {
    const row = await storeAndReadBack(path, { synthesisBatched: batched })

    expect(row.path).toBe(path)
    expect(row.synthesis_batched).toBe(batched)
    expect(row.organisation_id).toBe(orgId)
    expect(row.prospect_id).toBe(prospectId)
  })

  it('covers EVERY value the path column allows, so the column can answer the question', async () => {
    const { data } = await supabase
      .from('research_usage').select('path').eq('organisation_id', orgId)
    const seen = new Set((data ?? []).map(r => (r as { path: string }).path))
    // Derived from the exported union rather than a second hand-written list, so a new path
    // makes this fail until it is exercised above.
    for (const p of RESEARCH_PATHS) expect(seen.has(p)).toBe(true)
  })
})

describe('the stages round-trip separately', () => {
  it('stores synthesis, opening and follow-up usage in their own columns', async () => {
    const row = await storeAndReadBack('inline', { synthesisBatched: false })

    // Each asserted whole. A per-field check would pass while the columns were swapped.
    expect(row.synthesis).toEqual(SYNTHESIS_USAGE)
    expect(row.opening).toEqual(OPENING_USAGE)
    expect(row.followups).toEqual(FOLLOWUP_USAGE)

    // And they are genuinely different objects, which is what makes the three assertions
    // above meaningful rather than three readings of one value.
    expect(row.synthesis).not.toEqual(row.opening)
    expect(row.opening).not.toEqual(row.followups)
  })

  it('stores the web-search tokens AND the billable search count', async () => {
    const row = await storeAndReadBack('inline', { synthesisBatched: false })

    expect(row.web_search).toEqual({
      input_tokens: 9487,
      output_tokens: 368,
      model: 'claude-haiku-4-5-20251001',
      search_count: 3,
    })
  })

  it('keeps the web-search cost even though this fixture is an UNUSABLE result', async () => {
    // available: false in RAW. A query that ran, billed, and returned nothing usable is the
    // majority case on the native path, and it is the one whose cost used to vanish.
    const row = await storeAndReadBack('inline', { synthesisBatched: false })
    expect((row.web_search as { search_count: number }).search_count).toBe(3)
  })

  it('writes NULL follow-up usage on the template arm, not a zeroed object', async () => {
    // Absence is the signal: no call was paid for. Zeroes would say a call happened and
    // cost nothing, which is a different and false statement.
    const row = await storeAndReadBack('inline', {
      synthesisBatched: false, opening: OPENING_NO_FOLLOWUPS,
    })
    expect(row.followups).toBeNull()
    // The control: the rest of the row is still written, so the null above is about the
    // follow-up line and not about a row that failed to record anything.
    expect(row.synthesis).toEqual(SYNTHESIS_USAGE)
    expect(row.opening).toEqual(OPENING_USAGE)
  })
})

// The privileges are NOT tested here, deliberately. This file holds a service-role client,
// which can read the table by design, so it can only ever confirm the positive half. Anon
// and authenticated denial was read back from the catalog on both projects when the
// migration was applied, in both directions, and recorded in that commit. A test that
// asserted only the half it can see would be the "verification that reads only the role it
// hopes to see" that CLAUDE.md names as the entire failure mode.
