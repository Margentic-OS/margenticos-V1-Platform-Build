// Sequence composition handler — Option E per ADR-014.
// Called at send time to build a prospect's outbound email sequence.
// This is the only place where variant assignment and trigger application happen.
//
// Stateless: reads from DB and returns composed emails — never writes to strategy_documents.
// The caller is responsible for pushing the composed sequence to Instantly.
//
// Client isolation: every query filters by client_id. Never queries without client_id.

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { generatePersonalization, countWords } from './personalization'

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

interface ProspectRow {
  id: string
  organisation_id: string
  variant_id: string | null
  personalisation_trigger: string | null
  research_tier: string | null
  role: string | null
  first_name: string | null
  company_name: string | null
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

interface IcpContent {
  tier_1?: {
    four_forces?: { push?: string }
    pain_points?: string | string[]
    pain_point?: string
  }
  icp?: {
    tier_1?: {
      four_forces?: { push?: string }
      pain_points?: string | string[]
    }
  }
  // various field name conventions across ICP generations
  [key: string]: unknown
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function composeSequence({
  prospect_id,
  client_id,
}: {
  prospect_id: string
  client_id: string
}): Promise<ComposedSequence> {
  const supabase = getServiceClient()

  // Step 1 — Fetch the approved messaging document for this client.
  const messagingDoc = await fetchApprovedMessagingDoc(supabase, client_id)

  // Step 2 — Assign a variant if the prospect has none.
  const prospect = await fetchProspect(supabase, prospect_id, client_id)
  const variantId = await resolveVariant(supabase, prospect, messagingDoc, client_id)

  // Step 3 — Fetch the personalisation trigger (with ICP fallback).
  const trigger = await resolveTrigger(supabase, prospect, client_id)

  // Step 4 — Apply the trigger to email 1 of the assigned variant.
  const variantEmails  = getVariantEmails(messagingDoc, variantId)
  const afterTrigger   = applyTriggerToEmail1(variantEmails, trigger)

  // Step 4b — Haiku bridge + personalized CTA for Email 1.
  const clientValueHook = await fetchClientValueHook(supabase, client_id)
  const composedEmails  = await applyPersonalization(
    afterTrigger,
    prospect,
    trigger,
    clientValueHook,
  )

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
  client_id: string
): Promise<MessagingContent> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('content')
    .eq('organisation_id', client_id) // explicit isolation filter
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    throw new Error(
      `compose-sequence: no active messaging document found for client ${client_id}. ` +
      'Approve a messaging suggestion before composing sequences.'
    )
  }

  return data.content as MessagingContent
}

// ─── Step 2 — Resolve variant ─────────────────────────────────────────────────

async function fetchProspect(
  supabase: ServiceClient,
  prospect_id: string,
  client_id: string
): Promise<ProspectRow> {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, organisation_id, variant_id, personalisation_trigger, research_tier, role, first_name, company_name')
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
  client_id: string
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

  // Round-robin: assign the variant with the fewest prospects already assigned for this client.
  const { data: counts, error } = await supabase
    .from('prospects')
    .select('variant_id')
    .eq('organisation_id', client_id) // explicit isolation filter
    .not('variant_id', 'is', null)

  if (error) {
    logger.warn('compose-sequence: could not fetch variant counts, defaulting to A', {
      client_id,
      error: error.message,
    })
    return availableVariants[0]
  }

  const tally: Record<string, number> = {}
  for (const v of availableVariants) tally[v] = 0
  for (const row of (counts ?? [])) {
    const key = row.variant_id as string
    if (key in tally) tally[key]++
  }

  // Pick the variant with the lowest count (stable: first in alphabetical order on tie).
  const assigned = availableVariants.reduce((min, v) => (tally[v] < tally[min] ? v : min))

  // Write the assignment back to the prospect.
  const { error: updateError } = await supabase
    .from('prospects')
    .update({ variant_id: assigned, updated_at: new Date().toISOString() })
    .eq('id', prospect.id)
    .eq('organisation_id', client_id) // explicit isolation filter

  if (updateError) {
    logger.warn('compose-sequence: failed to write variant_id to prospect — proceeding anyway', {
      prospect_id: prospect.id,
      assigned,
      error: updateError.message,
    })
  }

  return assigned
}

// ─── Step 3 — Resolve personalisation trigger ─────────────────────────────────

async function resolveTrigger(
  supabase: ServiceClient,
  prospect: ProspectRow,
  client_id: string
): Promise<string> {
  // Use the stored trigger if present.
  const stored = prospect.personalisation_trigger?.trim()
  if (stored && stored.length > 0) return stored

  // Fallback: read tier 1 pain point from the ICP document.
  return fetchPainProxy(supabase, client_id, prospect.role)
}

async function fetchPainProxy(
  supabase: ServiceClient,
  client_id: string,
  prospectRole: string | null
): Promise<string> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('content')
    .eq('organisation_id', client_id) // explicit isolation filter
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    logger.warn('compose-sequence: ICP document not found for pain proxy fallback', { client_id })
    return buildRoleProxy(prospectRole)
  }

  const icpContent = data.content as IcpContent
  const painPoint = extractPainFromIcp(icpContent)

  if (painPoint) return painPoint

  logger.warn('compose-sequence: could not extract pain point from ICP, using role proxy', {
    client_id,
  })
  return buildRoleProxy(prospectRole)
}

// Tries several common JSON paths in the ICP content structure.
function extractPainFromIcp(content: IcpContent): string | null {
  const candidates: (string | undefined)[] = [
    // Most common path
    typeof content?.tier_1?.four_forces?.push === 'string'
      ? content.tier_1.four_forces.push
      : undefined,
    // Nested icp wrapper
    typeof content?.icp?.tier_1?.four_forces?.push === 'string'
      ? content.icp.tier_1.four_forces.push
      : undefined,
    // pain_points as string
    typeof content?.tier_1?.pain_points === 'string'
      ? content.tier_1.pain_points
      : undefined,
    typeof content?.tier_1?.pain_point === 'string'
      ? content.tier_1.pain_point
      : undefined,
    // pain_points as array — take first item
    Array.isArray(content?.tier_1?.pain_points) && content.tier_1!.pain_points!.length > 0
      ? (content.tier_1!.pain_points as string[])[0]
      : undefined,
  ]

  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed && trimmed.length > 10) return trimmed
  }

  return null
}

// Last-resort fallback when ICP has no extractable pain point.
function buildRoleProxy(role: string | null): string {
  const roleHint = role ? ` as a ${role}` : ''
  return `Most founders${roleHint} I speak to at this stage are dealing with the same pipeline problem.`
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
    if (firstNameIdx === -1) firstNameIdx = -1 // opener is line 0 in this case

    const openerIdx = lines.findIndex(
      (l, i) => i > firstNameIdx && l.trim().length > 0
    )

    if (openerIdx === -1) {
      // No opener found — prepend trigger to the body
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

// ─── Step 4b — Bridge + personalized CTA ─────────────────────────────────────

// Fetch the cold outreach hook from the active positioning doc.
// Used as context for the Haiku personalization call.
async function fetchClientValueHook(
  supabase: ServiceClient,
  client_id: string,
): Promise<string> {
  const { data } = await supabase
    .from('strategy_documents')
    .select('content')
    .eq('organisation_id', client_id)
    .eq('document_type', 'positioning')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return 'consistent outbound pipeline without founder involvement'

  const content = data.content as Record<string, unknown>
  const hook = (content?.key_messages as Record<string, string> | undefined)?.cold_outreach_hook
  return typeof hook === 'string' && hook.trim() ? hook.trim() : 'consistent outbound pipeline without founder involvement'
}

// Email 1 word limit and the pre-check threshold (90% of max = must have 10% headroom).
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

      const tier = prospect.research_tier ?? 'tier3'

      // Pre-check: skip bridge generation entirely if too little headroom.
      const currentWords   = countWords(email.body)
      const canFitBridge   = tier === 'tier1' && currentWords <= BRIDGE_HEADROOM

      const { bridge, cta } = await generatePersonalization({
        tier,
        triggerText:     trigger,
        prospectRole:    prospect.role,
        prospectCompany: prospect.company_name,
        clientValueHook,
      })

      let body = email.body

      // Insert bridge (Tier 1 only, word count gated).
      if (canFitBridge && bridge) {
        const bridgeWords = countWords(bridge)
        if (currentWords + bridgeWords <= EMAIL1_MAX_WORDS) {
          body = insertBridgeAfterTrigger(body, bridge)
        } else {
          logger.debug('compose-sequence: bridge skipped — would exceed word limit', {
            prospect_id: prospect.id,
            current_words: currentWords,
            bridge_words: bridgeWords,
          })
        }
      }

      // Replace existing CTA paragraph with personalized CTA (all tiers).
      body = replaceCtaParagraph(body, cta)

      return { ...email, body, word_count: countWords(body) }
    })
  )
}

// Insert bridge as a new paragraph immediately after the trigger line.
// Trigger is the first non-empty paragraph after {{first_name}}.
function insertBridgeAfterTrigger(body: string, bridge: string): string {
  const paragraphs = body.split('\n\n')
  const firstNameIdx = paragraphs.findIndex(p => p.trim() === '{{first_name}}')
  const triggerIdx   = paragraphs.findIndex((p, i) => i > firstNameIdx && p.trim().length > 0)
  if (triggerIdx === -1) return body

  const result = [...paragraphs]
  result.splice(triggerIdx + 1, 0, bridge)
  return result.join('\n\n')
}

// Replace the CTA paragraph (second-to-last non-empty paragraph, before sign-off).
function replaceCtaParagraph(body: string, cta: string): string {
  const paragraphs = body.split('\n\n')
  const nonEmpty   = paragraphs.map((p, i) => ({ p, i })).filter(({ p }) => p.trim().length > 0)

  // Last non-empty paragraph is the sign-off (sender's first name).
  // Second-to-last is the CTA to replace.
  if (nonEmpty.length < 2) return body

  const ctaEntry   = nonEmpty[nonEmpty.length - 2]
  const result     = [...paragraphs]
  result[ctaEntry.i] = cta
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
