// Storage and read-back of the buyer-targeting answers, against the real database.
//
// The unit tests prove the mapping functions. They cannot prove that Postgres accepts these
// types, that text[] survives a round trip through PostgREST as an array rather than as a
// string, or that the CHECK constraints actually bite. Only a live write can, and the
// integers-not-prose claim is worthless if the column silently stringifies.
//
// Needs the TEST database, never production:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/intake/__tests__/buyer-profile-storage.live.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisation } from '@/test-utils/delete-test-organisations'
import {
  readBuyerProfile,
  writeBuyerProfile,
  BUYER_PROFILE_TABLE,
} from '@/lib/intake/buyer-profile-store'
import {
  COUNTRY_OPTIONS,
  EMPTY_BUYER_PROFILE,
  type BuyerProfile,
} from '@/lib/intake/buyer-profile'
import { PROVIDER_SENIORITY_BANDS } from '@/lib/sourcing/handlers/provider-seniority'

const CONTEXT = 'buyer-profile-storage.live.test.ts'

let serviceClient: SupabaseClient<Database>
let organisationId: string | null = null

beforeAll(async () => {
  serviceClient = createTestServiceClient(CONTEXT)

  const slug = `buyer-profile-live-${Date.now()}`
  const { data, error } = await serviceClient
    .from('organisations')
    .insert({ name: 'Buyer profile storage test', slug, founder_first_name: 'Test' })
    .select('id')
    .single()

  if (error || !data) throw new Error(`could not create test org: ${error?.message}`)
  organisationId = data.id
})

afterAll(async () => {
  await deleteTestOrganisation(serviceClient, organisationId, CONTEXT)
})

/** A fully populated profile. No value here names a real country, title, sector or company. */
function fullProfile(): BuyerProfile {
  return {
    // REAL COUNTRIES, read from the platform's own list rather than named here. Placeholder
    // text used to work and does not any more: countries became a closed list on 2026-09-20
    // and buyerProfileToRow drops an entry that names no country, so 'first place' would be
    // written as nothing and this test would assert on an empty array.
    target_countries: COUNTRY_OPTIONS.slice(0, 3).map(option => option.name),
    buyer_headcount_min: 11,
    buyer_headcount_max: 250,
    buyer_job_titles: ['first title', 'second title'],
    // Read from the provider module, never retyped.
    buyer_seniority_bands: [PROVIDER_SENIORITY_BANDS[1], PROVIDER_SENIORITY_BANDS[6]],
    first_contact_role: 'the person who receives it',
    signoff_required: true,
    signoff_role: 'the person who approves it',
    disqualifiers: ['one rule', 'another rule'],
  }
}

describe('the buyer-targeting answers store and read back typed', () => {
  it('an organisation with no row reads as an empty profile', async () => {
    // Runs first, and matters: every existing organisation is in exactly this state, and a
    // consumer must not crash on it.
    const profile = await readBuyerProfile(serviceClient, organisationId!)
    expect(profile).toEqual(EMPTY_BUYER_PROFILE)
  })

  it('writes and reads back every field with its type intact', async () => {
    const written = fullProfile()
    const { error } = await writeBuyerProfile(serviceClient, organisationId!, written)
    expect(error).toBeFalsy()

    const read = await readBuyerProfile(serviceClient, organisationId!)

    // THE WHOLE POINT: two integers and three string arrays, with no parsing anywhere.
    expect(typeof read.buyer_headcount_min).toBe('number')
    expect(typeof read.buyer_headcount_max).toBe('number')
    expect(read.buyer_headcount_min).toBe(11)
    expect(read.buyer_headcount_max).toBe(250)

    expect(Array.isArray(read.target_countries)).toBe(true)
    expect(Array.isArray(read.buyer_job_titles)).toBe(true)
    expect(Array.isArray(read.buyer_seniority_bands)).toBe(true)

    expect(read).toEqual(written)
  })

  it('a list survives a round trip as a list, not as a delimited string', async () => {
    // The failure this rules out: a text column that happens to render as "a,b,c" and reads
    // back needing a split. An entry containing the delimiter proves it is a real array.
    //
    // THE COMMA-BEARING ENTRY MOVED FROM target_countries TO disqualifiers on 2026-09-20,
    // and the test is not weaker for it. Countries became a closed list, so an entry there
    // can no longer contain a comma BY CONSTRUCTION, which means it can no longer carry this
    // proof: it would pass by being rejected rather than by round-tripping. disqualifiers is
    // still free text and a disqualifier containing a comma is ordinary, so the claim is now
    // made on a column where the bad outcome is actually reachable.
    const withCommas: BuyerProfile = {
      ...EMPTY_BUYER_PROFILE,
      target_countries: COUNTRY_OPTIONS.slice(0, 2).map(option => option.name),
      disqualifiers: ['a rule, with a comma in it', 'a second rule'],
    }
    await writeBuyerProfile(serviceClient, organisationId!, withCommas)
    const read = await readBuyerProfile(serviceClient, organisationId!)

    expect(read.disqualifiers).toHaveLength(2)
    expect(read.disqualifiers[0]).toBe('a rule, with a comma in it')
    // And the countries still round-trip as two separate entries.
    expect(read.target_countries).toHaveLength(2)
    expect(read.target_countries).toEqual(
      COUNTRY_OPTIONS.slice(0, 2).map(option => option.name),
    )
  })

  it('a second write updates the one row rather than adding another', async () => {
    await writeBuyerProfile(serviceClient, organisationId!, fullProfile())
    await writeBuyerProfile(serviceClient, organisationId!, {
      ...fullProfile(),
      buyer_headcount_min: 3,
      buyer_headcount_max: 9,
    })

    const { data, error } = await (serviceClient as unknown as SupabaseClient)
      .from(BUYER_PROFILE_TABLE)
      .select('organisation_id')
      .eq('organisation_id', organisationId!)

    expect(error).toBeFalsy()
    expect(data).toHaveLength(1)

    const read = await readBuyerProfile(serviceClient, organisationId!)
    expect(read.buyer_headcount_min).toBe(3)
    expect(read.buyer_headcount_max).toBe(9)
  })

  it('clearing sign-off clears the name that went with it', async () => {
    await writeBuyerProfile(serviceClient, organisationId!, fullProfile())
    expect((await readBuyerProfile(serviceClient, organisationId!)).signoff_role).not.toBe('')

    await writeBuyerProfile(serviceClient, organisationId!, {
      ...fullProfile(),
      signoff_required: false,
    })
    const read = await readBuyerProfile(serviceClient, organisationId!)
    expect(read.signoff_required).toBe(false)
    expect(read.signoff_role).toBe('')
  })
})

describe('the database refuses a headcount pair it should refuse', () => {
  // These go through the raw client, not writeBuyerProfile, because the point is that the
  // DATABASE is the last line. The application validates first; if only the application
  // validated, a future caller that skipped it would store an impossible range.
  const raw = () => serviceClient as unknown as SupabaseClient

  it('refuses half a pair', async () => {
    const { error } = await raw()
      .from(BUYER_PROFILE_TABLE)
      .upsert(
        { organisation_id: organisationId!, buyer_headcount_min: 10, buyer_headcount_max: null },
        { onConflict: 'organisation_id' },
      )
    expect(error, 'the database accepted half a headcount range').toBeTruthy()
  })

  it('refuses an inverted pair', async () => {
    const { error } = await raw()
      .from(BUYER_PROFILE_TABLE)
      .upsert(
        { organisation_id: organisationId!, buyer_headcount_min: 90, buyer_headcount_max: 9 },
        { onConflict: 'organisation_id' },
      )
    expect(error, 'the database accepted an inverted headcount range').toBeTruthy()
  })

  it('refuses a headcount below one', async () => {
    const { error } = await raw()
      .from(BUYER_PROFILE_TABLE)
      .upsert(
        { organisation_id: organisationId!, buyer_headcount_min: 0, buyer_headcount_max: 5 },
        { onConflict: 'organisation_id' },
      )
    expect(error, 'the database accepted a headcount below one').toBeTruthy()
  })

  it('accepts a valid pair, so the three refusals above are not refusing everything', async () => {
    // The positive control. Three constraints that reject everything would pass the tests
    // above and break the feature.
    const { error } = await raw()
      .from(BUYER_PROFILE_TABLE)
      .upsert(
        { organisation_id: organisationId!, buyer_headcount_min: 1, buyer_headcount_max: 1 },
        { onConflict: 'organisation_id' },
      )
    expect(error).toBeFalsy()
  })
})

describe('the row is removed with its organisation', () => {
  it('cascades on organisation delete, which is what the cleanup helper relies on', async () => {
    const slug = `buyer-profile-cascade-${Date.now()}`
    const { data: org, error: createError } = await serviceClient
      .from('organisations')
      .insert({ name: 'Buyer profile cascade test', slug, founder_first_name: 'Test' })
      .select('id')
      .single()
    if (createError || !org) throw new Error(`could not create org: ${createError?.message}`)

    await writeBuyerProfile(serviceClient, org.id, fullProfile())

    const before = await (serviceClient as unknown as SupabaseClient)
      .from(BUYER_PROFILE_TABLE)
      .select('organisation_id')
      .eq('organisation_id', org.id)
    expect(before.data, 'the fixture row was not written').toHaveLength(1)

    await deleteTestOrganisation(serviceClient, org.id, CONTEXT)

    const after = await (serviceClient as unknown as SupabaseClient)
      .from(BUYER_PROFILE_TABLE)
      .select('organisation_id')
      .eq('organisation_id', org.id)
    expect(after.data, 'the buyer profile row outlived its organisation').toHaveLength(0)
  })
})
