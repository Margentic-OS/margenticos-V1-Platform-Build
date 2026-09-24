// THE VALUE LANDS ON A REAL ROW, not only on a type.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS AN INTEGRATION TEST AND NOT A FAKE.
//
// prospect_reason_source existed on SynthesisOutput for a day with no column and no write
// site. tsc was silent, every unit test passed, and the only way to read a run's fallback
// split was to grep the run log. A fake Supabase client would have accepted the insert
// exactly as happily with the column missing, because a fake accepts the fields its author
// was thinking about and silently drops the rest. That is this project's own account of the
// three fakes found on 2026-08-26, and it is the specific defect this file exists to catch.
//
// So the insert is real, the column is real, and the assertion reads the database back.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/agents/research/__tests__/prospect-reason-source.live.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

const STAMP = Date.now()
const SOURCES = ['prospect', 'trigger', 'relevance_fallback', 'none'] as const

let supabase: SupabaseClient<Database>
let orgId: string
let prospectId: string

beforeAll(async () => {
  supabase = createTestServiceClient('prospect-reason-source.live.test.ts')
  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .insert({
      name: `Prospect Reason Source Test ${STAMP}`,
      slug: `prospect-reason-source-${STAMP}`,
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
  if (orgId) await deleteTestOrganisations(supabase, [orgId], 'prospect-reason-source.live.test.ts')
})

describe('prospect_reason_source is a real column that accepts every value the type declares', () => {
  it.each(SOURCES)('stores and reads back %s', async (source) => {
    const { data, error } = await supabase
      .from('prospect_research_results')
      .insert({
        prospect_id: prospectId,
        organisation_id: orgId,
        prospect_reason: source === 'none' ? null : `A reason recorded as ${source}.`,
        prospect_reason_source: source,
      } as never)
      .select('*')
      .single()

    // A MISSING COLUMN FAILS HERE, loudly, with PostgREST naming it. That is the whole
    // point: the insert is what a fake would have swallowed.
    expect(error, error ? `insert failed: ${error.message}` : '').toBeNull()
    expect(data).toBeTruthy()
    expect((data as unknown as { prospect_reason_source: string }).prospect_reason_source).toBe(source)
  })

  it('accepts a row with no source at all, so rows written before the column still read', async () => {
    const { data, error } = await supabase
      .from('prospect_research_results')
      .insert({ prospect_id: prospectId, organisation_id: orgId } as never)
      .select('*').single()
    expect(error).toBeNull()
    expect((data as unknown as { prospect_reason_source: string | null }).prospect_reason_source).toBeNull()
  })

  it('POSITIVE CONTROL: a column that does NOT exist is rejected', async () => {
    // Without this, every assertion above would pass just as happily against a client that
    // accepted anything, and the file would prove nothing about the schema.
    const { error } = await supabase
      .from('prospect_research_results')
      .insert({ prospect_id: prospectId, organisation_id: orgId, definitely_not_a_column: 'x' } as never)
      .select('id').single()
    expect(error).not.toBeNull()
  })
})
