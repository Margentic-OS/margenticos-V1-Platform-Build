// THE WRITER-STOPPED LIST, PROVED AGAINST THE REAL DATABASE.
//
// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/writer-stopped.live.test.ts
//
// A live test and not a fake, because the property is a JSON-path filter that PostgREST
// evaluates (trigger_data->judge->>not_written_reason). A fake would have to implement that
// path to test it, and a fake that got it wrong would go green whether the filter worked or
// not, which is the failure CLAUDE.md records three times.
//
// THE CASE THAT MATTERS is the second prospect: its written opening LOST, so it ships the
// same approved template as a stopped one. The list must tell the two apart, or the decision
// it exists to surface is still invisible.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisation } from '@/test-utils/delete-test-organisations'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import { listWriterStoppedProspects } from '../writer-stopped'

const CONTEXT = 'writer-stopped.live.test.ts'
let supabase: SupabaseClient<Database>
let orgId: string
let otherOrgId: string

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function makeOrg(name: string): Promise<string> {
  const { data, error } = await supabase
    .from('organisations')
    .insert({ name, slug: `writer-stopped-${stamp()}` })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function makeProspect(organisation_id: string, first_name: string, trigger_data: Json | null): Promise<void> {
  const { error } = await supabase.from('prospects').insert({
    organisation_id,
    email: `writer-stopped-${stamp()}@example.com`,
    first_name,
    last_name: 'Test',
    company_name: `${first_name} Co`,
    job_title: 'Founder',
    trigger_data,
    research_ran_at: new Date().toISOString(),
  })
  if (error) throw error
}

beforeEach(async () => {
  supabase = createTestServiceClient(CONTEXT)
  orgId = await makeOrg('Writer Stopped Test Org')
  otherOrgId = await makeOrg('Writer Stopped Other Org')
  // Stopped. The only one that may be listed.
  await makeProspect(orgId, 'Stopped', {
    relevance_reason: 'Nothing found connects to what the client solves.',
    judge: { not_written_reason: 'no_usable_candidate', written_won: false, judge_reasoning: 'Not written.' },
  })
  // Written, and the template won. Ships the same email, was NOT stopped.
  await makeProspect(orgId, 'Lost', {
    relevance_reason: 'Relevant.',
    judge: { written_won: false, judge_reasoning: 'The template read better.' },
  })
  // Never researched.
  await makeProspect(orgId, 'Unresearched', null)
  // Stopped, but in another organisation.
  await makeProspect(otherOrgId, 'Elsewhere', { judge: { not_written_reason: 'no_usable_candidate' } })
})

afterEach(async () => {
  await deleteTestOrganisation(supabase, orgId, CONTEXT)
  await deleteTestOrganisation(supabase, otherOrgId, CONTEXT)
})

describe('listWriterStoppedProspects, against the real database', () => {
  it('lists the stopped prospect and nothing else, with its company, title and research note', async () => {
    const r = await listWriterStoppedProspects(asServiceRoleClient(supabase), orgId)
    if (!r.ok) throw new Error(r.error)
    expect(r.prospects.map(p => p.name)).toEqual(['Stopped Test'])
    expect(r.prospects[0]).toMatchObject({
      company_name: 'Stopped Co',
      job_title: 'Founder',
      synthesis_note: 'Nothing found connects to what the client solves.',
    })
  }, 30_000)

  it('does not list a prospect whose written opening lost, although it ships the same template', async () => {
    const r = await listWriterStoppedProspects(asServiceRoleClient(supabase), orgId)
    if (!r.ok) throw new Error(r.error)
    expect(r.prospects.some(p => p.name === 'Lost Test')).toBe(false)
  }, 30_000)

  it("never lists another organisation's stopped prospect", async () => {
    const r = await listWriterStoppedProspects(asServiceRoleClient(supabase), orgId)
    if (!r.ok) throw new Error(r.error)
    expect(r.prospects.some(p => p.name === 'Elsewhere Test')).toBe(false)
  }, 30_000)
})
