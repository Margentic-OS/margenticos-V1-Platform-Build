// Does an intake edit actually flag the live document, against a real database.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run \
//     src/lib/intake/__tests__/flag-stale-documents.live.test.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE HAD TO BE A LIVE TEST
//
// The flagging mechanism shipped 2026-09-04 and flagged NOTHING, in production, for
// seventeen days. Measured 2026-09-21: zero documents in the entire production database
// have ever carried an intake stale_reason. Both copies of the code were correct as
// TypeScript and dead as behaviour, because they ran the UPDATE through the caller's own
// session client and strategy_documents grants a client SELECT and nothing else. RLS
// filtered every row out of the UPDATE, PostgREST returned success having changed nothing,
// and no log line said so.
//
// NO TEST WITH A FAKE DATABASE CAN CATCH THAT. A fake honours the filter chain and returns
// success, which is precisely what the real database did. The suite was green in both
// worlds. The only instrument that can tell those worlds apart is a real Postgres with the
// real policies on it, so that is what this file uses.
//
// The tests that existed asserted the map (field -> document) and the comparison (what
// changed) in isolation, and a comment in document-staleness.test.ts asserted the join
// between them in PROSE: "the write path already calls the flagging helper". It did. The
// call did nothing. A sentence is not a test.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE CLIENT-ROLE SESSION IS REAL, NOT SIMULATED
//
// asClient below is a genuine `authenticated` JWT for a genuine users row with
// role = 'client'. It is minted from the service-role key the suite already has:
// admin.createUser, then signInWithPassword, then a client that presents that user's
// access token on Authorization. PostgREST resolves the role from that token, so requests
// through it run under exactly the policies a real client gets. No extra credential, and
// nothing about the privilege question is stubbed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  createTestServiceClient,
  bridgeEnvForSelfClientingModules,
  requireTestDatabaseCredentials,
} from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import {
  flagDocumentsStaleForIntakeEdit,
  flagDocumentsStaleForIntakeEditSafely,
} from '@/lib/intake/flag-stale-documents'
import { INTAKE_STALE_PREFIX, isIntakeAnswerEdit } from '@/lib/intake/document-staleness'
import {
  readBuyerProfileRow,
  writeBuyerProfile,
  changedBuyerProfileFields,
} from '@/lib/intake/buyer-profile-store'
import { EMPTY_BUYER_PROFILE, type BuyerProfile } from '@/lib/intake/buyer-profile'

const CONTEXT = 'flag-stale-documents.live.test.ts'

// intake_buyer_profile is NOT in the generated Database type: src/types/database.ts predates
// the table. buyer-profile-store.ts works around the same gap with its own casts. Same
// untyped escape hatch as delete-test-organisations.ts uses, and no wider than it needs.

let service: SupabaseClient<Database>
let untyped: SupabaseClient
let orgA: string
let orgB: string
let clientUserId: string
/** A real authenticated session for a role = 'client' user belonging to orgA. */
let asClient: SupabaseClient<Database>

/** The answers this organisation starts each test with. A real, already-answered profile. */
const STORED_PROFILE: BuyerProfile = {
  ...EMPTY_BUYER_PROFILE,
  target_countries: ['United Kingdom'],
  buyer_job_titles: ['Director'],
  signoff_required: true,
  signoff_role: 'Finance lead',
  disqualifiers: [],
}

async function seedOrganisation(label: string): Promise<string> {
  const { data, error } = await service
    .from('organisations')
    .insert({ name: `${label} ${Date.now()}`, slug: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id
}

async function seedActiveIcp(organisationId: string): Promise<void> {
  const { error } = await service.from('strategy_documents').insert({
    organisation_id: organisationId,
    document_type: 'icp',
    status: 'active',
    version: '1',
    is_stale: false,
    stale_reason: null,
  })
  expect(error).toBeNull()
}

async function readIcp(organisationId: string) {
  const { data, error } = await service
    .from('strategy_documents')
    .select('is_stale, stale_reason')
    .eq('organisation_id', organisationId)
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .single()
  expect(error).toBeNull()
  return data!
}

beforeAll(async () => {
  service = createTestServiceClient(CONTEXT)
  untyped = service as SupabaseClient
  // flagDocumentsStaleForIntakeEditSafely builds its OWN service-role client, deliberately,
  // so no call site can hand it a session client. That means it reads the production
  // variable NAMES, which vitest.setup.ts deletes. Point them at the TEST database.
  bridgeEnvForSelfClientingModules(CONTEXT)

  orgA = await seedOrganisation('flagstale-a')
  orgB = await seedOrganisation('flagstale-b')

  const email = `flagstale-client-${Date.now()}@test.local`
  const password = 'TestPassword123!'
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  expect(authError).toBeNull()
  clientUserId = authUser!.user!.id

  const { error: userError } = await service.from('users').insert({
    id: clientUserId,
    email: authUser!.user!.email!,
    role: 'client',
    organisation_id: orgA,
  })
  expect(userError).toBeNull()

  const { url, serviceRoleKey } = requireTestDatabaseCredentials(CONTEXT)
  const { data: signIn, error: signInError } = await service.auth.signInWithPassword({
    email, password,
  })
  expect(signInError).toBeNull()
  await service.auth.signOut()

  asClient = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${signIn!.session!.access_token}` } },
  })
})

afterAll(async () => {
  if (clientUserId) {
    await service.from('users').delete().eq('id', clientUserId)
    await service.auth.admin.deleteUser(clientUserId)
  }
  await deleteTestOrganisations(service, [orgA, orgB], CONTEXT)
})

beforeEach(async () => {
  for (const org of [orgA, orgB]) {
    await service.from('strategy_documents').delete().eq('organisation_id', org)
    await untyped.from('intake_buyer_profile').delete().eq('organisation_id', org)
    await service.from('intake_responses').delete().eq('organisation_id', org)
    await seedActiveIcp(org)
  }
  const { error } = await writeBuyerProfile(service, orgA, STORED_PROFILE)
  expect(error).toBeNull()
})

describe('the client-role session this file mints', () => {
  // A CONTROL ON THE INSTRUMENT. Every claim below about what a client cannot do is
  // worthless if asClient is not actually running as a client. Prove it can do the thing a
  // client IS allowed to do, so a later zero result means "refused" and not "broken fixture".
  it('really is a client: it can READ its own organisation strategy documents', async () => {
    const { data, error } = await asClient
      .from('strategy_documents')
      .select('id')
      .eq('organisation_id', orgA)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('really is scoped: it cannot read another organisation documents', async () => {
    const { data, error } = await asClient
      .from('strategy_documents')
      .select('id')
      .eq('organisation_id', orgB)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})

describe('a buyer-profile edit, end to end', () => {
  it('flags the live prospect profile stale', async () => {
    const previous = await readBuyerProfileRow(service, orgA)
    expect(previous).not.toBeNull()

    // The exact edit that shipped unflagged in production on 2026-09-21 13:42:52 UTC:
    // sign-off stops being required, and two disqualifiers are added.
    const next: BuyerProfile = {
      ...STORED_PROFILE,
      signoff_required: false,
      disqualifiers: ['No budget', 'Deal size too small'],
    }
    const { error } = await writeBuyerProfile(service, orgA, next)
    expect(error).toBeNull()

    const changed = changedBuyerProfileFields(previous, next)
    expect(changed).toContain('signoff_required')
    expect(changed).toContain('disqualifiers')

    await flagDocumentsStaleForIntakeEditSafely(orgA, changed)

    const icp = await readIcp(orgA)
    expect(icp.is_stale).toBe(true)
    expect(icp.stale_reason).toMatch(new RegExp(`^${INTAKE_STALE_PREFIX}`))
  })

  // THE FIRST-SAVE FIX. Before it, a client filling this form in for the first time flagged
  // their own live prospect profile, because "no row" and "a row of blank answers" both read
  // as an empty profile. A first answer cannot invalidate a document: nothing was built
  // without it.
  it('flags nothing on a genuine first save', async () => {
    await untyped.from('intake_buyer_profile').delete().eq('organisation_id', orgA)

    const previous = await readBuyerProfileRow(service, orgA)
    expect(previous).toBeNull()

    const first: BuyerProfile = {
      ...EMPTY_BUYER_PROFILE,
      target_countries: ['Ireland'],
      buyer_job_titles: ['CEO'],
      signoff_required: true,
    }
    const { error } = await writeBuyerProfile(service, orgA, first)
    expect(error).toBeNull()

    const changed = changedBuyerProfileFields(previous, first)
    expect(changed).toEqual([])

    await flagDocumentsStaleForIntakeEditSafely(orgA, changed)

    expect((await readIcp(orgA)).is_stale).toBe(false)
  })

  it('flags nothing when the answers are re-saved unchanged', async () => {
    const previous = await readBuyerProfileRow(service, orgA)
    const changed = changedBuyerProfileFields(previous, STORED_PROFILE)
    expect(changed).toEqual([])

    await flagDocumentsStaleForIntakeEditSafely(orgA, changed)
    expect((await readIcp(orgA)).is_stale).toBe(false)
  })
})

describe('the original intake path, end to end', () => {
  // intake_responses, not intake_buyer_profile. Same helper, same fault, same fix: this path
  // had the identical dead UPDATE and has also never flagged a document in production.
  const FIELD = 'company_what_you_do'

  async function storeAnswer(value: string) {
    const { error } = await service.from('intake_responses').upsert(
      {
        organisation_id: orgA,
        field_key: FIELD,
        field_label: 'What do you do',
        response_value: value,
        is_critical: true,
        word_count: value.split(/\s+/).length,
        section: 'company',
      },
      { onConflict: 'organisation_id,field_key' },
    )
    expect(error).toBeNull()
  }

  it('flags the live prospect profile stale when a mapped answer changes', async () => {
    await storeAnswer('The original answer.')

    const previousValue = 'The original answer.'
    const nextValue = 'A materially different answer.'
    await storeAnswer(nextValue)

    expect(isIntakeAnswerEdit(previousValue, nextValue)).toBe(true)
    await flagDocumentsStaleForIntakeEditSafely(orgA, [FIELD])

    const icp = await readIcp(orgA)
    expect(icp.is_stale).toBe(true)
    expect(icp.stale_reason).toBe(`${INTAKE_STALE_PREFIX}${FIELD}`)
  })

  it('flags nothing on a first answer', async () => {
    expect(isIntakeAnswerEdit(null, 'The first answer.')).toBe(false)
    expect((await readIcp(orgA)).is_stale).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE PRIVILEGE QUESTION, PROVED RATHER THAN ASSERTED
// ═══════════════════════════════════════════════════════════════════════════

describe('the session client cannot do this job', () => {
  // THE ORIGINAL BUG, reproduced exactly. asServiceRoleClient is the documented single
  // assertion boundary for the brand, and using it HERE is the only honest way to get the
  // old code past the type system: the brand already makes this a compile error at every
  // production call site, which is the static half of the fix. This test is the runtime
  // half, and it is what goes red if anyone reverts the client choice.
  it('a client-role session changes nothing, and does not error while doing it', async () => {
    await flagDocumentsStaleForIntakeEdit(
      asServiceRoleClient(asClient),
      orgA,
      ['signoff_required'],
    )

    // Silently unchanged. This is what production did for seventeen days.
    expect((await readIcp(orgA)).is_stale).toBe(false)
  })

  it('the service-role client changes the same row, so the difference is the privilege', async () => {
    await flagDocumentsStaleForIntakeEdit(
      asServiceRoleClient(service),
      orgA,
      ['signoff_required'],
    )
    expect((await readIcp(orgA)).is_stale).toBe(true)
  })
})

describe('cross-organisation isolation', () => {
  // The service-role key bypasses RLS, so the .eq('organisation_id', ...) filter is the ONLY
  // thing standing between one organisation's intake edit and another organisation's
  // documents. That makes this the most important test in the file.
  it('flagging one organisation never touches another', async () => {
    await flagDocumentsStaleForIntakeEditSafely(orgA, ['signoff_required'])

    expect((await readIcp(orgA)).is_stale).toBe(true)
    expect((await readIcp(orgB)).is_stale).toBe(false)
    expect((await readIcp(orgB)).stale_reason).toBeNull()
  })

  // The attack this forecloses, stated as the attempt rather than the defence: a client of
  // orgA tries to flag orgB. They cannot name orgB, because neither server action accepts an
  // organisation and BuyerProfile has no such field; the id is resolved from their own
  // session. So the closest reachable thing is a client of orgA driving the helper, and even
  // if the id were somehow substituted, the session client has no UPDATE on ANY row.
  it('a client of one organisation cannot flag another, by either route', async () => {
    // Route 1: the id they can actually influence is their own, and it is not orgB.
    await flagDocumentsStaleForIntakeEditSafely(orgA, ['signoff_required'])
    expect((await readIcp(orgB)).is_stale).toBe(false)

    // Route 2: hand the helper orgB directly with the client's own session. Still nothing:
    // the session client has no UPDATE policy on strategy_documents at all.
    await flagDocumentsStaleForIntakeEdit(
      asServiceRoleClient(asClient),
      orgB,
      ['signoff_required'],
    )
    expect((await readIcp(orgB)).is_stale).toBe(false)
  })

  it('does not flag an archived document, only the live one', async () => {
    const { error } = await service.from('strategy_documents').insert({
      organisation_id: orgA,
      document_type: 'icp',
      status: 'archived',
      version: '0',
      is_stale: false,
    })
    expect(error).toBeNull()

    await flagDocumentsStaleForIntakeEditSafely(orgA, ['signoff_required'])

    const { data } = await service
      .from('strategy_documents')
      .select('is_stale')
      .eq('organisation_id', orgA)
      .eq('document_type', 'icp')
      .eq('status', 'archived')
      .single()
    expect(data!.is_stale).toBe(false)
  })
})
