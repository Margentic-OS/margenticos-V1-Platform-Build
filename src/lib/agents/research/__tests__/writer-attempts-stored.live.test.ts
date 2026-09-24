// EVERY WRITER ATTEMPT REACHES A REAL ROW, through the real production write site.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS CALLS storeResearchResult RATHER THAN INSERTING THE ARRAY ITSELF.
//
// The field is reported by a callback that existed for weeks with no production caller, so
// the attempt text lived inside the writer's loop and was overwritten by the next
// iteration. A test that inserted the array directly would prove the COLUMN accepts JSONB
// and nothing about whether the agent ever puts anything in it: both ends green, the hop
// untested, which is this project's own "half-tests cannot see a join".
//
// So this calls the function both production callers reach, with a real OpeningResult, and
// reads the database back.
//
// A FAKE WOULD PASS WITH THE COLUMN MISSING. That is the specific defect the live tier
// exists for: a fake accepts the fields its author was thinking about and silently drops
// the rest.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/agents/research/__tests__/writer-attempts-stored.live.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient, requireTestDatabaseCredentials } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { storeResearchResult } from '@/lib/agents/prospect-research-agent-v2'
import type { AttemptObservation, OpeningResult } from '@/lib/agents/research/write-opening'

const STAMP = Date.now()

// THE THREE WAYS AN ATTEMPT CAN END, one each, because the column is only useful if it can
// tell them apart. A 'gated' attempt carries deterministic failures and no judge verdict; a
// 'floored' attempt carries neither; a 'compared' attempt carries the judge's verdict and
// its reasoning. Built as AttemptObservation so a renamed member is a compile error here.
const ATTEMPTS: AttemptObservation[] = [
  {
    attempt: 0,
    kind: 'gated',
    gate_failures: [
      'the observation is 26 words, and the observation cap is 24: cut a fact rather than compressing the sentence, and let the bridge carry the reason',
      'the bridge has a sentence of 19 words, and the writer cap is 18: shorten it. The bridge stays ONE sentence, so cut words rather than adding a break',
    ],
    observation: 'You opened a second site in March. The listing went up the same week and has not moved since then at all.',
    bridge: 'Operators at that point usually find the next month of work is the part nobody owns until it is late.',
    question: 'Is that something you are working on?',
    subject: 'second site',
    subject_discarded: null,
    judge_reasoning: null,
    judge_written_won: null,
  },
  {
    attempt: 1,
    kind: 'floored',
    gate_failures: [],
    observation: 'You opened a second site in March.',
    bridge: 'Operators at that point usually find the next month of work is the part nobody owns.',
    question: 'Is that something you are working on?',
    subject: '',
    subject_discarded: 'a subject its own soft gate threw away',
    judge_reasoning: null,
    judge_written_won: null,
  },
  {
    attempt: 2,
    kind: 'compared',
    gate_failures: [],
    observation: 'You opened a second site in March.',
    bridge: 'Operators at that point usually find the next month of work is the part nobody owns.',
    question: 'Is filling it something you are working on?',
    subject: 'second site',
    subject_discarded: null,
    judge_reasoning: 'The written version names a dateable event the template cannot, so it opens on something only this reader could have been sent.',
    judge_written_won: true,
  },
]

const OPENING = {
  attempts: ATTEMPTS,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  opening: 'You opened a second site in March.\n\nOperators at that point usually find the next month of work is the part nobody owns.',
  observation: 'You opened a second site in March.',
  bridge: 'Operators at that point usually find the next month of work is the part nobody owns.',
  question: 'Is filling it something you are working on?',
  subject: 'second site',
  written_won: true,
  retry_used: true,
  retries_used: 2,
  strong_material: true,
  judge_reasoning: ATTEMPTS[2].judge_reasoning,
  comparisons: [],
  gate_failures: [],
} as unknown as OpeningResult

const RAW = {
  linkedin:   { available: false, error: 'not set' },
  apollo:     { available: false, error: 'not set' },
  website:    { available: false, error: 'not set' },
  web_search: { available: false, error: 'not set', search_count: 0 },
}

// The NOT NULL columns carry values their CHECK constraints accept. They are scaffolding
// for the one field this file is about, and are named rather than left null because
// storeResearchResult passes each one through explicitly, and an explicit null overrides a
// column default rather than falling back to it.
const SYNTHESIS = {
  icp_fit: 'unassessed', has_dateable_signal: true, signal_observation: 'A second site opened in March.',
  qualification_status: 'qualified', qualification_reason: null, icp_pain_proxy: null,
  trigger_source: 'research', reasoning: 'scaffolding', confidence: null, relevance_reason: null,
  candidates: [], selected_candidate_id: null, selection_reason: null, selection_basis: null,
  prospect_reason: null, prospect_reason_source: 'none', supporting_candidate_id: null,
}

let supabase: SupabaseClient<Database>
let orgId: string
let prospectId: string

// ═════════════════════════════════════════════════════════════════════════════
// POINTING THE AGENT'S OWN CLIENT AT THE TEST DATABASE, AND WHY THAT IS SAFE.
//
// vitest.setup.ts deliberately POISONS NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY with an unusable .invalid host, so that application code, which
// builds its own client from the ambient environment, cannot reach a real database during a
// test run. That guard exists because this suite once reached PRODUCTION through exactly
// such a fallback, and it is not being defeated here.
//
// storeResearchResult is application code and builds its client that way, so the only way to
// exercise the real write site is to give those variables a value. They are set to the TEST
// project's own credentials, obtained through requireTestDatabaseCredentials, which refuses
// anything that is not an allowlisted test database, and they are restored afterwards. The
// poison's purpose is that the value must not be production; this keeps that property and
// gives up nothing else.
//
// If the credentials are absent the helper throws by name and this file fails loudly. It
// never falls back.
const POISONED = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
}

beforeAll(async () => {
  const creds = requireTestDatabaseCredentials('writer-attempts-stored.live.test.ts')
  process.env.NEXT_PUBLIC_SUPABASE_URL = creds.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = creds.serviceRoleKey

  supabase = createTestServiceClient('writer-attempts-stored.live.test.ts')
  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .insert({
      name: `Writer Attempts Test ${STAMP}`,
      slug: `writer-attempts-${STAMP}`,
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
  if (orgId) await deleteTestOrganisations(supabase, [orgId], 'writer-attempts-stored.live.test.ts')
  // Restored rather than left set, so nothing that runs after this file in the same worker
  // inherits a live client the poison was there to deny it.
  process.env.NEXT_PUBLIC_SUPABASE_URL = POISONED.url
  process.env.SUPABASE_SERVICE_ROLE_KEY = POISONED.key
})

describe('storeResearchResult persists every writer attempt', () => {
  let stored: AttemptObservation[]

  beforeAll(async () => {
    const resultId = await storeResearchResult(
      { id: prospectId, organisation_id: orgId } as never,
      RAW as never,
      SYNTHESIS as never,
      null,
      OPENING,
    )
    const { data, error } = await supabase
      .from('prospect_research_results')
      .select('writer_attempts')
      .eq('id', resultId)
      .single()
    if (error) throw new Error(`read back failed: ${error.message}`)
    stored = (data as unknown as { writer_attempts: AttemptObservation[] }).writer_attempts
  })

  it('stores one element per attempt, in order', () => {
    expect(stored).toHaveLength(ATTEMPTS.length)
    expect(stored.map(a => a.attempt)).toEqual([0, 1, 2])
    expect(stored.map(a => a.kind)).toEqual(['gated', 'floored', 'compared'])
  })

  it('carries the gate failures verbatim, which is the thing that could not be read before', () => {
    expect(stored[0].gate_failures).toEqual(ATTEMPTS[0].gate_failures)
    // Named individually, because an assertion on the array alone would pass on an array of
    // empty strings if the round trip mangled them.
    expect(stored[0].gate_failures[0]).toContain('the observation cap is 24')
    expect(stored[0].gate_failures[1]).toContain('The bridge stays ONE sentence')
  })

  it('carries the FLOOR verdict as a kind, with no gates and no judge', () => {
    expect(stored[1].kind).toBe('floored')
    expect(stored[1].gate_failures).toEqual([])
    expect(stored[1].judge_reasoning).toBeNull()
    expect(stored[1].judge_written_won).toBeNull()
    // The floored attempt's discarded subject survives, which is the field that says WHY a
    // subject is missing rather than only that it is.
    expect(stored[1].subject_discarded).toBe('a subject its own soft gate threw away')
  })

  it('carries the JUDGE verdict with its reasoning', () => {
    expect(stored[2].judge_written_won).toBe(true)
    expect(stored[2].judge_reasoning).toBe(ATTEMPTS[2].judge_reasoning)
  })

  it('carries the text of every attempt, including the ones that were thrown away', () => {
    // THE POINT OF THE COLUMN. Attempt 0 shipped nothing and its words used to be
    // unrecoverable; a verdict with no text behind it can be counted and not read.
    expect(stored[0].observation).toBe(ATTEMPTS[0].observation)
    expect(stored[0].bridge).toBe(ATTEMPTS[0].bridge)
    expect(stored[0].question).toBe(ATTEMPTS[0].question)
  })

  it('POSITIVE CONTROL: the column really is a column, and a wrong one is rejected', () => {
    // Without this the file would pass just as happily against a client that accepted
    // anything, and would prove nothing about the schema.
    return supabase
      .from('prospect_research_results')
      .insert({ prospect_id: prospectId, organisation_id: orgId, writer_attempts_typo: [] } as never)
      .select('id').single()
      .then(({ error }) => expect(error).not.toBeNull())
  })

  it('POSITIVE CONTROL: a row written without attempts reads back NULL, not an empty array', () => {
    // The two mean different things: NULL is "written before the column existed" and []
    // would be "the writer ran and made no attempt". A DEFAULT would have erased that.
    return supabase
      .from('prospect_research_results')
      .insert({ prospect_id: prospectId, organisation_id: orgId } as never)
      .select('writer_attempts').single()
      .then(({ data, error }) => {
        expect(error).toBeNull()
        expect((data as unknown as { writer_attempts: unknown }).writer_attempts).toBeNull()
      })
  })
})
