// src/lib/reply-handling/get-client-visible-replies.ts
//
// SINGLE CHOKEPOINT for all client-facing reply reads.
// ALL client views of replies must go through this function.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO FILTERS, AND ONLY ONE OF THEM HAS A SAFETY NET
//
//   1. org-scoping     — the client sees only their own organisation's replies
//   2. intent-filtering — the client sees only positive-intent replies
//
// Nothing outside this file may query reply_handling_actions for a client. If it did,
// the intent filter would simply be absent, and a client would be shown the reply telling
// them to get lost. That is a relationship-ending failure, not a rendering bug, which is
// why every client-facing reply read comes through here.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT BUILDS ITS OWN SERVICE-ROLE CLIENT
//
// reply_handling_actions is operator-only under RLS. A client's SESSION client reads zero
// rows from it in silence: no error, no exception, an empty array that renders as "no
// replies yet". The replies page passed the session client, so this function has been
// reachable and correct and returning nothing to every client since it was written.
//
// The caller now passes an organisation id and nothing else, so the wrong client cannot
// be handed in. Same treatment, same reason, as getClientVisibleCampaignMetrics.
//
// The cost, named: org-scoping here no longer has an RLS backstop. The
// .eq('organisation_id', clientOrgId) on every query below IS the gate. ADR-027's
// two-client pattern: the session client authenticates and resolves the org, the service
// client reads.
//
// Granting clients an RLS read policy on reply_handling_actions instead would be strictly
// worse. The rows carry classified_intent, classification_confidence, tier_assigned and
// classification_reasoning, none of which a client may ever see, and a read policy would
// put all of it one anon-key query away with the intent filter gone.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT LEAVES THIS FILE, AND WHAT CANNOT
//
// ClientVisibleReply carries NO intent, NO confidence score and NO tier. Not hidden in
// the UI: absent from the returned object, and absent from the SELECT that built it.
// classified_intent is used in the WHERE clause and never read back.
//
// The badge is two-valued, 'interested' or 'meeting_booked', and it is derived from
// whether a meeting exists, not from the classification. The five-intent vocabulary had
// been surfacing to clients as five distinct labels ("Ready to book", "Asking about
// pricing", "Interested but hesitant"), which is an intent label wearing a friendly coat.
//
// WHAT MUST BE HERE AND HAD NO SURFACE ANYWHERE: the reply WE SENT on the client's
// behalf. It goes out from their domain, in their founder's name, and until now they had
// no way to read it. Only after it was actually sent, and read-only.
//   - a Tier 2/3 draft appears only at status 'sent'. A draft at 'pending', 'approved' or
//     'rejected' is an operator's business and never reaches a client.
//   - a Tier 1 automatic reply appears only when action_succeeded is true.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Database, Json } from '@/types/database'

type SupabaseServiceClient = SupabaseClient<Database>

// The 5 intents clients are allowed to see: positive/engaged signals.
//
// EXPORTED because it is the single definition of "a reply the client may see". The
// client-facing metrics chokepoint counts against this same list, so the "Interested"
// number on the overview can never disagree with the number of cards on the replies page.
// A second, private copy of this list anywhere is a bug waiting to happen.
export const CLIENT_VISIBLE_INTENTS = [
  'positive_direct_booking',
  'positive_passive',
  'information_request_generic',
  'information_request_commercial',
  'objection_mild',
] as const

export type ClientVisibleIntent = typeof CLIENT_VISIBLE_INTENTS[number]

// Two values. Never five, and never the raw intent.
export type ClientReplyBadge = 'interested' | 'meeting_booked'

export interface ClientReplyProspect {
  first_name: string | null
  last_name: string | null
  job_title: string | null
  company_name: string | null
  email: string | null
}

export interface SentOnTheirBehalf {
  body: string
  sent_at: string
}

export interface ClientVisibleReply {
  id: string
  // When the prospect replied.
  received_at: string
  prospect: ClientReplyProspect
  badge: ClientReplyBadge
  reply_subject: string | null
  // VERBATIM and complete. This used to be truncated to 300 characters, which meant a
  // client could not read the whole of what a prospect said to them.
  reply_body: string
  // The email of ours that prompted the reply. Collapsed by default in the UI.
  prompting_email: string | null
  // What went out from their domain in their founder's name. Null until it was actually
  // sent. A draft awaiting approval is never represented here.
  sent_on_their_behalf: SentOnTheirBehalf | null
  // Present only when this prospect has a meeting on the books.
  meeting: { scheduled_for: string | null } | null
}

function serviceRoleClient(): SupabaseServiceClient {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // Loud rather than empty. Silence here reads as "you have had no replies", which is
    // the single most damaging thing this page could say incorrectly.
    throw new Error(
      'getClientVisibleReplies: SUPABASE_SERVICE_ROLE_KEY is not set. Client-facing reply ' +
      'reads hit an operator-only table and cannot fall back to the session client, which ' +
      'returns zero rows silently.'
    )
  }
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Instantly's reply body arrives as { text: string } on some events and as a bare string
// on others. Newlines are preserved: the card renders the reply verbatim.
function extractBody(rawData: Record<string, unknown>): string {
  const bodyRaw = rawData.body
  if (typeof bodyRaw === 'string') return bodyRaw
  if (typeof bodyRaw === 'object' && bodyRaw !== null) {
    return ((bodyRaw as Record<string, unknown>).text as string | undefined) ?? ''
  }
  return ''
}

/**
 * Fetches replies visible to a client.
 * SINGLE CHOKEPOINT: all client-facing reply reads must use this function.
 *
 * The caller is responsible for having resolved clientOrgId through the session client
 * (resolveViewingOrg). This function trusts that id and scopes every query to it.
 */
export async function getClientVisibleReplies(
  clientOrgId: string,
): Promise<ClientVisibleReply[]> {
  const supabase = serviceRoleClient()

  // classified_intent is used in the WHERE clause and deliberately NOT selected. The
  // label never enters this process, so it cannot leak through a spread or a log line.
  const { data, error } = await supabase
    .from('reply_handling_actions')
    .select(
      `
      id,
      created_at,
      updated_at,
      action_taken,
      action_succeeded,
      action_payload,
      signal_id,
      prospect_id,
      prospect:prospects (
        first_name,
        last_name,
        job_title,
        company_name,
        email
      ),
      signal:signals (
        raw_data,
        original_outbound_body
      )
      `,
    )
    .eq('organisation_id', clientOrgId)
    .in('classified_intent', CLIENT_VISIBLE_INTENTS)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error(`Failed to fetch client-visible replies: ${error.message}`)
  }

  const rows = data ?? []
  if (rows.length === 0) return []

  const signalIds = rows.map(r => r.signal_id).filter((id): id is string => Boolean(id))
  const prospectIds = rows.map(r => r.prospect_id).filter((id): id is string => Boolean(id))

  // Both of these are org-scoped again in their own right. Belt and braces: the id lists
  // came from rows that were already org-scoped, but a filter that depends on an earlier
  // query being correct is not a filter.
  const [draftsResult, meetingsResult] = await Promise.all([
    signalIds.length > 0
      ? supabase
          .from('reply_drafts')
          .select('signal_id, final_sent_body, sent_at')
          .eq('organisation_id', clientOrgId)
          // status 'sent' is the whole gate. 'pending', 'approved' and 'rejected' are the
          // operator's queue and must never appear on a client's screen.
          .eq('status', 'sent')
          .in('signal_id', signalIds)
      : Promise.resolve({ data: [], error: null }),
    prospectIds.length > 0
      ? supabase
          .from('meetings')
          .select('prospect_id, scheduled_start_at, meeting_date')
          .eq('organisation_id', clientOrgId)
          .in('prospect_id', prospectIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (draftsResult.error) {
    throw new Error(`Failed to fetch sent replies: ${draftsResult.error.message}`)
  }
  if (meetingsResult.error) {
    throw new Error(`Failed to fetch meetings for replies: ${meetingsResult.error.message}`)
  }

  const sentDraftBySignal = new Map<string, SentOnTheirBehalf>()
  for (const d of draftsResult.data ?? []) {
    // send-approved-draft.ts refuses to send an empty final_sent_body and stamps sent_at
    // in the same statement that sets status 'sent', so both are present on a real row.
    // A row missing either is skipped rather than rendered half-built.
    if (!d.signal_id || !d.final_sent_body || !d.sent_at) continue
    sentDraftBySignal.set(d.signal_id, { body: d.final_sent_body, sent_at: d.sent_at })
  }

  const meetingByProspect = new Map<string, { scheduled_for: string | null }>()
  for (const m of meetingsResult.data ?? []) {
    if (!m.prospect_id) continue
    // Every meeting counts for the badge, including one already held. The badge answers
    // "did this reply turn into a meeting", which stays true afterwards.
    if (!meetingByProspect.has(m.prospect_id)) {
      meetingByProspect.set(m.prospect_id, {
        scheduled_for: m.scheduled_start_at ?? m.meeting_date ?? null,
      })
    }
  }

  return rows.map((row) => {
    const signal = row.signal as { raw_data: Json; original_outbound_body: string | null } | null
    const rawData = (signal?.raw_data ?? {}) as Record<string, unknown>

    const prospect = row.prospect as ClientReplyProspect | null

    // The operator-approved reply wins when both exist. A Tier 1 automatic reply and a
    // Tier 2/3 drafted one are mutually exclusive in practice (Tier 1 sends, Tier 2/3
    // logs and drafts), but if both were ever present the human-reviewed one is the one
    // the client should read.
    const sentDraft = row.signal_id ? sentDraftBySignal.get(row.signal_id) ?? null : null

    let sentOnTheirBehalf: SentOnTheirBehalf | null = sentDraft
    if (!sentOnTheirBehalf && row.action_succeeded === true) {
      const payload = (row.action_payload ?? {}) as Record<string, unknown>
      const autoBody = payload.reply_body
      if (typeof autoBody === 'string' && autoBody.trim().length > 0) {
        // updated_at is stamped by the same update that records the send result, so it is
        // when the reply actually went out rather than when the row was created.
        sentOnTheirBehalf = { body: autoBody, sent_at: row.updated_at }
      }
    }

    const meeting = row.prospect_id ? meetingByProspect.get(row.prospect_id) ?? null : null

    return {
      id: row.id,
      received_at: row.created_at,
      prospect: prospect ?? {
        first_name: null,
        last_name: null,
        job_title: null,
        company_name: null,
        email: null,
      },
      badge: meeting ? 'meeting_booked' : 'interested',
      reply_subject: typeof rawData.subject === 'string' ? rawData.subject : null,
      reply_body: extractBody(rawData),
      prompting_email: signal?.original_outbound_body ?? null,
      sent_on_their_behalf: sentOnTheirBehalf,
      meeting,
    } satisfies ClientVisibleReply
  })
}
