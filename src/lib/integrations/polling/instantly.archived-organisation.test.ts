// The archived-organisation exclusion on the lead-status poll.
//
// pollInstantlyLeadStatus reads campaigns through an inner join and drops every campaign
// whose organisation has been archived:
//
//   .select('id, organisation_id, external_id, organisations!inner(archived_at)')
//   .is('organisations.archived_at', null)
//
// That filter is the only thing stopping the poller spending provider credits on clients
// who have left. Before this file it was proven by nothing. Every stand-in in the polling
// family returns `builder` from .is() and then hands back the campaign list whole, so the
// filter could be deleted with the entire suite still green. Measured 2026-09-07 against
// 1be5f00: the string `archived` appeared in no test file under src/lib/integrations/polling
// or src/app/api/cron/instantly-poll, while appearing in the production file above.
//
// So the stand-in below HONOURS the join and the filter. Two properties matter, and the
// second is the one a careless fake gets wrong:
//
//   1. .is('organisations.archived_at', null) actually removes rows.
//   2. A filter naming an embedded resource the select never joined THROWS. A fake that
//      accepted 'organisations.archived_at' without checking the join would pass whether or
//      not the join was there, so it could not tell the working query from one that had
//      lost its !inner and silently stopped filtering.
//
// Anything this fake is not taught throws rather than returning the builder, per CLAUDE.md:
// a fake that does not honour a filter cannot test that filter.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

// The bounce path carries suppressions out to the sending provider. Mocked for the same
// reason instantly.detection.test.ts mocks it: the real one makes its own calls to the same
// endpoint this file's fetch stub serves, and would fold extra requests into the counts
// these tests use to prove which campaigns were polled.
vi.mock('@/lib/suppression/carry', () => ({
  carryOneSuppression: vi.fn(async () => ({
    status: 'confirmed' as const,
    stoppedLeadIds: [] as string[],
    error: null,
    signalMarkedProcessed: true,
  })),
}))

import { pollInstantlyLeadStatus, INSTANTLY_LEAD_STATUS_BOUNCED } from './instantly'

interface FakeCampaign {
  id: string
  organisation_id: string
  external_id: string | null
}

/** Organisations keyed by id, exactly as the inner join resolves them. */
type FakeOrganisations = Record<string, { archived_at: string | null }>

const ACTIVE_ORG = 'org-active'
const ARCHIVED_ORG = 'org-archived'

const ORGANISATIONS: FakeOrganisations = {
  [ACTIVE_ORG]: { archived_at: null },
  [ARCHIVED_ORG]: { archived_at: '2026-08-01T00:00:00.000Z' },
}

const CAMPAIGN_ON_ACTIVE: FakeCampaign = {
  id: 'internal-active',
  organisation_id: ACTIVE_ORG,
  external_id: 'external-active',
}

const CAMPAIGN_ON_ARCHIVED: FakeCampaign = {
  id: 'internal-archived',
  organisation_id: ARCHIVED_ORG,
  external_id: 'external-archived',
}

function createFakeSupabase(campaigns: FakeCampaign[], organisations: FakeOrganisations) {
  const cursorUpserts: Record<string, unknown>[] = []
  const signalInserts: Record<string, unknown>[] = []

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'campaigns') {
        // Embedded resources this select actually joined. A filter on anything else is an
        // error, not a pass: that is precisely how a join filter goes missing unnoticed.
        const joins: string[] = []
        const predicates: Array<(campaign: FakeCampaign) => boolean> = []

        function columnValue(column: string, campaign: FakeCampaign): unknown {
          if (!column.includes('.')) return (campaign as unknown as Record<string, unknown>)[column]
          const [resource, field] = column.split('.')
          if (!joins.includes(resource)) {
            throw new Error(
              `fake: filter on "${column}" but select() never joined "${resource}". ` +
              `Add it to the select string, or the join filter is silently doing nothing.`,
            )
          }
          const joined = organisations[campaign.organisation_id]
          // !inner semantics: no matching parent row means the row is already gone.
          if (!joined) return undefined
          return (joined as unknown as Record<string, unknown>)[field]
        }

        const builder: any = {
          select(cols: string) {
            for (const match of cols.matchAll(/(\w+)!inner\s*\(/g)) {
              joins.push(match[1])
              // !inner semantics: a row whose parent is missing is dropped before filtering.
              predicates.push(campaign => Boolean(organisations[campaign.organisation_id]))
            }
            return builder
          },
          not(column: string, op: string, value: unknown) {
            if (op !== 'is' || value !== null) {
              throw new Error(`fake: .not(${column}, ${op}, ${String(value)}) is not implemented`)
            }
            predicates.push(campaign => {
              const actual = columnValue(column, campaign)
              return actual !== null && actual !== undefined
            })
            return builder
          },
          is(column: string, value: unknown) {
            if (value !== null) {
              throw new Error(`fake: .is(${column}, ${String(value)}) is not implemented, only is.null`)
            }
            predicates.push(campaign => {
              const actual = columnValue(column, campaign)
              return actual === null || actual === undefined
            })
            return builder
          },
          eq() { throw new Error('fake: .eq() on campaigns is not implemented') },
          in() { throw new Error('fake: .in() on campaigns is not implemented') },
          or() { throw new Error('fake: .or() on campaigns is not implemented') },
          limit() { throw new Error('fake: .limit() on campaigns is not implemented') },
          order() { throw new Error('fake: .order() on campaigns is not implemented') },
          then(settle: (v: unknown) => unknown) {
            const selected = campaigns.filter(campaign => predicates.every(p => p(campaign)))
            return settle({ data: selected, error: null })
          },
        }
        return builder
      }

      if (table === 'polling_cursors') {
        const builder: any = {
          select: () => builder,
          is: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: { last_cursor: null, error_count: 0 }, error: null }),
          upsert: async (row: Record<string, unknown>) => {
            cursorUpserts.push(row)
            return { error: null }
          },
        }
        return builder
      }

      if (table === 'signals') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: async (_cols: string) => {
              signalInserts.push(row)
              return { data: [{ id: `signal-${signalInserts.length}` }], error: null }
            },
          }),
        }
      }

      if (table === 'suppressed_emails') {
        return { insert: async () => ({ error: null }) }
      }

      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client, cursorUpserts, signalInserts }
}

/** Serves one empty page per request and records which campaign each request asked for. */
function serveEmptyAndCaptureCampaigns() {
  const campaignsRequested: unknown[] = []
  const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    campaignsRequested.push(body.campaign)
    return new Response(JSON.stringify({ items: [], pagination: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { fetchStub, campaignsRequested }
}

describe('the archived-organisation exclusion on the lead-status poll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.INSTANTLY_API_ACTIVE = 'true'
    delete process.env.INSTANTLY_API_BASE_URL
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTANTLY_API_ACTIVE
  })

  // THE GUARD. Deleting .is('organisations.archived_at', null) from the production query
  // makes this campaign reachable again, and this expectation is what goes red.
  it('never reaches the provider for a campaign whose organisation is archived', async () => {
    const { fetchStub, campaignsRequested } = serveEmptyAndCaptureCampaigns()
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase([CAMPAIGN_ON_ARCHIVED], ORGANISATIONS)

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced',
    )

    expect(campaignsRequested).toEqual([])
    expect(fetchStub).not.toHaveBeenCalled()
    // Nothing to poll is not a failure, but it is also not a poll.
    expect(result.polled).toBe(false)
    expect(result.errors).toBe(0)
  })

  // The other half, and the reason the test above cannot pass vacuously. If the fake
  // dropped every campaign for some unrelated reason, this would fail too.
  it('still reaches the provider for a campaign whose organisation is active', async () => {
    const { fetchStub, campaignsRequested } = serveEmptyAndCaptureCampaigns()
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase([CAMPAIGN_ON_ACTIVE], ORGANISATIONS)

    const result = await pollInstantlyLeadStatus(
      client,
      'test-key',
      INSTANTLY_LEAD_STATUS_BOUNCED,
      'email_bounced',
    )

    expect(campaignsRequested).toEqual(['external-active'])
    expect(result.polled).toBe(true)
    expect(result.errors).toBe(0)
  })

  // Both in one run, which is the shape production actually sees: the exclusion has to pick
  // between rows, not merely return nothing when every row is archived.
  it('polls only the active organisation campaign when both are present', async () => {
    const { fetchStub, campaignsRequested } = serveEmptyAndCaptureCampaigns()
    vi.stubGlobal('fetch', fetchStub)

    const { client } = createFakeSupabase(
      [CAMPAIGN_ON_ACTIVE, CAMPAIGN_ON_ARCHIVED],
      ORGANISATIONS,
    )

    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    expect(campaignsRequested).toEqual(['external-active'])
  })

  // The inner join is load-bearing on its own. A campaign whose organisation row does not
  // resolve at all must not be polled either, because !inner drops it before any filter.
  it('does not poll a campaign whose organisation row does not resolve', async () => {
    const { fetchStub } = serveEmptyAndCaptureCampaigns()
    vi.stubGlobal('fetch', fetchStub)

    const orphan: FakeCampaign = {
      id: 'internal-orphan',
      organisation_id: 'org-that-does-not-exist',
      external_id: 'external-orphan',
    }
    const { client } = createFakeSupabase([orphan], ORGANISATIONS)

    await pollInstantlyLeadStatus(client, 'test-key', INSTANTLY_LEAD_STATUS_BOUNCED, 'email_bounced')

    expect(fetchStub).not.toHaveBeenCalled()
  })
})
