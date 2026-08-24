// Contract test for fetchCampaignSendingStatus() and mapSendingStatus().
//
// The point of this file is the ENUM. campaigns.status answers what somebody intended a
// campaign to do; this endpoint answers whether mail is actually leaving. Getting the
// second one wrong prints the word "live" on a client's dashboard while their sending
// accounts sit at their daily cap, which is not a smaller lie than the placeholder copy
// it replaces.
//
// The enum under test was verified on 2026-08-24 against the official OpenAPI document,
// https://developer.instantly.ai/api-reference/openapi.json, at
// paths./api/v2/campaigns/{id}/sending-status.get, response 200,
// properties.diagnostics.properties.status. It is a closed enum of EIGHTEEN strings, and
// all eighteen are pinned individually below.
//
// It is NOT the campaign object's not_sending_status, which is a five-value NUMERIC enum
// on components.schemas.def-1: 1 out of schedule, 2 waiting for leads, 3 daily limit met,
// 4 all accounts at daily limit, 99 error. Both were verified in the same pass. A mapping
// built from the five-code vocabulary would drop thirteen values, including every
// campaign-state code and every account-health code, so the two are pinned apart here on
// purpose: the test named "is not the five-value not_sending_status enum" fails if anyone
// ever wires the numeric codes into this path.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { fetchCampaignSendingStatus, mapSendingStatus } from '../campaign-sending-status'
import { InstantlyFlagError } from '../types'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const API_KEY = 'test-api-key'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'
const EXT = 'cf695496-dba1-4bcb-beae-1b6ca28209d6'

function makeFetchSpy(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

function response(status: string | null) {
  return {
    diagnostics: {
      campaign_id: EXT,
      last_updated: '2026-08-24T15:15:00.000Z',
      status,
      issue_tracking: { current_status_code: status, consecutive_loops_with_issue: 0 },
    },
    summary: { status, status_message: 'irrelevant to the mapping' },
  }
}

// ── The enum itself ───────────────────────────────────────────────────────────

describe('mapSendingStatus — the verified Instantly sending-status enum', () => {
  it.each([
    // The only unobstructed value in the whole enum.
    ['healthy', 'sending'],

    // Campaign-state codes.
    ['campaign_draft', 'draft'],
    ['campaign_paused', 'paused'],
    ['campaign_completed', 'completed'],

    // Intends to send, nothing to send this instant.
    ['out_of_schedule', 'waiting'],
    ['waiting_for_leads', 'waiting'],
    ['follow_up_delay_not_met', 'waiting'],
    ['waiting_for_esp_match', 'waiting'],
    ['campaign_running_subsequences', 'waiting'],

    // A cap hit for today; resumes without anyone doing anything.
    ['daily_limit_met', 'limit_reached'],
    ['account_daily_limit_met', 'limit_reached'],
    ['new_lead_limit_met', 'limit_reached'],
    ['domain_limit_reached', 'limit_reached'],

    // Stopped by Instantly, against our wishes. Needs a human.
    ['campaign_bounce_protect', 'blocked'],
    ['campaign_accounts_unhealthy', 'blocked'],
    ['campaign_account_suspended', 'blocked'],
    ['all_accounts_unhealthy', 'blocked'],
    ['no_accounts_available', 'blocked'],
  ])('maps %s to %s', (raw, expected) => {
    expect(mapSendingStatus(raw)).toBe(expected)
  })

  it('covers all eighteen documented values and nothing else', () => {
    const documented = [
      'healthy',
      'campaign_draft',
      'campaign_paused',
      'campaign_completed',
      'campaign_running_subsequences',
      'campaign_bounce_protect',
      'campaign_accounts_unhealthy',
      'campaign_account_suspended',
      'out_of_schedule',
      'waiting_for_leads',
      'daily_limit_met',
      'account_daily_limit_met',
      'new_lead_limit_met',
      'all_accounts_unhealthy',
      'waiting_for_esp_match',
      'domain_limit_reached',
      'follow_up_delay_not_met',
      'no_accounts_available',
    ]
    expect(documented).toHaveLength(18)
    for (const v of documented) expect(mapSendingStatus(v)).not.toBeNull()

    // Outside the closed enum: unmapped, never defaulted.
    for (const v of ['sending', 'ok', 'active', 'unhealthy', '', 'HEALTHY']) {
      expect(mapSendingStatus(v)).toBeNull()
    }
  })

  it('is not the five-value not_sending_status enum, and does not accept its codes', () => {
    // components.schemas.def-1.properties.not_sending_status is [1, 2, 3, 4, 99], numeric.
    // If anyone ever routes those through this mapper, every one of them must come back
    // null rather than quietly becoming a state the dashboard renders.
    for (const v of [1, 2, 3, 4, 99]) expect(mapSendingStatus(v)).toBeNull()
    for (const v of ['1', '2', '3', '4', '99']) expect(mapSendingStatus(v)).toBeNull()
  })

  it('does NOT coerce non-strings, so a type change is visible rather than papered over', () => {
    expect(mapSendingStatus(null)).toBeNull()
    expect(mapSendingStatus(undefined)).toBeNull()
    expect(mapSendingStatus(0)).toBeNull()
    expect(mapSendingStatus({ status: 'healthy' })).toBeNull()
    expect(mapSendingStatus(['healthy'])).toBeNull()
  })

  it('treats only healthy as sending — every other value means mail is not leaving', () => {
    const everythingElse = [
      'campaign_draft', 'campaign_paused', 'campaign_completed',
      'campaign_running_subsequences', 'campaign_bounce_protect',
      'campaign_accounts_unhealthy', 'campaign_account_suspended', 'out_of_schedule',
      'waiting_for_leads', 'daily_limit_met', 'account_daily_limit_met',
      'new_lead_limit_met', 'all_accounts_unhealthy', 'waiting_for_esp_match',
      'domain_limit_reached', 'follow_up_delay_not_met', 'no_accounts_available',
    ]
    for (const v of everythingElse) expect(mapSendingStatus(v)).not.toBe('sending')
  })
})

// ── Request shape ─────────────────────────────────────────────────────────────

describe('fetchCampaignSendingStatus — request shape', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('GETs /campaigns/{id}/sending-status with a Bearer header', async () => {
    const fetchSpy = makeFetchSpy(200, response('healthy'))
    await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/campaigns/${EXT}/sending-status`)
    expect(options?.method ?? 'GET').toBe('GET')
    expect((options?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('encodes the campaign id rather than pasting it into the path', async () => {
    const fetchSpy = makeFetchSpy(200, response('healthy'))
    await fetchCampaignSendingStatus('a/b?c', API_KEY, true, MOCK_BASE_URL)
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`${MOCK_BASE_URL}/campaigns/a%2Fb%3Fc/sending-status`)
  })
})

// ── Response handling ─────────────────────────────────────────────────────────

describe('fetchCampaignSendingStatus — response handling', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('returns sending plus the raw code for healthy', async () => {
    makeFetchSpy(200, response('healthy'))
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)
    expect(result).toEqual({ state: 'sending', rawStatus: 'healthy' })
  })

  it('returns blocked for an account suspension, keeping the code for diagnostics', async () => {
    makeFetchSpy(200, response('campaign_account_suspended'))
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)
    expect(result).toEqual({ state: 'blocked', rawStatus: 'campaign_account_suspended' })
  })

  it('reads diagnostics.status in preference to summary.status', async () => {
    // Contrived, but it pins which field is authoritative. diagnostics is the one the
    // endpoint documents as always present.
    makeFetchSpy(200, {
      diagnostics: { status: 'daily_limit_met' },
      summary: { status: 'healthy' },
    })
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)
    expect(result.state).toBe('limit_reached')
  })

  it('falls back to summary.status when diagnostics is absent', async () => {
    makeFetchSpy(200, { diagnostics: null, summary: { status: 'out_of_schedule' } })
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)
    expect(result).toEqual({ state: 'waiting', rawStatus: 'out_of_schedule' })
  })

  it('returns a null state when Instantly answers with no data at all', async () => {
    // Documented: "Returns null for both fields if no data is available." Not a failure,
    // and specifically not a reason to claim the campaign is sending.
    makeFetchSpy(200, { diagnostics: null, summary: null })
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)
    expect(result).toEqual({ state: null, rawStatus: null })
  })

  it('returns a null state, and keeps the code, for a status outside the enum', async () => {
    makeFetchSpy(200, response('some_new_instantly_state'))
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)
    expect(result).toEqual({ state: null, rawStatus: 'some_new_instantly_state' })
  })

  it('throws on 429 so the caller can surface a rate limit rather than store a guess', async () => {
    makeFetchSpy(429, { message: 'Rate limit exceeded' })
    await expect(fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)).rejects.toThrow(/429/)
  })

  it('throws on 404, which is what a campaign deleted in Instantly looks like', async () => {
    makeFetchSpy(404, { message: 'Resource not found' })
    await expect(fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)).rejects.toThrow(/404/)
  })

  it('throws when the body is not JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    )
    await expect(fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)).rejects.toThrow(/not valid JSON/)
  })

  it('throws when the body is JSON but not an object', async () => {
    makeFetchSpy(200, ['healthy'])
    await expect(fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)).rejects.toThrow(/not an object/)
  })

  it('throws on a network error rather than resolving to an unknown state', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    await expect(fetchCampaignSendingStatus(EXT, API_KEY, true, MOCK_BASE_URL)).rejects.toThrow(/network error/)
  })
})

// ── The flag guard ────────────────────────────────────────────────────────────

describe('fetchCampaignSendingStatus — production safety gate', () => {
  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    vi.restoreAllMocks()
  })

  it('refuses to call production Instantly while the flag is off', async () => {
    // The override is set, so mock dispatch is off and this WOULD be a real fetch. The
    // flag says the integration is inactive and the URL says production, which is a
    // misconfiguration, not a test run. It must not reach the network.
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'
    const fetchSpy = vi.spyOn(global, 'fetch')

    await expect(
      fetchCampaignSendingStatus(EXT, API_KEY, false, 'https://api.instantly.ai/api/v2')
    ).rejects.toBeInstanceOf(InstantlyFlagError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still calls an external test server when the flag is off and the URL is not production', async () => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
    const fetchSpy = makeFetchSpy(200, response('waiting_for_leads'))

    const result = await fetchCampaignSendingStatus(EXT, API_KEY, false, MOCK_BASE_URL)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(result.state).toBe('waiting')
  })

  it('uses in-process mock dispatch when the flag is off and no base URL is set', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await fetchCampaignSendingStatus(EXT, API_KEY, false, 'https://example.test/api/v2')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ state: 'sending', rawStatus: 'healthy' })
  })
})
