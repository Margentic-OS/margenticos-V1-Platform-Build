// src/lib/reply-handling/get-operator-replies.ts
//
// THE OPERATOR'S VIEW OF REPLIES. Deliberately NOT the client chokepoint.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE FILE FROM get-client-visible-replies.ts
//
// That file exists to enforce ONE rule at ONE place: a client never sees a reply outside
// CLIENT_VISIBLE_INTENTS. The operator view needs to bypass exactly that rule, so it must
// not be built by adding a flag to the chokepoint. A parameter that switches the intent
// filter off is one wrong argument away from showing a client the reply telling them to
// get lost, and it would sit inside the function whose entire job is preventing that.
//
// Two functions, two files, no shared switch. The chokepoint keeps its filter
// unconditional; this file never had one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WAS ACTUALLY BROKEN, 2026-08-25
//
// Half of all replies were invisible to the person running the product. At the time of
// writing the database held 12 classified replies, of which 6 (3 unclear, 2 opt_out,
// 1 out_of_office) are hidden from clients by design and had no operator surface at all.
// The operator page existed but NOTHING LINKED TO IT, so it was reachable only by typing
// a URL containing an organisation UUID. An opt-out or a hostile reply could land and
// nobody would see it inside our own product.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT BUILDS ITS OWN SERVICE-ROLE CLIENT
//
// reply_handling_actions, signals and reply_drafts all have operator RLS policies today
// (operators_read_reply_handling_actions, operators_full_access_signals,
// operators_full_access_reply_drafts), so an operator SESSION client can read them.
//
// It still builds a service-role client, for two reasons:
//   1. Those three policies are the only thing standing between this page and a silent
//      empty render. RLS returns zero rows without an error. A page whose failure mode is
//      "you have had no replies" must not depend on three policies staying correct.
//   2. ADR-027's two-client pattern: the session client authenticates and proves the
//      operator role in the route, the service client reads. Same treatment, same reason,
//      as getClientVisibleReplies and getClientVisibleCampaignMetrics.
//
// The gate is the operator role check in the page, plus .eq('organisation_id', orgId) on
// every query below. Both are load-bearing.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { extractReplyBody } from './extract-reply-body'
import { CLIENT_VISIBLE_INTENTS } from './get-client-visible-replies'

// The full intent vocabulary, in the order an operator reads them: the ones we act on
// first, the ones that end a conversation last. Mirrors KNOWN_INTENTS in route-intent.ts.
// An intent that appears in the data but not here is still shown, appended at the end
// under its raw name, rather than silently dropped.
const INTENT_ORDER = [
  'positive_direct_booking',
  'positive_passive',
  'information_request_commercial',
  'information_request_generic',
  'objection_mild',
  'opt_out',
  'out_of_office',
  'unclear',
] as const

const INTENT_LABELS: Record<string, string> = {
  positive_direct_booking: 'Ready to book',
  positive_passive: 'Interested',
  information_request_commercial: 'Asking about pricing',
  information_request_generic: 'Asking about details',
  objection_mild: 'Soft objection',
  opt_out: 'Opted out',
  out_of_office: 'Out of office',
  unclear: 'Unclear',
}

const CLIENT_VISIBLE = new Set<string>(CLIENT_VISIBLE_INTENTS)

export interface OperatorReplyProspect {
  first_name: string | null
  last_name: string | null
  job_title: string | null
  company_name: string | null
  email: string | null
}

// What we drafted or sent back. Every status is shown, unlike the client view which shows
// a draft only once it has actually gone out: the operator queue IS the pending ones.
export interface OperatorReplyDraft {
  tier: number
  status: string
  ai_draft_body: string | null
  final_sent_body: string | null
  sent_at: string | null
  send_error: string | null
}

export interface OperatorReply {
  id: string
  received_at: string
  prospect: OperatorReplyProspect
  intent: string
  intent_label: string
  // False for opt_out, out_of_office and unclear. Drives the "Hidden from client" marker,
  // which is the whole point of this view.
  client_visible: boolean
  confidence: number
  reply_subject: string | null
  // VERBATIM and complete, not a 300-character snippet. The operator is the person who
  // has to decide what to do about it, and the decision often turns on the last sentence.
  reply_body: string
  // The email of ours that prompted the reply. Lives on signals, not reply_drafts.
  prompting_email: string | null
  draft: OperatorReplyDraft | null
  action_taken: string
  action_succeeded: boolean | null
}

export interface OperatorReplyGroup {
  intent: string
  label: string
  client_visible: boolean
  count: number
  replies: OperatorReply[]
}

export interface OperatorRepliesForOrg {
  total: number
  // How many of `total` a client can never see. The number that says whether this page
  // was worth opening.
  hiddenFromClientCount: number
  // Only groups with at least one reply. An empty intent is noise, not information.
  groups: OperatorReplyGroup[]
}

type SupabaseServiceClient = SupabaseClient<Database>

function serviceRoleClient(): SupabaseServiceClient {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // Loud rather than empty, for the same reason as the client chokepoint: silence here
    // reads as "no replies", and this is the page where a missed opt-out is a compliance
    // problem rather than a rendering one.
    throw new Error(
      'getOperatorRepliesForOrg: SUPABASE_SERVICE_ROLE_KEY is not set. The operator reply ' +
      'view reads RLS-protected tables and cannot fall back to the session client, which ' +
      'can return zero rows silently.'
    )
  }
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/**
 * Every reply for one organisation, all intents, grouped with counts. Read-only.
 *
 * The caller is responsible for having proved the operator role through the session
 * client before calling this. This function trusts the org id and scopes every query
 * to it.
 */
export async function getOperatorRepliesForOrg(
  orgId: string,
): Promise<OperatorRepliesForOrg> {
  const supabase = serviceRoleClient()

  const { data, error } = await supabase
    .from('reply_handling_actions')
    .select(
      `
      id,
      created_at,
      classified_intent,
      classification_confidence,
      action_taken,
      action_succeeded,
      signal_id,
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
    .eq('organisation_id', orgId)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error(`Failed to fetch operator replies: ${error.message}`)
  }

  const rows = data ?? []
  if (rows.length === 0) {
    return { total: 0, hiddenFromClientCount: 0, groups: [] }
  }

  const signalIds = rows.map(r => r.signal_id).filter((id): id is string => Boolean(id))

  // Org-scoped again in its own right. The id list came from rows that were already
  // org-scoped, but a filter that depends on an earlier query being correct is not a
  // filter.
  const draftsResult = signalIds.length > 0
    ? await supabase
        .from('reply_drafts')
        .select('signal_id, tier, status, ai_draft_body, final_sent_body, sent_at, send_error')
        .eq('organisation_id', orgId)
        .in('signal_id', signalIds)
    : { data: [], error: null }

  if (draftsResult.error) {
    throw new Error(`Failed to fetch reply drafts: ${draftsResult.error.message}`)
  }

  const draftBySignal = new Map<string, OperatorReplyDraft>()
  for (const d of draftsResult.data ?? []) {
    if (!d.signal_id) continue
    draftBySignal.set(d.signal_id, {
      tier: d.tier,
      status: d.status,
      ai_draft_body: d.ai_draft_body ?? null,
      final_sent_body: d.final_sent_body ?? null,
      sent_at: d.sent_at ?? null,
      send_error: d.send_error ?? null,
    })
  }

  const replies: OperatorReply[] = rows.map((row) => {
    const signal = row.signal as
      { raw_data: unknown; original_outbound_body: string | null } | null
    const rawData = (signal?.raw_data ?? {}) as Record<string, unknown>
    const prospect = row.prospect as OperatorReplyProspect | null
    const intent = row.classified_intent as string

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
      intent,
      intent_label: INTENT_LABELS[intent] ?? intent,
      client_visible: CLIENT_VISIBLE.has(intent),
      confidence: row.classification_confidence ?? 0,
      reply_subject: typeof rawData.subject === 'string' ? rawData.subject : null,
      reply_body: extractReplyBody(rawData) ?? '',
      prompting_email: signal?.original_outbound_body ?? null,
      draft: row.signal_id ? draftBySignal.get(row.signal_id) ?? null : null,
      action_taken: row.action_taken,
      action_succeeded: row.action_succeeded ?? null,
    }
  })

  // Grouping and counting are deterministic code, per ADR-018. No judgement involved.
  const byIntent = new Map<string, OperatorReply[]>()
  for (const reply of replies) {
    const bucket = byIntent.get(reply.intent)
    if (bucket) bucket.push(reply)
    else byIntent.set(reply.intent, [reply])
  }

  // Known intents in reading order first, then anything the classifier produced that this
  // file has not been taught about. Appending rather than dropping means a new intent
  // shows up as an oddly-named group instead of vanishing from the operator's count.
  const knownFirst = INTENT_ORDER.filter(i => byIntent.has(i))
  const unknown = [...byIntent.keys()].filter(i => !INTENT_ORDER.includes(i as typeof INTENT_ORDER[number])).sort()

  const groups: OperatorReplyGroup[] = [...knownFirst, ...unknown].map((intent) => {
    const groupReplies = byIntent.get(intent) ?? []
    return {
      intent,
      label: INTENT_LABELS[intent] ?? intent,
      client_visible: CLIENT_VISIBLE.has(intent),
      count: groupReplies.length,
      replies: groupReplies,
    }
  })

  return {
    total: replies.length,
    hiddenFromClientCount: replies.filter(r => !r.client_visible).length,
    groups,
  }
}
