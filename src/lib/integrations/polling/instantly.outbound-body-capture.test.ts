// The outbound email a reply is answering is captured, and the drafter is reachable as a result.
//
// THE DEFECT THIS LOCKS OUT, measured against production 2026-09-21.
//
// fetchOutboundEmailBody looked for the outbound email's uuid in reply_to_uuid,
// in_reply_to_uuid and original_email_uuid. Zero of nine production replies carried any of
// the three (controls in the same query: thread_id, message_id and eaccount all nine of
// nine). It returned null before making an API call, so signals.original_outbound_body was
// NULL on all nine, draft-orchestrator.ts:240 tripped on every one, and the reply-draft agent
// has never run in production. Every reply_drafts row in production reads
// manual_required / {"reason":"original_outbound_not_captured"} with a null ai_draft_body.
//
// TWO BUGS, STACKED, AND EITHER ONE ALONE STILL YIELDS NULL:
//   1. the uuid fields do not exist, so no email was ever fetched;
//   2. the body extractor required `body_text` or a STRING `body`. The real endpoint has no
//      `body_text` and `body` is an OBJECT, `{html}` on a sent email.
// The mock returned `body_text`, a field the provider does not have, which is why the suite
// was green while production was null on every row. That mock is corrected in the same commit.
//
// WHY THE LOOKUP IS NOT BY thread_id. Instantly accepts `thread_id` as a query parameter and
// silently ignores it: three different real thread ids each returned the identical unfiltered
// page, 50 rows over 49 threads and 49 leads. The request narrows by `lead`, which the
// provider does honour, and the thread is matched locally. See outbound-body.ts.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY PRODUCER AND CONSUMER ARE IN ONE FILE
//
// A test on the poller alone proves a column is written. A test on the orchestrator alone
// proves a gate opens when handed a string. Neither proves the handoff, and the handoff is
// where this lived: a producer writing null and a consumer gating on non-null, each with
// passing tests. So the first test below drives the REAL poller, takes the
// original_outbound_body it actually wrote, hands that value to the REAL orchestrator, and
// asserts the drafter was reached. Nothing in between is stubbed.
//
// MUTATION-PROVED, each half independently, both runs measured 2026-09-21:
//   Half one (selection) — replace the thread filter with `filter(() => true)`:
//     3 red of 15. 'refuses a sent email from a different thread', 'ignores other threads
//     while still finding the matching one', and the joined 'still records null' case.
//     All 7 extraction tests stayed GREEN.
//   Half two (extraction) — restore the old extractor (body_text, then string body):
//     6 red of 15. The joined test plus 'reads the html body object', 'turns block elements
//     into line breaks', 'turns br into a line break', 'prefers body.text', 'decodes
//     entities'. All 6 selection tests stayed GREEN.
//   Neither mutation is detected by 'does NOT read body_text' or 'returns null rather than
//   empty string' — see the note on the former. A test's comment claiming coverage it does
//   not have is the failure mode this file exists to close, so they say so.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

import { pollInstantlyReplies } from './instantly'
import {
  selectOutboundEmailForReply,
  extractOutboundBodyText,
} from '@/lib/integrations/handlers/instantly/outbound-body'
import { orchestrateDraft } from '@/lib/reply-handling/draft-orchestrator'

const CAMPAIGN = { id: 'internal-a', organisation_id: 'org-a', external_id: 'campaign-a' }
const THREAD = 'cf-7DvQHZEUyJSJ10gGcPO6ZEW'
const LEAD = 'augusta@consulthigson.com'

// The real body shape, taken verbatim from GET /emails?lead=…&email_type=sent on 2026-09-21.
// body is an object carrying html and nothing else.
const REAL_OUTBOUND_HTML =
  '<div><p>Augusta</p><p>The assumption most consulting founders work from: outreach is ' +
  'something to do when the diary empties.</p><p>We run outbound continuously so qualified ' +
  'meetings land in the diary.</p><p>Doug<br>MargenticOS</p></div>'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function replyRow(id: string): Record<string, unknown> {
  return {
    id,
    eaccount: 'doug.pettit@getmargenticos.com',
    campaign_id: CAMPAIGN.external_id,
    lead: LEAD,
    thread_id: THREAD,
    timestamp_email: '2026-09-18T13:40:24.000Z',
    body: { text: 'Who is this?' },
  }
}

function sentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'outbound-1',
    lead: LEAD,
    thread_id: THREAD,
    ue_type: 1,
    timestamp_email: '2026-09-18T13:40:20.000Z',
    body: { html: REAL_OUTBOUND_HTML },
    ...over,
  }
}

// ── Fake Supabase, enough for the reply poll path ─────────────────────────────
function createFakeSupabase() {
  const signalInserts: Record<string, unknown>[] = []
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table === 'campaigns') {
        const b: any = {
          select: () => b,
          not: () => b,
          is: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { id: CAMPAIGN.id, organisation_id: CAMPAIGN.organisation_id },
            error: null,
          }),
          then: (r: (v: unknown) => unknown) => r({ data: [CAMPAIGN], error: null }),
        }
        return b
      }
      if (table === 'signals') {
        return {
          insert: (row: Record<string, unknown>) => {
            signalInserts.push(row)
            return {
              select: () => ({
                single: async () => ({ data: { id: `sig-${signalInserts.length}` }, error: null }),
              }),
            }
          },
        }
      }
      if (table === 'polling_cursors') {
        const b: any = {
          select: () => b,
          eq: () => b,
          is: () => b,
          not: () => b,
          order: () => b,
          limit: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
          upsert: async () => ({ error: null }),
        }
        return b
      }
      const noop: any = {
        select: () => noop,
        eq: () => noop,
        in: () => noop,
        is: () => noop,
        not: () => noop,
        gte: () => noop,
        order: () => noop,
        limit: () => noop,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        insert: async () => ({ error: null }),
        update: () => noop,
        upsert: async () => ({ error: null }),
        then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
      }
      return noop
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { client, signalInserts }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INSTANTLY_API_ACTIVE = 'true'
  delete process.env.INSTANTLY_API_BASE_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTANTLY_API_ACTIVE
})

// ══════════════════════════════════════════════════════════════════════════════
// THE JOINED TEST — producer to consumer, nothing stubbed between them
// ══════════════════════════════════════════════════════════════════════════════

describe('a reply whose thread matches a sent email reaches the drafter', () => {
  it('the poller writes a non-null original_outbound_body and the orchestrator then calls the drafter', async () => {
    // The poller makes two kinds of GET against /emails: the reply list, and the per-lead
    // sent lookup. Route on the query string rather than call order.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.searchParams.get('email_type') === 'sent') {
        expect(u.searchParams.get('lead')).toBe(LEAD)
        return jsonResponse({ items: [sentRow()] })
      }
      return jsonResponse({ items: [replyRow('email-1')] })
    }))

    const { client, signalInserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    // ── PRODUCER ──
    expect(signalInserts).toHaveLength(1)
    const captured = signalInserts[0].original_outbound_body
    expect(captured).not.toBeNull()
    expect(typeof captured).toBe('string')
    // Converted out of html, with paragraph breaks preserved rather than collapsed.
    expect(String(captured)).toContain('Augusta')
    expect(String(captured)).toContain('We run outbound continuously')
    expect(String(captured)).not.toContain('<p>')
    expect(String(captured)).toContain('\n')

    // ── CONSUMER: the real orchestrator, handed the value the real poller produced ──
    const draftReply = vi.fn(async () => ({
      draft_body: 'A drafted reply.',
      faq_ids_used: [],
      confidence: 0.8,
    }))
    vi.doMock('@/lib/agents/reply-draft-agent', () => ({ draftReply }))
    vi.doMock('@/lib/faq/matcher', () => ({ findFaqMatches: vi.fn(async () => []) }))
    vi.doMock('@/lib/reply-handling/load-org-context', () => ({
      loadOrgContext: vi.fn(async () => ({
        organisationName: 'MargenticOS',
        senderFirstName: 'Doug',
        icpSummary: 'x',
        positioningSummary: 'x',
        tovSummary: 'x',
        bookingUrl: null,
      })),
    }))
    vi.resetModules()
    const { orchestrateDraft: freshOrchestrate } = await import(
      '@/lib/reply-handling/draft-orchestrator'
    )

    const draftInserts: Record<string, unknown>[] = []
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const draftClient: any = {
      from(table: string) {
        if (table === 'reply_drafts') {
          const b: any = {
            select: () => b,
            eq: () => b,
            maybeSingle: async () => ({ data: null, error: null }),
            insert: (row: Record<string, unknown>) => {
              draftInserts.push(row)
              return {
                select: () => ({ single: async () => ({ data: { id: 'draft-1' }, error: null }) }),
              }
            },
          }
          return b
        }
        const b: any = {
          select: () => b,
          eq: () => b,
          gte: () => b,
          then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
        }
        return b
      },
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const result = await freshOrchestrate({
      signal: {
        id: 'sig-1',
        organisation_id: CAMPAIGN.organisation_id,
        campaign_id: CAMPAIGN.id,
        raw_data: { body: { text: 'What does this cost?' } },
        // THE HANDOFF. Not a literal: the string the poller actually wrote above.
        original_outbound_body: captured as string,
      },
      classification: { intent: 'information_request_commercial', confidence: 0.9, reasoning: 'r' },
      prospectId: null,
      supabase: draftClient,
    })

    // The gate opened and the drafter ran. Before this change the same call returned
    // manual_required / original_outbound_not_captured and draftReply was never invoked.
    expect(draftReply).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe('drafted')
    expect(draftInserts[0]?.ai_draft_body).toBe('A drafted reply.')

    // And the drafter saw the real outbound copy, not an empty string.
    const passed = draftReply.mock.calls[0][0] as unknown as { originalOutboundBody: string }
    expect(passed.originalOutboundBody).toContain('We run outbound continuously')
  })

  it('still records null, and does not invent a body, when no sent email matches the thread', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.searchParams.get('email_type') === 'sent') {
        // A real risk: the provider ignores thread_id, so the page can be another thread's.
        return jsonResponse({ items: [sentRow({ thread_id: 'cf-SOMEONE-ELSE', id: 'wrong' })] })
      }
      return jsonResponse({ items: [replyRow('email-1')] })
    }))

    const { client, signalInserts } = createFakeSupabase()
    await pollInstantlyReplies(client, 'test-key')

    expect(signalInserts).toHaveLength(1)
    // Null, not the wrong prospect's email. The signal is still written: a reply is never
    // dropped for want of its outbound context.
    expect(signalInserts[0].original_outbound_body).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// HALF ONE — selection. Mutate the thread filter and only these go red.
// ══════════════════════════════════════════════════════════════════════════════

describe('selectOutboundEmailForReply', () => {
  const reply = { thread_id: THREAD, timestamp_email: '2026-09-18T13:40:24.000Z' }

  it('picks the sent email in the same thread', () => {
    const chosen = selectOutboundEmailForReply(reply, [sentRow()])
    expect(chosen?.id).toBe('outbound-1')
  })

  it('refuses a sent email from a different thread', () => {
    // THE LOAD-BEARING TEST. The provider ignores thread_id, so this filter is the only
    // thing preventing another prospect's email being written as this one's context.
    const chosen = selectOutboundEmailForReply(reply, [sentRow({ thread_id: 'cf-OTHER' })])
    expect(chosen).toBeNull()
  })

  it('ignores other threads while still finding the matching one in a mixed page', () => {
    const chosen = selectOutboundEmailForReply(reply, [
      sentRow({ thread_id: 'cf-OTHER-1', id: 'no-1' }),
      sentRow({ id: 'yes' }),
      sentRow({ thread_id: 'cf-OTHER-2', id: 'no-2' }),
    ])
    expect(chosen?.id).toBe('yes')
  })

  it('takes the latest email sent at or before the reply, not the first of the sequence', () => {
    const chosen = selectOutboundEmailForReply(reply, [
      sentRow({ id: 'step-1', timestamp_email: '2026-09-01T09:00:00.000Z' }),
      sentRow({ id: 'step-3', timestamp_email: '2026-09-18T13:40:20.000Z' }),
      sentRow({ id: 'step-2', timestamp_email: '2026-09-10T09:00:00.000Z' }),
    ])
    expect(chosen?.id).toBe('step-3')
  })

  it('ignores a sent email dated after the reply', () => {
    const chosen = selectOutboundEmailForReply(reply, [
      sentRow({ id: 'before', timestamp_email: '2026-09-18T13:40:20.000Z' }),
      sentRow({ id: 'after', timestamp_email: '2026-09-19T09:00:00.000Z' }),
    ])
    expect(chosen?.id).toBe('before')
  })

  it('returns null on an empty page and on a reply with no thread id', () => {
    expect(selectOutboundEmailForReply(reply, [])).toBeNull()
    expect(selectOutboundEmailForReply({ thread_id: '' }, [sentRow()])).toBeNull()
    expect(selectOutboundEmailForReply({}, [sentRow()])).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// HALF TWO — extraction. Restore the old body_text extractor and only these go red.
// ══════════════════════════════════════════════════════════════════════════════

describe('extractOutboundBodyText', () => {
  it('reads the html body object, which is the only shape the endpoint returns for a sent email', () => {
    const text = extractOutboundBodyText(sentRow())
    expect(text).not.toBeNull()
    expect(text).toContain('Augusta')
    expect(text).toContain('Doug')
    expect(text).not.toContain('<')
  })

  it('turns block elements into line breaks rather than one run-on line', () => {
    const text = extractOutboundBodyText({
      body: { html: '<p>One.</p><p>Two.</p>' },
    })
    expect(text).toBe('One.\nTwo.')
  })

  it('turns br into a line break, which is what the sign-off uses', () => {
    const text = extractOutboundBodyText({ body: { html: '<p>Doug<br>MargenticOS</p>' } })
    expect(text).toBe('Doug\nMargenticOS')
  })

  it('prefers body.text when the provider supplies it', () => {
    const text = extractOutboundBodyText({
      body: { text: 'Already plain.', html: '<p>Ignore me.</p>' },
    })
    expect(text).toBe('Already plain.')
  })

  it('returns null rather than empty string for a blank or absent body', () => {
    expect(extractOutboundBodyText({ body: { html: '   ' } })).toBeNull()
    expect(extractOutboundBodyText({ body: {} })).toBeNull()
    expect(extractOutboundBodyText({})).toBeNull()
    expect(extractOutboundBodyText(null)).toBeNull()
  })

  it('does NOT read body_text, the field the old extractor wanted and the endpoint lacks', () => {
    // NOT A MUTATION GUARD, and the comment here used to claim it was. Restoring the old
    // extractor leaves this test GREEN, measured: the `typeof body !== 'object'` guard above
    // returns null before any body_text read is reached, so this passes in both worlds. The
    // tests that actually go red on that mutation are the four html/text ones and the joined
    // test. Kept only as a statement of the shape contract: body_text is not an input.
    expect(extractOutboundBodyText({ body_text: 'nope' } as never)).toBeNull()
  })

  it('decodes entities so the drafter quotes readable copy', () => {
    expect(extractOutboundBodyText({ body: { html: '<p>you&apos;re &amp; they&apos;re</p>' } }))
      .toBe("you're & they're")
  })
})
