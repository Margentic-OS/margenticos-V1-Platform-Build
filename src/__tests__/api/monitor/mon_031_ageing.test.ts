// MON-031 must report how long the PERSON has waited, not how long we have held the row.
//
// Needs the TEST database, never production. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/__tests__/api/monitor/mon_031_ageing.test.ts
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT, MEASURED ON A REAL ROW
//
// The MON-031 acceptance probe on 2026-09-07 recovered a reply that arrived at the
// provider on 2026-09-05 and had been lost ever since. Quarantined at 18:45:01. The
// monitor then reported "Oldest waiting 0.0 hours" for someone who had waited two days.
//
// The view aged from first_seen_at, which is when the POLLER first failed to attribute
// the reply. For a reply quarantined on arrival those instants coincide, which is why no
// unit fixture caught it: they all create the row at the moment of the event. Only a row
// whose write time PREDATES its quarantine time can tell the two apart, so that is what
// these tests build.
//
// MON-031's own plain_action says UNASSIGNED IS NOT ANSWERED. An operator reading
// "0.0 hours" beside that sentence will reasonably deprioritise it. The monitor was
// undercutting its own argument.
//
// MUTATION PROOF: change the view's `min(COALESCE(reply_written_at, first_seen_at))` back
// to `min(first_seen_at)` and the first test here goes red. Drop the COALESCE entirely and
// the null-timestamp test goes red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'

let serviceClient: SupabaseClient<Database>

const MARKER = `mon031-ageing-${Date.now()}`
const emailId = (suffix: string) => `${MARKER}-${suffix}`

const HOURS = 3600_000
const DAYS = 24 * HOURS

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * HOURS).toISOString()
}

async function readMon031(): Promise<{ state: string; detail: string }> {
  const { data, error } = await serviceClient.from('mon_031').select('*').single()
  expect(error).toBeNull()
  return data as unknown as { state: string; detail: string }
}

/** The hours figure the detail line reports, parsed back out of the sentence. */
function reportedHours(detail: string): number {
  const match = detail.match(/waiting: ([\d.]+) hours/)
  expect(match, `detail did not carry an hours figure: ${detail}`).not.toBeNull()
  return Number(match![1])
}

async function clearQuarantine(): Promise<void> {
  await serviceClient.from('unattributed_replies').delete().like('provider_email_id', `${MARKER}%`)
}

describe('MON-031 ages from when the person wrote', () => {
  beforeAll(async () => {
    serviceClient = createTestServiceClient('mon_031_ageing.test.ts')
    await clearQuarantine()
  })

  afterAll(async () => {
    await clearQuarantine()
  })

  it('reports the write time, not the quarantine time, when they differ', async () => {
    // The shape of the real incident: written two days before we noticed.
    await clearQuarantine()
    const { error } = await serviceClient.from('unattributed_replies').insert({
      provider: 'instantly',
      provider_email_id: emailId('backlog'),
      provider_campaign_id: 'campaign-unregistered',
      raw_data: { id: emailId('backlog') },
      reply_written_at: new Date(Date.now() - 2 * DAYS).toISOString(),
      first_seen_at: hoursAgo(0.5),
      last_seen_at: hoursAgo(0.5),
    })
    expect(error).toBeNull()

    const { state, detail } = await readMon031()

    expect(state).toBe('PROBLEM')
    // Two days, not the half hour we have held it. Before the fix this read ~0.5.
    expect(reportedHours(detail)).toBeGreaterThan(47)
    expect(reportedHours(detail)).toBeLessThan(49)
    expect(detail).toContain('since they wrote')
    expect(detail).toContain('campaign-unregistered')
  })

  it('falls back to first_seen_at when the payload carried no send time, and SAYS SO', async () => {
    // Never invent a time. The detail line has to admit the number is a floor, or an
    // operator reads a guess as a measurement.
    await clearQuarantine()
    const { error } = await serviceClient.from('unattributed_replies').insert({
      provider: 'instantly',
      provider_email_id: emailId('notime'),
      provider_campaign_id: 'campaign-unregistered',
      raw_data: { id: emailId('notime') },
      reply_written_at: null,
      first_seen_at: hoursAgo(10),
      last_seen_at: hoursAgo(10),
    })
    expect(error).toBeNull()

    const { detail } = await readMon031()

    expect(reportedHours(detail)).toBeGreaterThan(9)
    expect(reportedHours(detail)).toBeLessThan(11)
    expect(detail).toContain('carried no send time')
    expect(detail).toContain('a floor, not the real figure')
  })

  it('reports the LONGEST wait when rows disagree, not the newest', async () => {
    await clearQuarantine()
    const { error } = await serviceClient.from('unattributed_replies').insert([
      {
        provider: 'instantly',
        provider_email_id: emailId('recent'),
        provider_campaign_id: 'campaign-a',
        reply_written_at: hoursAgo(2),
        first_seen_at: hoursAgo(1),
        last_seen_at: hoursAgo(1),
      },
      {
        provider: 'instantly',
        provider_email_id: emailId('old'),
        provider_campaign_id: 'campaign-b',
        // Held for an hour, but this person wrote five days ago.
        reply_written_at: new Date(Date.now() - 5 * DAYS).toISOString(),
        first_seen_at: hoursAgo(1),
        last_seen_at: hoursAgo(1),
      },
    ])
    expect(error).toBeNull()

    const { detail } = await readMon031()

    expect(reportedHours(detail)).toBeGreaterThan(119)
    expect(detail).toContain('2 repl')
  })

  it('a redacted row keeps its real wait, because the column outlives raw_data', async () => {
    // This is why it is a column and not an expression over raw_data. At 30 days the
    // payload is nulled; a view parsing it would revert to our own clock exactly when the
    // person has waited longest.
    await clearQuarantine()
    const { error } = await serviceClient.from('unattributed_replies').insert({
      provider: 'instantly',
      provider_email_id: emailId('redacted'),
      provider_campaign_id: 'campaign-unregistered',
      raw_data: null,
      original_outbound_body: null,
      body_redacted_at: hoursAgo(1),
      reply_written_at: new Date(Date.now() - 31 * DAYS).toISOString(),
      first_seen_at: new Date(Date.now() - 31 * DAYS).toISOString(),
      last_seen_at: hoursAgo(1),
    })
    expect(error).toBeNull()

    const { state, detail } = await readMon031()

    expect(state).toBe('PROBLEM')
    expect(reportedHours(detail)).toBeGreaterThan(740)
    expect(detail).toContain('redacted')
    expect(detail).toContain('no longer be replayed')
  })

  it('returns OK on an empty table, and refuses to call that proof', async () => {
    // The positive control, and the born-dark statement. If this said "all clear" it would
    // be claiming something an empty table cannot support.
    await clearQuarantine()

    const { state, detail } = await readMon031()

    expect(state).toBe('OK')
    expect(detail).toContain('not proof the quarantine write')
  })

  it('a resolved row stops counting, so replay actually clears the alarm', async () => {
    await clearQuarantine()
    const { error } = await serviceClient.from('unattributed_replies').insert({
      provider: 'instantly',
      provider_email_id: emailId('resolved'),
      provider_campaign_id: 'campaign-unregistered',
      reply_written_at: new Date(Date.now() - 3 * DAYS).toISOString(),
      first_seen_at: hoursAgo(5),
      last_seen_at: hoursAgo(5),
      resolved_at: new Date().toISOString(),
    })
    expect(error).toBeNull()

    const { state } = await readMon031()
    expect(state).toBe('OK')
  })
})
