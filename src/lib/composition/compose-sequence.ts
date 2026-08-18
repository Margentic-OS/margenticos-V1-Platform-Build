// Sequence composition handler — Option E per ADR-014.
// Called at send time to build a prospect's outbound email sequence.
// This is the only place where variant assignment and trigger application happen.
//
// Stateless: reads from DB and returns composed emails — never writes to strategy_documents.
// The caller is responsible for pushing the composed sequence to Instantly.
//
// Client isolation: every query filters by client_id. Never queries without client_id.
//
// Approval invariant (Addendum-2): every strategy_document fetch requires BOTH
//   status = 'active'  AND  client_approval_status = 'approved'
// If a required doc (Messaging) is absent or unapproved, composeSequence throws with a
// named reason. Optional enrichment docs (ICP pain proxy, Positioning value hook) fall
// back to safe defaults when absent; they never fall back to an unapproved version.
//
// Snapshot pattern: callers that compose multiple prospects for the same segment should
// call fetchComposeDocs() once after the approval gate passes and pass the result as
// preloadedDocs. This prevents a mid-batch race where a client revision between prospect N
// and prospect N+1 would cause later leads to compose from a new pending version.

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { generateBridge, countWords } from './personalization'

// Private type alias derived from getServiceClient (defined at bottom of file).
// Using the actual inferred return type avoids generic parameter conflicts with createClient overloads.
// eslint-disable-next-line @typescript-eslint/no-use-before-define
type ServiceClient = ReturnType<typeof getServiceClient>

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComposedEmail {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
}

export interface ComposedSequence {
  prospect_id: string
  client_id: string
  variant_id: string
  emails: ComposedEmail[]
}

// Pre-fetched approved docs for a segment — passed into composeSequence to avoid
// per-prospect DB fetches and prevent the mid-batch race (Addendum-2).
export interface ComposeDocs {
  /** Active + approved Messaging doc content for this segment. Required. */
  messagingDoc: MessagingContent
  /** strategy_documents.id for the Messaging doc (required for version tracking). */
  messagingDocId: string
  /** Pre-extracted pain point string from the active + approved ICP doc (optional enrichment). */
  icpPainPoint?: string
  /** Pre-extracted cold_outreach_hook from the active + approved Positioning doc (optional enrichment). */
  positioningValueHook?: string
}

interface ProspectRow {
  id: string
  organisation_id: string
  segment_id: string | null
  variant_id: string | null
  personalisation_trigger: string | null
  has_dateable_signal: boolean | null
  signal_relevance: string | null
  /** Written by the (currently orphaned) research agent. NULL for every sourced prospect. */
  role: string | null
  /** Written by the sourcing orchestrator. The populated field in practice. */
  job_title: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
}

// Where email 1's opening line came from. Only 'research' represents a real, prospect-
// specific observation; the other two are segment-level defaults that say nothing
// individual about the prospect.
type TriggerSource = 'research' | 'icp_pain' | 'role_proxy'

interface ResolvedTrigger {
  text: string
  source: TriggerSource
}

interface StoredEmail {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
}

interface VariantDoc {
  emails: StoredEmail[]
}

interface MessagingContent {
  variants?: Record<string, VariantDoc>
  // legacy single-sequence format — handled for backward compat
  emails?: StoredEmail[]
}

// The ICP generation agent may emit push forces and pain points either as a single
// string or as an array of strings. Both shapes are valid and both must be readable
// here — an array-shaped four_forces.push silently fell through to the role proxy
// for months because only the string shape was accepted.
type PainField = string | string[]

interface IcpContent {
  tier_1?: {
    four_forces?: { push?: PainField }
    pain_points?: PainField
    pain_point?: PainField
  }
  icp?: {
    tier_1?: {
      four_forces?: { push?: PainField }
      pain_points?: PainField
    }
  }
  [key: string]: unknown
}

// Re-export MessagingContent so callers can type ComposeDocs correctly.
export type { MessagingContent }

// ─── Snapshot fetch — call once at gate-pass per segment ─────────────────────

// Returns the approved docs for a segment for use as a preloaded snapshot.
// Throws if the Messaging doc is absent or unapproved (same invariant as compose itself).
// ICP and Positioning are optional enrichments — missing/unapproved falls back to defaults.
export async function fetchComposeDocs(
  supabase: ServiceClient,
  client_id: string,
  segment_id: string | null,
): Promise<ComposeDocs> {
  // Resolve primary segment for null prospects — same logic as compose itself.
  let resolvedSegmentId = segment_id
  if (!resolvedSegmentId) {
    const { data: primarySeg } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', client_id)
      .eq('is_default', true)
      .single()
    resolvedSegmentId = primarySeg?.id ?? null
  }

  // Messaging: required — throw if absent or unapproved.
  const { content: messagingDoc, doc_id: messagingDocId } = await fetchApprovedMessagingDoc(supabase, client_id, resolvedSegmentId)

  // ICP: optional enrichment — extract pain point if approved.
  const icpPainPoint = await fetchApprovedIcpPainPoint(supabase, client_id, resolvedSegmentId)

  // Positioning: optional enrichment — extract value hook if approved.
  const positioningValueHook = await fetchApprovedPositioningHook(supabase, client_id)

  return { messagingDoc, messagingDocId, icpPainPoint, positioningValueHook }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function composeSequence({
  prospect_id,
  client_id,
  preloadedDocs,
}: {
  prospect_id: string
  client_id: string
  /** Pre-fetched approved docs from fetchComposeDocs(). Skips per-prospect DB fetches when provided. */
  preloadedDocs?: ComposeDocs
}): Promise<ComposedSequence> {
  const supabase = getServiceClient()

  // Step 2 — Fetch the prospect first so we have segment_id for the messaging lookup.
  const prospect = await fetchProspect(supabase, prospect_id, client_id)

  // Step 1 — Use preloaded Messaging doc or fetch it (with approval check).
  let messagingDoc: MessagingContent
  let messagingDocId: string
  if (preloadedDocs) {
    messagingDoc = preloadedDocs.messagingDoc
    messagingDocId = preloadedDocs.messagingDocId
  } else {
    const fetched = await fetchApprovedMessagingDoc(supabase, client_id, prospect.segment_id)
    messagingDoc = fetched.content
    messagingDocId = fetched.doc_id
  }

  // Step 3 — Assign a variant if the prospect has none, and write both variant_id and messaging_doc_id.
  const variantId = await resolveVariant(supabase, prospect, messagingDoc, client_id, messagingDocId)

  // Step 4 — Fetch the personalisation trigger (with ICP fallback).
  const trigger = await resolveTrigger(supabase, prospect, client_id, preloadedDocs?.icpPainPoint)

  // Step 4 — Apply the trigger to email 1 of the assigned variant.
  const variantEmails  = getVariantEmails(messagingDoc, variantId)
  const afterTrigger   = applyTriggerToEmail1(variantEmails, trigger.text)

  // Step 4b — Haiku bridge + personalised CTA for Email 1.
  //
  // FAIL CLOSED: this step only runs when the trigger came from real prospect research.
  // Without a researched trigger there is nothing prospect-specific to build from, and
  // the machine step would overwrite client-approved template copy with something
  // weaker. Standing principle: no machine step may overwrite human-approved copy
  // after approval without an explicit gate. The gate is the researched trigger.
  let composedEmails: ComposedEmail[]

  if (trigger.source === 'research') {
    const clientValueHook = preloadedDocs?.positioningValueHook
      ?? await fetchApprovedPositioningHook(supabase, client_id)
      ?? 'consistent outbound pipeline without founder involvement'

    composedEmails = await applyPersonalization(
      afterTrigger,
      prospect,
      trigger.text,
      clientValueHook,
    )
  } else {
    // Skipped, not failed. Logged explicitly so "skipped" is never mistaken for
    // "succeeded" when reading logs after a send.
    logger.info('compose-sequence: personalisation skipped — approved template copy preserved verbatim', {
      prospect_id: prospect.id,
      client_id,
      variant_id: variantId,
      trigger_source: trigger.source,
      reason: prospect.personalisation_trigger
        ? 'trigger is not from prospect research'
        : 'prospects.personalisation_trigger is NULL (no research result)',
      bridge_generated: false,
      cta_rewritten: false,
    })
    // Recompute word_count: applyTriggerToEmail1 carries the stored template's count,
    // which is stale once the opener line has been replaced.
    composedEmails = afterTrigger.map(email => ({ ...email, word_count: countWords(email.body) }))
  }

  // Step 5 — Return the composed sequence.
  return {
    prospect_id,
    client_id,
    variant_id: variantId,
    emails: composedEmails,
  }
}

// ─── Step 1 — Fetch approved messaging document ───────────────────────────────

async function fetchApprovedMessagingDoc(
  supabase: ServiceClient,
  client_id: string,
  segment_id: string | null
): Promise<{ content: MessagingContent; doc_id: string }> {
  // Resolve primary segment if null — NULL-segment prospects must never error.
  let resolvedSegmentId = segment_id
  if (!resolvedSegmentId) {
    const { data: primarySeg } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', client_id)
      .eq('is_default', true)
      .single()
    resolvedSegmentId = primarySeg?.id ?? null
  }

  // Both status='active' AND client_approval_status='approved' required.
  const baseQuery = () =>
    supabase
      .from('strategy_documents')
      .select('id, content')
      .eq('organisation_id', client_id)
      .eq('document_type', 'messaging')
      .eq('status', 'active')
      .eq('client_approval_status', 'approved')
      .order('created_at', { ascending: false })
      .limit(1)

  // Fetch segment-specific messaging when we have a resolved segment.
  if (resolvedSegmentId) {
    const { data: segData } = await baseQuery().eq('segment_id', resolvedSegmentId).maybeSingle()
    if (segData) return { content: segData.content as MessagingContent, doc_id: segData.id }
  }

  // Fallback: any approved messaging doc for this client.
  const { data, error } = await baseQuery().single()

  if (error || !data) {
    throw new Error(
      `compose-sequence: no active + approved Messaging document found for client ${client_id}. ` +
      'The client must approve the Messaging document before sequences can be composed.'
    )
  }

  return { content: data.content as MessagingContent, doc_id: data.id }
}

// ─── Approved ICP pain point — optional enrichment ───────────────────────────

async function fetchApprovedIcpPainPoint(
  supabase: ServiceClient,
  client_id: string,
  segment_id: string | null,
): Promise<string | undefined> {
  const baseQuery = () =>
    supabase
      .from('strategy_documents')
      .select('content')
      .eq('organisation_id', client_id)
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .eq('client_approval_status', 'approved')
      .order('created_at', { ascending: false })
      .limit(1)

  let content: IcpContent | null = null

  if (segment_id) {
    const { data } = await baseQuery().eq('segment_id', segment_id).maybeSingle()
    if (data) content = data.content as IcpContent
  }

  if (!content) {
    const { data } = await baseQuery().maybeSingle()
    if (data) content = data.content as IcpContent
  }

  return content ? extractPainFromIcp(content) ?? undefined : undefined
}

// ─── Approved Positioning value hook — optional enrichment ───────────────────

// Exported so fetchComposeDocs can call it and so callers that need just the hook can too.
export async function fetchApprovedPositioningHook(
  supabase: ServiceClient,
  client_id: string,
): Promise<string | undefined> {
  const { data } = await supabase
    .from('strategy_documents')
    .select('content')
    .eq('organisation_id', client_id)
    .eq('document_type', 'positioning')
    .eq('status', 'active')
    .eq('client_approval_status', 'approved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return undefined

  const content = data.content as Record<string, unknown>
  const hook = (content?.key_messages as Record<string, string> | undefined)?.cold_outreach_hook
  return typeof hook === 'string' && hook.trim() ? hook.trim() : undefined
}

// ─── Step 2 — Resolve variant ─────────────────────────────────────────────────

async function fetchProspect(
  supabase: ServiceClient,
  prospect_id: string,
  client_id: string
): Promise<ProspectRow> {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, organisation_id, segment_id, variant_id, personalisation_trigger, has_dateable_signal, signal_relevance, role, job_title, first_name, last_name, company_name')
    .eq('id', prospect_id)
    .eq('organisation_id', client_id) // explicit isolation filter
    .single()

  if (error || !data) {
    throw new Error(
      `compose-sequence: prospect ${prospect_id} not found for client ${client_id}.`
    )
  }

  return data as ProspectRow
}

async function resolveVariant(
  supabase: ServiceClient,
  prospect: ProspectRow,
  messagingDoc: MessagingContent,
  client_id: string,
  messagingDocId: string
): Promise<string> {
  // If already assigned, use it — never reassign.
  if (prospect.variant_id) return prospect.variant_id

  // Determine available variant keys from the messaging document.
  const availableVariants = messagingDoc.variants
    ? Object.keys(messagingDoc.variants).sort()
    : ['A', 'B', 'C', 'D']

  if (availableVariants.length === 0) {
    throw new Error('compose-sequence: messaging document has no variants to assign.')
  }

  // Deterministic assignment: stable hash of prospect.id modulo variant count.
  // No database read. Distribution is stable across runs for same prospect.
  let hash = 0
  for (const char of prospect.id) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash = hash & hash // Convert to 32-bit integer
  }
  const assigned = availableVariants[Math.abs(hash) % availableVariants.length]

  // Write both variant_id and messaging_doc_id together. Fail if write fails.
  const { error: updateError } = await supabase
    .from('prospects')
    .update({ variant_id: assigned, messaging_doc_id: messagingDocId, updated_at: new Date().toISOString() })
    .eq('id', prospect.id)
    .eq('organisation_id', client_id) // explicit isolation filter

  if (updateError) {
    throw new Error(
      `compose-sequence: failed to assign variant to prospect ${prospect.id}: ${updateError.message}`
    )
  }

  return assigned
}

// ─── Step 3 — Resolve personalisation trigger ─────────────────────────────────

async function resolveTrigger(
  supabase: ServiceClient,
  prospect: ProspectRow,
  client_id: string,
  preloadedIcpPainPoint?: string,
): Promise<ResolvedTrigger> {
  // Use the stored trigger if present. This is the only prospect-specific source.
  const stored = prospect.personalisation_trigger?.trim()
  if (stored && stored.length > 0) return { text: stored, source: 'research' }

  // Use pre-fetched ICP pain point if available.
  if (preloadedIcpPainPoint) return { text: preloadedIcpPainPoint, source: 'icp_pain' }

  // Fallback: read tier 1 pain point from the segment's approved ICP document.
  // role is written only by the research agent; job_title by the sourcing orchestrator.
  return fetchPainProxy(
    supabase,
    client_id,
    prospect.segment_id,
    prospect.role ?? prospect.job_title,
  )
}

async function fetchPainProxy(
  supabase: ServiceClient,
  client_id: string,
  segment_id: string | null,
  prospectRole: string | null
): Promise<ResolvedTrigger> {
  // Resolve primary segment for null — same pattern as messaging fetch.
  let resolvedSegmentId = segment_id
  if (!resolvedSegmentId) {
    const { data: primarySeg } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', client_id)
      .eq('is_default', true)
      .single()
    resolvedSegmentId = primarySeg?.id ?? null
  }

  // Both status='active' AND client_approval_status='approved' required.
  const baseQuery = () =>
    supabase
      .from('strategy_documents')
      .select('content')
      .eq('organisation_id', client_id)
      .eq('document_type', 'icp')
      .eq('status', 'active')
      .eq('client_approval_status', 'approved')
      .order('created_at', { ascending: false })
      .limit(1)

  if (resolvedSegmentId) {
    const { data: segData } = await baseQuery().eq('segment_id', resolvedSegmentId).maybeSingle()
    if (segData) {
      const painPoint = extractPainFromIcp(segData.content as IcpContent)
      if (painPoint) return { text: painPoint, source: 'icp_pain' }
    }
  }

  const { data } = await baseQuery().maybeSingle()

  if (!data) {
    // No approved ICP doc — fall back to role proxy (safe default, not unapproved content).
    // Error level, not warn: reaching the generic proxy means every prospect in this
    // segment gets the same opener. That is a copy-quality incident, not a nuisance.
    logger.error('compose-sequence: no active + approved ICP document found — falling back to generic role proxy', {
      client_id,
      segment_id: resolvedSegmentId,
    })
    return { text: buildRoleProxy(prospectRole), source: 'role_proxy' }
  }

  const painPoint = extractPainFromIcp(data.content as IcpContent)
  if (painPoint) return { text: painPoint, source: 'icp_pain' }

  // Extraction found nothing on any known path. Log the shape we actually got so the
  // next schema drift is diagnosable from one log line instead of a database dig.
  const icpContent = data.content as IcpContent
  logger.error('compose-sequence: could not extract pain point from approved ICP — falling back to generic role proxy', {
    client_id,
    segment_id: resolvedSegmentId,
    tier_1_keys: icpContent?.tier_1 ? Object.keys(icpContent.tier_1) : null,
    push_type: Array.isArray(icpContent?.tier_1?.four_forces?.push)
      ? 'array'
      : typeof icpContent?.tier_1?.four_forces?.push,
  })
  return { text: buildRoleProxy(prospectRole), source: 'role_proxy' }
}

// Reads a pain field that may be a plain string or an array of strings.
// Arrays yield their FIRST usable element — the ICP agent orders push forces by
// strength, so element zero is the primary pain.
function firstPainString(field: PainField | undefined): string | undefined {
  if (typeof field === 'string') return field
  if (Array.isArray(field)) {
    for (const entry of field) {
      if (typeof entry === 'string' && entry.trim().length > 0) return entry
    }
  }
  return undefined
}

// Tries several common JSON paths in the ICP content structure.
// Each path accepts both the string and array shapes.
function extractPainFromIcp(content: IcpContent): string | null {
  const candidates: (string | undefined)[] = [
    firstPainString(content?.tier_1?.four_forces?.push),
    firstPainString(content?.icp?.tier_1?.four_forces?.push),
    firstPainString(content?.tier_1?.pain_points),
    firstPainString(content?.tier_1?.pain_point),
    firstPainString(content?.icp?.tier_1?.pain_points),
  ]

  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed && trimmed.length > 10) return trimmed
  }

  return null
}

// ─── Role proxy — last-resort opener when ICP has no extractable pain point ───
//
// Deterministic, no LLM (ADR-018). Callers pass role, falling back to job_title.
//
// This must never assume the prospect's seniority, company stage, or business model.
// The previous version hardcoded "founders", which is wrong for any client whose
// buyer is not a founder and violates the industry-agnosticism rule in CLAUDE.md.

const TITLE_CONNECTOR_RE = /\s*(?:\band\b|&|,|\/)\s*/i

// Pluralises a single word. Preserves acronyms (CEO -> CEOs), lowercases prose words
// so the result reads naturally mid-sentence (Chief -> chief).
function pluraliseTitleWord(word: string, isLastWord: boolean): string {
  const isAcronym = word.length <= 5 && word === word.toUpperCase() && /[A-Z]/.test(word)
  const base = isAcronym ? word : word.toLowerCase()
  if (!isLastWord) return base

  const lower = base.toLowerCase()
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return `${base}es`
  if (/[^aeiou]y$/.test(lower)) return `${base.slice(0, -1)}ies`
  return `${base}s`
}

// Pluralises every word in a segment, inflecting only the final one.
function pluraliseSegment(segment: string): string | null {
  const words = segment.split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return null
  return words.map((w, i) => pluraliseTitleWord(w, i === words.length - 1)).join(' ')
}

// Lowercases a segment for mid-sentence use, preserving acronyms.
function normaliseSegment(segment: string): string {
  return segment
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => (w.length <= 5 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(' ')
}

// Converts a raw job title into a plural noun phrase usable mid-sentence.
// "Chief Executive Officer and Managing Partner" -> "chief executive officers"
// "CEO"                                          -> "CEOs"
// "VP of Operations"                             -> "VPs of operations"
// "Head of Logistics"                            -> "heads of logistics"
// Returns null when the title yields nothing usable.
export function pluraliseRoleTitle(title: string | null): string | null {
  if (!title || title.trim().length === 0) return null

  // Compound titles ("X and Y", "X / Y") read badly when pluralised whole.
  // Take the first segment only.
  const primary = title.split(TITLE_CONNECTOR_RE)[0]?.trim()
  if (!primary) return null

  // In "<head> of <scope>" titles the noun to pluralise is the head, not the scope.
  // "VP of Operations" pluralises to "VPs of operations", never "VP of operationses".
  const ofMatch = primary.match(/^(.+?)\s+of\s+(.+)$/i)
  if (ofMatch) {
    const head = pluraliseSegment(ofMatch[1].trim())
    const scope = normaliseSegment(ofMatch[2].trim())
    if (head && scope) return `${head} of ${scope}`
  }

  return pluraliseSegment(primary)
}

// Last-resort fallback when ICP has no extractable pain point.
// roleOrTitle: prospects.role when set, else prospects.job_title.
function buildRoleProxy(roleOrTitle: string | null): string {
  const plural = pluraliseRoleTitle(roleOrTitle)
  const subject = plural ?? 'people'
  return `Most ${subject} I speak to at this stage are dealing with the same pipeline problem.`
}

// ─── Step 4 — Apply trigger to email 1 ───────────────────────────────────────

function getVariantEmails(messagingDoc: MessagingContent, variantId: string): StoredEmail[] {
  // Four-variant format (ADR-014 Option E)
  if (messagingDoc.variants) {
    const variant = messagingDoc.variants[variantId]
    if (variant?.emails && variant.emails.length > 0) return variant.emails

    // Requested variant not found — log and use first available
    const firstKey = Object.keys(messagingDoc.variants)[0]
    logger.warn(
      `compose-sequence: variant "${variantId}" not in messaging document, falling back to "${firstKey}"`,
    )
    return messagingDoc.variants[firstKey]?.emails ?? []
  }

  // Legacy single-sequence format (pre-ADR-014)
  if (messagingDoc.emails && messagingDoc.emails.length > 0) {
    return messagingDoc.emails
  }

  throw new Error(
    `compose-sequence: messaging document has no emails in any recognised format.`
  )
}

// Applies the personalisation trigger to the opening sentence of email 1.
// The trigger replaces the first non-empty line after {{first_name}}.
// The rest of the email is unchanged. Emails 2-4 are untouched.
function applyTriggerToEmail1(emails: StoredEmail[], trigger: string): ComposedEmail[] {
  return emails.map(email => {
    if (email.sequence_position !== 1) return email

    // Ensure trigger ends with a full stop.
    const formattedTrigger = trigger.trimEnd().endsWith('.')
      ? trigger.trimEnd()
      : trigger.trimEnd() + '.'

    const lines = email.body.split('\n')

    // Find {{first_name}} line and the opener (first non-empty line after it).
    let firstNameIdx = lines.findIndex(l => l.trim() === '{{first_name}}')
    if (firstNameIdx === -1) firstNameIdx = -1

    const openerIdx = lines.findIndex(
      (l, i) => i > firstNameIdx && l.trim().length > 0
    )

    if (openerIdx === -1) {
      return {
        ...email,
        body: `{{first_name}}\n\n${formattedTrigger}\n\n${email.body}`.trim(),
      }
    }

    const newLines = [...lines]
    newLines[openerIdx] = formattedTrigger

    return { ...email, body: newLines.join('\n') }
  })
}

// ─── Step 4b — Bridge sentence ───────────────────────────────────────────────
//
// The CTA rewrite was REMOVED here. It overwrote the client-approved template CTA
// with machine copy on every prospect, and produced worse copy than the line it
// replaced even when a real researched trigger existed. The approved CTA now
// survives verbatim in every case.
//
// What remains is the bridge: an ADDITIVE sentence inserted after the trigger,
// gated on a genuine researched signal. It never overwrites approved copy.

const EMAIL1_MAX_WORDS  = 90
const BRIDGE_HEADROOM   = Math.floor(EMAIL1_MAX_WORDS * 0.9)  // 81 words

async function applyPersonalization(
  emails: ComposedEmail[],
  prospect: ProspectRow,
  trigger: string,
  clientValueHook: string,
): Promise<ComposedEmail[]> {
  return Promise.all(
    emails.map(async email => {
      if (email.sequence_position !== 1) return email

      // word_count is always recomputed on email 1: the stored count came from the
      // template, and applyTriggerToEmail1 has already replaced the opener by now.
      const withCount = (body: string): ComposedEmail =>
        ({ ...email, body, word_count: countWords(body) })

      // Bridge requires a signal the research agent graded strong enough to reference.
      const useBridgePath = prospect.has_dateable_signal === true && prospect.signal_relevance === 'use_as_hook'
      if (!useBridgePath) return withCount(email.body)

      const currentWords = countWords(email.body)
      if (currentWords > BRIDGE_HEADROOM) {
        logger.debug('compose-sequence: bridge skipped — email already at word ceiling', {
          prospect_id: prospect.id,
          current_words: currentWords,
          headroom: BRIDGE_HEADROOM,
        })
        return withCount(email.body)
      }

      const { bridge } = await generateBridge({
        triggerText:       trigger,
        prospectRole:      prospect.role,
        prospectFirstName: prospect.first_name,
        clientValueHook,
      })

      if (!bridge) {
        logger.debug('compose-sequence: bridge skipped — generator returned nothing', {
          prospect_id: prospect.id,
        })
        return withCount(email.body)
      }

      const bridgeWords = countWords(bridge)
      if (currentWords + bridgeWords > EMAIL1_MAX_WORDS) {
        logger.debug('compose-sequence: bridge skipped — would exceed word limit', {
          prospect_id: prospect.id,
          current_words: currentWords,
          bridge_words: bridgeWords,
          limit: EMAIL1_MAX_WORDS,
        })
        return withCount(email.body)
      }

      return withCount(insertBridgeAfterTrigger(email.body, bridge))
    })
  )
}

// Insert bridge as a new paragraph immediately after the trigger line.
function insertBridgeAfterTrigger(body: string, bridge: string): string {
  const paragraphs = body.split('\n\n')
  const firstNameIdx = paragraphs.findIndex(p => p.trim() === '{{first_name}}')
  const triggerIdx   = paragraphs.findIndex((p, i) => i > firstNameIdx && p.trim().length > 0)
  if (triggerIdx === -1) return body

  const result = [...paragraphs]
  result.splice(triggerIdx + 1, 0, bridge)
  return result.join('\n\n')
}

// ─── Supabase client ──────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'compose-sequence: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.'
    )
  }
  return createClient(url, key)
}

// Export getServiceClient for use by fetchComposeDocs when called from outside this module.
export { getServiceClient as getComposeServiceClient }
