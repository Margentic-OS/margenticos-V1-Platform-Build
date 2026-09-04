// The stop button's scope, proven against a real database.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS AN INTEGRATION TEST AND NOT A FAKE
//
// The entire behaviour under test is a WHERE clause: cancel research jobs for this
// organisation that are still queued, and nothing else. CLAUDE.md's own account of the
// three fakes found on 2026-08-26 is exactly this shape: a fake honours the filters its
// author was thinking about and silently accepts the rest, so removing a filter from the
// real query fails nothing. Here that would mean a stop button that cancelled another
// client's work, or cancelled jobs a worker was already running, with a green suite.
//
// So the rows are real, the UPDATE is real, and the assertions read the database back.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/queue/__tests__/cancel-research.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { cancelQueuedResearchJobs, countQueuedResearchJobs } from '../job-queue'

const STAMP = Date.now()

let supabase: SupabaseClient<Database>
let orgId: string
let otherOrgId: string

async function makeOrg(suffix: string): Promise<string> {
  const { data, error } = await supabase
    .from('organisations')
    .insert({
      name: `Cancel Research Test ${suffix} ${STAMP}`,
      slug: `cancel-research-${suffix}-${STAMP}`,
      founder_first_name: 'Test',
    } as never)
    .select('id')
    .single()
  if (error || !data) throw new Error(`org insert failed: ${error?.message}`)
  return (data as { id: string }).id
}

async function makeProspect(organisationId: string): Promise<string> {
  const { data, error } = await supabase
    .from('prospects')
    .insert({ organisation_id: organisationId } as never)
    .select('id')
    .single()
  if (error || !data) throw new Error(`prospect insert failed: ${error?.message}`)
  return (data as { id: string }).id
}

/**
 * Insert one job directly.
 *
 * Not through enqueue_job, deliberately: that function refuses a second live job for the
 * same (job_type, prospect_id), and these fixtures need specific states rather than a
 * realistic history. job_queue_claim_fields_consistent is a real CHECK, so a claimed row
 * gets a holder and a lease or the database refuses it.
 */
async function makeJob(
  organisationId: string,
  jobType: string,
  state: string,
): Promise<{ id: string; jobType: string; state: string }> {
  const prospectId = await makeProspect(organisationId)
  const claimed = state === 'claimed'
  const { data, error } = await supabase
    .from('job_queue')
    .insert({
      job_type: jobType,
      organisation_id: organisationId,
      prospect_id: prospectId,
      state,
      enqueued_by: 'cancel-research-test',
      claimed_by: claimed ? 'worker-under-test' : null,
      lease_expires_at: claimed ? new Date(Date.now() + 300_000).toISOString() : null,
      last_error: state === 'failed' ? 'fixture' : null,
    } as never)
    .select('id')
    .single()
  if (error || !data) throw new Error(`job insert failed (${jobType}/${state}): ${error?.message}`)
  return { id: (data as { id: string }).id, jobType, state }
}

async function stateOf(jobId: string): Promise<string> {
  const { data, error } = await supabase
    .from('job_queue').select('state').eq('id', jobId).single()
  if (error || !data) throw new Error(`read back failed: ${error?.message}`)
  return (data as { state: string }).state
}

beforeAll(async () => {
  supabase = createTestServiceClient('cancel-research.test.ts')
  orgId = await makeOrg('main')
  otherOrgId = await makeOrg('other')
}, 60_000)

afterAll(async () => {
  // job_queue cascades from both organisations and prospects; the helper clears
  // prospects and then the organisations.
  await deleteTestOrganisations(supabase, [orgId, otherOrgId], 'cancel-research.test.ts')
}, 60_000)

describe('cancelQueuedResearchJobs', () => {
  it('cancels queued research and leaves everything else exactly where it was', async () => {
    const queuedResearch  = await makeJob(orgId, 'research', 'queued')
    const queuedSources   = await makeJob(orgId, 'research_sources', 'queued')
    const queuedCollect   = await makeJob(orgId, 'research_collect', 'queued')

    // MUST SURVIVE. A worker is inside its calls; the money is committed and nothing here
    // can reach the running executor. complete_job and fail_job are both scoped to
    // state = 'claimed', so flipping this row would leave a job that says cancelled about
    // work that completed.
    const claimedResearch = await makeJob(orgId, 'research', 'claimed')

    // MUST SURVIVE. A different job type entirely.
    const queuedEnrich    = await makeJob(orgId, 'enrich', 'queued')

    // MUST SURVIVE. A different client. This is the assertion that matters most: agent
    // isolation is enforced at three levels and an operator control is not exempt.
    const otherOrgQueued  = await makeJob(otherOrgId, 'research', 'queued')

    // MUST SURVIVE. Terminal states are history, not work.
    const doneResearch    = await makeJob(orgId, 'research', 'done')

    expect(await countQueuedResearchJobs(supabase, orgId)).toBe(3)

    const cancelled = await cancelQueuedResearchJobs(supabase, orgId)
    expect(cancelled).toBe(3)

    expect(await stateOf(queuedResearch.id)).toBe('cancelled')
    expect(await stateOf(queuedSources.id)).toBe('cancelled')
    expect(await stateOf(queuedCollect.id)).toBe('cancelled')

    expect(await stateOf(claimedResearch.id)).toBe('claimed')
    expect(await stateOf(queuedEnrich.id)).toBe('queued')
    expect(await stateOf(otherOrgQueued.id)).toBe('queued')
    expect(await stateOf(doneResearch.id)).toBe('done')

    // And the count the button renders now reflects it.
    expect(await countQueuedResearchJobs(supabase, orgId)).toBe(0)
    expect(await countQueuedResearchJobs(supabase, otherOrgId)).toBe(1)
  }, 90_000)

  it('cancelling twice is a no-op, not an error', async () => {
    // The button is clickable while a request is in flight on a slow connection, and a
    // double click must not fail. There is nothing left in 'queued' the second time, so the
    // same WHERE clause simply matches nothing.
    expect(await cancelQueuedResearchJobs(supabase, orgId)).toBe(0)
  }, 60_000)

  it('a cancelled job frees its prospect, because liveness is queued-or-claimed', async () => {
    // job_queue_one_live_research_per_prospect is partial on ('queued','claimed'), so a
    // cancelled row is not live and the prospect can be enqueued again. That is what makes
    // stopping recoverable rather than a dead end, and it is a property of the index rather
    // than of any TypeScript, so it is asserted against the database.
    const prospectId = await makeProspect(orgId)
    const { data: first, error: firstError } = await supabase.rpc('enqueue_job', {
      p_job_type: 'research', p_organisation_id: orgId, p_prospect_id: prospectId,
      p_enqueued_by: 'test', p_max_attempts: 2,
    })
    expect(firstError).toBeNull()
    expect((first as unknown[]).length).toBe(1)

    await cancelQueuedResearchJobs(supabase, orgId)

    const { data: second, error: secondError } = await supabase.rpc('enqueue_job', {
      p_job_type: 'research', p_organisation_id: orgId, p_prospect_id: prospectId,
      p_enqueued_by: 'test', p_max_attempts: 2,
    })
    expect(secondError).toBeNull()
    expect((second as unknown[]).length).toBe(1)

    await cancelQueuedResearchJobs(supabase, orgId)
  }, 90_000)
})
