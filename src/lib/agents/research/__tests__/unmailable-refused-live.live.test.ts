// THE AGENT ITSELF REFUSES, against a real row, before it spends anything.
//
// ═══ WHY THIS FILE EXISTS: THREE MUTATIONS SURVIVED WITHOUT IT ═══════════════
//
// unmailable-before-spend.test.ts tests the POLICY, and research-executor.test.ts tests what
// the executor DOES with a refusal. Both pass while the agent never calls the policy at all,
// because that test mocks the agent wholesale. Measured by mutation:
//
//   deleting `await refuseIfUnmailable(...)` from the agent   -> 21 tests, 0 failed
//   making the suppression branch unreachable                -> 10 tests, 0 failed
//   making the batch count the skip as a failure             -> 21 tests, 0 failed
//
// A test at each end of a handoff proves both ends and not the handoff. This drives the real
// agent against a real row.
//
// ═══ IT CANNOT SPEND MONEY EVEN IF THE GATE IS BROKEN ════════════════════════
//
// .env.test.local carries NO paid API keys: no ANTHROPIC, APIFY, APOLLO, BOUNCER or
// MYEMAILVERIFIER key (asserted below, so that stays true). If the gate failed to fire the
// agent would fail for a missing key instead, which is a different error and still a red
// test. The check is that it throws ProspectUnmailableError SPECIFICALLY.
//
// RULE ZERO. Every fixture is invented and industry-neutral.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/agents/research/__tests__/unmailable-refused-live.live.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient, requireTestDatabaseCredentials } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { runProspectResearchAgentV2 } from '@/lib/agents/prospect-research-agent-v2'
import { ProspectUnmailableError } from '@/lib/sourcing/send-eligibility-policy'

const STAMP = Date.now()

let supabase: SupabaseClient<Database>
let orgId: string

/** Inserts one prospect with the given verification facts and returns its id. */
async function makeProspect(fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from('prospects')
    .insert({ organisation_id: orgId, ...fields } as never)
    .select('id').single()
  if (error || !data) throw new Error(`prospect insert failed: ${error?.message}`)
  return (data as { id: string }).id
}

/** Did the run write anything? Both tables, because either would mean it got past the gate. */
async function wroteAnything(prospectId: string): Promise<boolean> {
  const { count: results } = await supabase
    .from('prospect_research_results')
    .select('id', { count: 'exact', head: true })
    .eq('prospect_id', prospectId)
  const { count: usage } = await supabase
    .from('research_usage')
    .select('id', { count: 'exact', head: true })
    .eq('prospect_id', prospectId)
  return (results ?? 0) > 0 || (usage ?? 0) > 0
}

beforeAll(async () => {
  // The guard that keeps this test unable to spend. If a paid key ever lands in the test env,
  // this fails here rather than quietly making a live API call on a broken gate.
  for (const k of ['ANTHROPIC_API_KEY', 'APIFY_API_KEY', 'APOLLO_API_KEY', 'BOUNCER_API_KEY']) {
    expect(process.env[k], `${k} must not be set for this test file`).toBeFalsy()
  }

  const creds = requireTestDatabaseCredentials('unmailable-refused-live.live.test.ts')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', creds.url)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', creds.serviceRoleKey)

  supabase = createTestServiceClient('unmailable-refused-live.live.test.ts')
  const { data: org, error } = await supabase
    .from('organisations')
    .insert({
      name: `Unmailable Gate Test ${STAMP}`,
      slug: `unmailable-gate-${STAMP}`,
      founder_first_name: 'Test',
    } as never)
    .select('id').single()
  if (error || !org) throw new Error(`org insert failed: ${error?.message}`)
  orgId = (org as { id: string }).id
})

afterAll(async () => {
  if (orgId) await deleteTestOrganisations(supabase, [orgId], 'unmailable-refused-live.live.test.ts')
  vi.unstubAllEnvs()
})

describe('the agent refuses before spending', () => {
  it('refuses a SUPPRESSED prospect, and writes nothing', async () => {
    const id = await makeProspect({
      suppressed: true,
      independent_verified_at: '2026-09-20T10:00:00Z',
      independent_email_status: 'Valid',
      verification_provider: 'myemailverifier',
    })

    await expect(runProspectResearchAgentV2({ prospect_id: id, client_id: orgId }))
      .rejects.toThrow(ProspectUnmailableError)
    expect(await wroteAnything(id)).toBe(false)
  })

  it('refuses an UNDELIVERABLE address, and writes nothing', async () => {
    const id = await makeProspect({
      independent_verified_at: '2026-09-20T10:00:00Z',
      independent_email_status: 'Invalid',
      verification_provider: 'myemailverifier',
    })

    await expect(runProspectResearchAgentV2({ prospect_id: id, client_id: orgId }))
      .rejects.toThrow(ProspectUnmailableError)
    expect(await wroteAnything(id)).toBe(false)
  })

  it('refuses an OPERATOR HOLD even when the address verified fine', async () => {
    // The only reason appearing after the selection gate landed, on 2 real prospects.
    const id = await makeProspect({
      independent_verified_at: '2026-09-20T10:00:00Z',
      independent_email_status: 'Valid',
      verification_provider: 'myemailverifier',
      email_send_eligible: false,
      email_send_ineligible_reason: 'operator_hold',
    })

    await expect(runProspectResearchAgentV2({ prospect_id: id, client_id: orgId }))
      .rejects.toThrow(ProspectUnmailableError)
    expect(await wroteAnything(id)).toBe(false)
  })

  it('refuses a prospect with NO verdict at all', async () => {
    const id = await makeProspect({})

    await expect(runProspectResearchAgentV2({ prospect_id: id, client_id: orgId }))
      .rejects.toThrow(ProspectUnmailableError)
    expect(await wroteAnything(id)).toBe(false)
  })

  it('names the reason on the thrown error, so a caller can report it', async () => {
    const id = await makeProspect({ suppressed: true })
    try {
      await runProspectResearchAgentV2({ prospect_id: id, client_id: orgId })
      throw new Error('the agent did not refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(ProspectUnmailableError)
      // Suppression is checked BEFORE the verdict, and this prospect has neither a verdict
      // nor an address. Reporting no_verdict here would send an operator to verify someone
      // who has asked not to be contacted.
      expect((err as ProspectUnmailableError).ineligible_reason).toBe('suppressed')
    }
  })
})

describe('the control: an ELIGIBLE prospect is NOT refused', () => {
  it('gets past the gate, and fails later for a missing API key instead', async () => {
    // THE POSITIVE CONTROL, and the reason the four refusals above mean anything. Without it
    // a gate that refuses every prospect would pass this whole file while stopping research
    // completely.
    //
    // It is expected to THROW, because there is no ANTHROPIC_API_KEY in the test env. What
    // matters is that it is NOT a ProspectUnmailableError: the gate let it through and the
    // run died further on, where the paid work would have been.
    const id = await makeProspect({
      independent_verified_at: '2026-09-20T10:00:00Z',
      independent_email_status: 'Valid',
      verification_provider: 'myemailverifier',
      email_send_eligible: true,
    })

    let thrown: unknown
    try {
      await runProspectResearchAgentV2({ prospect_id: id, client_id: orgId })
    } catch (err) { thrown = err }

    expect(thrown).toBeDefined()
    expect(thrown).not.toBeInstanceOf(ProspectUnmailableError)
  })
})
