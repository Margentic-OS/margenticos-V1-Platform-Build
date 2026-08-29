// ICP Generation Agent
// Entry point for generating the Ideal Client Profile document.
// Model: claude-opus-4-6
// Prompt: /docs/prompts/icp-agent.md
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: no prompt references any data source outside current client context
//
// OUTPUT: writes to document_suggestions only — never to strategy_documents directly.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { assertNoUnsourcedVendorNames } from '@/lib/agents/vendor-name-gate'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { runResearchQueries, formatResearchForPrompt, type ResearchBundle } from '@/lib/agents/tools/webSearch'
import { fetchWebsiteContext, formatWebsiteContextForPrompt, countTruncatedPages, type WebsitePageContext } from '@/lib/agents/website-context'
import { scrubAITellsDeep, assertNoDashes } from '@/lib/style/customer-facing-style-rules'
import { buildRegenerationNotesBlock, buildRegenerationNotesReason, type RegenerationNotes } from '@/lib/agents/regeneration-notes'

// The model specified in the PRD for document generation agents.
const ICP_MODEL = 'claude-opus-4-6'

// Maximum tokens for the ICP response. 8192 needed — three full tiers with all fields
// can exceed 4096 tokens, causing truncated JSON that fails to parse.
const MAX_TOKENS = 8192

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IcpAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Segment this generation run is scoped to. NULL = org-level (should not occur for ICP). */
  segment_id?: string | null
  /** Optional: if true, includes existing ICP document content for refresh context. */
  is_refresh?: boolean
  /** Optional: notes on the rejected suggestion this run replaces. See ADR-038. */
  regeneration_notes?: RegenerationNotes
}

export interface IcpAgentResult {
  suggestion_id: string
  organisation_id: string
  document_type: 'icp'
  status: 'pending'
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

interface PatternRow {
  pattern_type: string
  pattern_data: Record<string, unknown>
  sample_size: number
  confidence_score: number | null
}

interface ExistingDocument {
  id: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
}

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runIcpGenerationAgent(
  input: IcpAgentInput
): Promise<IcpAgentResult> {
  const { organisation_id, supabase, segment_id = null, is_refresh = false } = input
  const regeneration_notes = input.regeneration_notes

  logger.info('ICP agent: starting', { organisation_id, segment_id, is_refresh })

  const agentRun = await startAgentRun({ organisation_id, agent_name: 'icp-generation' })

  // Overall agent guard: fail gracefully at 240s (60s before Vercel's 300s ceiling)
  // to ensure agentRun.fail() can complete before the platform kills the function.
  const AGENT_TIMEOUT_MS = 240 * 1000
  let timeoutHandle: NodeJS.Timeout | null = null

  try {
    // Set up the timeout guard.
    timeoutHandle = setTimeout(async () => {
      const msg = 'ICP agent: execution exceeded 240s timeout guard — failing gracefully'
      logger.error(msg, { organisation_id })
      await agentRun.fail(msg)
    }, AGENT_TIMEOUT_MS)

    // Step 1: Fetch intake responses for this client only.
  // Explicit organisation_id filter + RLS enforces isolation.
  const intake = await fetchIntakeResponses(supabase, organisation_id)

  if (intake.length === 0) {
    throw new Error(
      `ICP agent: no intake responses found for organisation ${organisation_id}. ` +
      'At least some intake data is required to generate an ICP.'
    )
  }

  // Step 2: Check completeness — warn if below 80% critical fields answered.
  const criticalFields = intake.filter(r => r.is_critical)
  const answeredCritical = criticalFields.filter(
    r => r.response_value && r.response_value.trim().length > 0
  )
  const completeness = criticalFields.length > 0
    ? Math.round((answeredCritical.length / criticalFields.length) * 100)
    : 0

  if (completeness < 80) {
    logger.warn(
      `ICP agent: intake completeness is ${completeness}% — below 80% threshold. Proceeding but quality may be lower.`,
      { organisation_id, completeness }
    )
  }

  // Step 3: Fetch existing ICP document if this is a refresh.
  let existingDocument: ExistingDocument | null = null
  if (is_refresh) {
    existingDocument = await fetchExistingIcpDocument(supabase, organisation_id)
  }

  // Step 4: Read patterns table (cross-client, read-only, may be empty in phase one).
  const patterns = await fetchPatterns(supabase)

  // Step 5: Fetch uploaded reference docs (ICP docs and case studies).
  const refDocs = await fetchUploadedRefDocs(supabase, organisation_id)
  if (refDocs.length > 0) {
    logger.info('ICP agent: found uploaded reference docs', {
      organisation_id, count: refDocs.length,
    })
  }

  // Step 5b: Fetch website pages fetched at intake time.
  const websitePages = await fetchWebsiteContext(supabase, organisation_id, 'ICP agent')
  const truncatedPageCount = countTruncatedPages(websitePages)
  if (websitePages.length > 0) {
    logger.info('ICP agent: found website pages', {
      organisation_id,
      count: websitePages.length,
      truncated: truncatedPageCount,
    })
  }

  // Step 6: Run web research — market intelligence to inform the ICP.
  // Queries are derived from the client's intake data, not hardcoded.
  // Research INFORMS the ICP — it does not override intake. Conflicts are flagged
  // in the affected field's own text, not silently resolved. Fails gracefully if unavailable.
  // Note: suggestion_reason is built in code further down and the model cannot write to it.
  // A plan may decline to search. "Research was skipped because intake never named a
  // buyer" and "research ran and found nothing" are different facts about a document and
  // only the first is actionable, so they are reported as different sentences rather than
  // collapsed into the provider-shaped one.
  const researchPlan = buildResearchPlan(intake)

  let research: ResearchBundle
  if (researchPlan.skipped) {
    logger.warn('ICP agent: web research skipped, intake supplied no buyer descriptor', {
      organisation_id,
      buyerSource: researchPlan.buyerSource,
    })
    // Nothing is sent to the provider. An empty bundle is the honest representation of
    // "no search ran": anyLimited stays false, so the limited-results note is not
    // emitted alongside the skip note and the operator sees one explanation, not two.
    research = { results: [], anyLimited: false, limitedNote: '' }
  } else {
    logger.info('ICP agent: running web research', {
      organisation_id,
      buyerSource: researchPlan.buyerSource,
      queryCount: researchPlan.queries.length,
    })
    research = await runResearchQueries(researchPlan.queries)

    if (research.anyLimited) {
      logger.warn('ICP agent: some research queries returned limited results', {
        organisation_id,
        limitedNote: research.limitedNote,
      })
    }
  }

  // Step 7: Build the user message from intake data + research + uploaded docs + website.
  const userMessage = buildUserMessage({
    organisation_id,
    intake,
    existingDocument,
    patterns,
    completeness,
    research,
    researchSkipped: researchPlan.skipped,
    refDocs,
    websitePages,
    regeneration_notes,
  })

  // Step 7: Call Claude.
  logger.info('ICP agent: calling Claude', { organisation_id, model: ICP_MODEL })
  const generatedContent = await callClaude(userMessage)

  // Step 8: Validate the response is parseable JSON before writing anything.
  let parsedDocument: Record<string, unknown>
  try {
    parsedDocument = JSON.parse(generatedContent)
  } catch {
    throw new Error(
      'ICP agent: Claude returned content that is not valid JSON. ' +
      'Raw response has been logged. Do not write to the database.'
    )
  }

  // Gate: scrub em-dashes and AI tells from all prose string values in the document.
  // Operates on string values only — never changes JSON structure.
  const scrubbedDocument = scrubAITellsDeep(parsedDocument, 'icp-agent')
  assertNoDashes(scrubbedDocument, 'icp-agent')

  // Vendor-name gate. REPORT-ONLY until 2026-09-04: logs every hit with the
  // field and whether the input message supplied the name, and throws only in block mode.
  // The input message is literally what the model was given, which is what makes the
  // sourcedness test Rule 9's own test rather than a new one.
  assertNoUnsourcedVendorNames(scrubbedDocument, userMessage, {
    agent: 'icp-agent',
    organisation_id,
    document_type: 'icp',
  })
  const scrubbedContent = JSON.stringify(scrubbedDocument)

  // Step 9: Write to document_suggestions — never to strategy_documents directly.
  const suggestionId = await writeDocumentSuggestion(supabase, {
    organisation_id,
    segment_id,
    existingDocument,
    generatedContent: scrubbedContent,
    parsedDocument: scrubbedDocument,
    intake,
    completeness,
    is_refresh,
    researchLimitedNote:
      researchPlan.skipReason || researchPlan.descriptorNote + research.limitedNote,
    truncatedPageCount,
    regeneration_notes,
  })

  logger.info('ICP agent: suggestion written successfully', { organisation_id, suggestion_id: suggestionId })

  await agentRun.complete(`suggestion_id: ${suggestionId}`)

  if (timeoutHandle) clearTimeout(timeoutHandle)

  return {
    suggestion_id: suggestionId,
    organisation_id,
    document_type: 'icp',
    status: 'pending',
  }

  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(message)
    throw err
  }
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchIntakeResponses(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<IntakeRow[]> {
  const { data, error } = await supabase
    .from('intake_responses')
    .select('field_key, field_label, response_value, section, is_critical')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .order('section')

  if (error) {
    throw new Error(`ICP agent: failed to fetch intake responses — ${error.message}`)
  }

  return (data ?? []) as IntakeRow[]
}

async function fetchExistingIcpDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<ExistingDocument | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    // .single() throws if no row — treat as no existing document
    return null
  }

  return data as ExistingDocument
}

async function fetchPatterns(supabase: SupabaseClient): Promise<PatternRow[]> {
  // Patterns are cross-client aggregated data — the only permitted cross-client read.
  // Handle empty gracefully: phase one will have no patterns.
  const { data, error } = await supabase
    .from('patterns')
    .select('pattern_type, pattern_data, sample_size, confidence_score')
    .order('confidence_score', { ascending: false })
    .limit(20)

  if (error) {
    // Non-fatal: patterns are supplementary. Log and continue.
    logger.warn('ICP agent: could not fetch patterns — continuing without them', { error: error.message })
    return []
  }

  return (data ?? []) as PatternRow[]
}

interface UploadedRefDoc {
  filename: string
  purpose: string
  text: string
}

async function fetchUploadedRefDocs(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<UploadedRefDoc[]> {
  const { data, error } = await supabase
    .from('intake_files')
    .select('original_filename, file_purpose, extracted_text')
    .eq('organisation_id', organisation_id)
    .in('file_purpose', ['icp_doc', 'case_study'])
    .eq('extraction_status', 'complete')

  if (error) {
    logger.warn('ICP agent: could not fetch uploaded reference docs — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []).map(row => ({
    filename: row.original_filename as string,
    purpose: row.file_purpose as string,
    text: (row.extracted_text ?? '') as string,
  })).filter(d => d.text.trim().length > 0)
}

// ─── Research query builder ───────────────────────────────────────────────────

// Splits text into sentences and keeps whole ones up to a word budget.
//
// WHY WHOLE SENTENCES. The previous version took the first N words flat, which cut mid
// clause and left a dangling fragment on the end of the search term. The one live
// ideal-client answer that passes the usability check below produced
// "... 15-80 staff. Usually the founder is", and those last four words are a subject
// with no predicate. They are noise to a search engine and they were in every query.
//
// If the FIRST sentence alone is over budget there is nothing to keep whole, so it is cut
// at the budget as before. That is the honest fallback, not a special case.
function firstSentences(text: string, maxWords: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0)
  const kept: string[] = []
  let words = 0
  for (const sentence of sentences) {
    const n = sentence.split(/\s+/).filter(Boolean).length
    if (kept.length > 0 && words + n > maxWords) break
    kept.push(sentence.trim())
    words += n
    if (words >= maxWords) break
  }
  return kept.join(' ').split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ').trim()
}

// Condenses a free-text intake answer into a short search fragment.
// Search engines degrade badly on long natural-language strings, so we take the leading
// sentences only. Returns '' when the answer is too thin to be worth searching, which is
// what makes the caller fall back rather than assume anything about the client's industry.
function condense(text: string, maxWords: number): string {
  const cleaned = text
    .replace(/["‘’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Intake answers are written in the first person ("We supply hot school meals to
    // primary schools"). The leading clause is noise in a search engine, so drop it
    // and keep the subject matter. Nothing here depends on the words that follow.
    .replace(/^(we|our team|our company|i)\s+(are|is|do|help|supply|provide|offer|sell|deliver|work with|specialise in|specialize in|run)\s+/i, '')
  return firstSentences(cleaned, maxWords)
}

// A condensed intake answer is USABLE as a search descriptor only if it reads as a
// description of a kind of organisation. The check replaces an emptiness check that could
// not tell a thin answer from an off-question one: `clients_clone` is answered in prose by
// a person describing a relationship, and a non-empty answer that never names a buyer is
// the common case, not the edge case.
//
// Measured against the real intake of all five organisations on 2026-08-28. Four of the
// five `clients_clone` answers fail this check and one passes, and the four that fail are
// the four that produced queries no search engine could serve.
//
// Both criteria are category-level. Neither names an industry, a buyer archetype or a
// service type, so the check behaves the same for any client in any market.
//
// The failure is deliberately asymmetric, but NOT in the direction it used to be. A false
// reject now costs research entirely (see resolveBuyerDescriptor), where it used to fall
// through to the service description. That is the point: a wrong population researched
// confidently is worse than no population researched at all.

// Criterion one: the descriptor must open with a noun phrase.
// A subject pronoun has no antecedent a search engine can resolve, and a subordinating
// conjunction opens a story rather than naming a population. Possessives are deliberately
// absent: "our clients are hospital procurement leads" opens with "our" and is a perfectly
// good descriptor, so rejecting on it would cost more than it saves.
const NON_DESCRIPTOR_OPENERS = new Set([
  'i', 'we', 'they', 'he', 'she', 'it', 'you', 'them', 'us', 'me',
  'this', 'that', 'these', 'those',
  'when', 'if', 'because', 'after', 'before', 'since', 'while', 'although', 'though', 'once',
])

// Criterion two: the descriptor must not be about the person who filled in the form.
// A first-person singular marker anywhere in it means the answer turned into the
// respondent's own story, which is what "let me solve our problem" and "was my first" are.
// Plural "we" and "our" are not included: a client describing their own buyer often says
// "companies we sell to", and that is still a descriptor.
const FIRST_PERSON_SINGULAR = /\b(i|me|my|mine|myself)\b/i

// Applies the two criteria above. Shared, because a free-text intake answer and an
// extracted recipient phrase must both read as a population, but they do NOT share a
// length floor. See the two constants below.
function readsAsPopulation(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false

  const firstWord = words[0].toLowerCase().replace(/[^a-z']/g, '')
  if (NON_DESCRIPTOR_OPENERS.has(firstWord)) return false

  return !FIRST_PERSON_SINGULAR.test(text)
}

// Below this a free-text answer carries no more information than a generic term already
// does. It exists to reject thin prose: "they needed support" is three words of narrative
// and says nothing about a population.
const MIN_DESCRIPTOR_WORDS = 3

// The floor for an EXTRACTED recipient is lower, and deliberately so. A recipient phrase
// is already a noun phrase by construction, so shortness means precision rather than
// thinness: "B2B consultants" is two words and is exactly the population to research,
// where the three-word floor rejected it and skipped research for a client whose buyer
// the intake names perfectly clearly. Applying a prose floor to a parsed phrase measures
// the wrong thing.
const MIN_RECIPIENT_WORDS = 2

// Returns the descriptor when it is usable as a search term, and '' when it is not.
// Exported for tests.
export function usableDescriptor(condensed: string): string {
  const words = condensed.split(/\s+/).filter(Boolean)
  if (words.length < MIN_DESCRIPTOR_WORDS) return ''
  return readsAsPopulation(condensed) ? condensed : ''
}

// ─── Buyer descriptor resolution ──────────────────────────────────────────────

// THE DEFECT THIS REPLACES, measured across three ICP generations on 2026-08-27/28.
//
// `const buyer = cloneClient || whatYouDo` fell back to the SERVICE DESCRIPTION when the
// ideal-client answer was unusable. A service description names what the client sells, not
// who buys it, so the buyer-population queries asked about the wrong thing entirely. The
// live query read "<service description> typical company size revenue headcount profile
// 2025", which is not a population a search engine can serve, and research came back empty
// on all four queries for four of the five organisations.
//
// The service description is still the right place to look, but for the RECIPIENT inside
// it rather than for the whole string. Every service description names who it is for:
// "... to founder-led businesses", "... into hospitals, care homes", "help B2B
// consultants ...". Extracting the complement of a recipient marker is a grammatical rule
// and holds in any industry.

export type BuyerDescriptorSource =
  /** `clients_clone` — the field that actually asks who the buyer is. */
  | 'ideal_client'
  /** The recipient named inside `company_what_you_do`. */
  | 'service_recipient'
  /** Neither yielded a population. Research is skipped rather than guessed. */
  | 'none'

export interface BuyerDescriptor {
  /** The search term. '' exactly when source is 'none'. */
  text: string
  source: BuyerDescriptorSource
}

// Recipient markers, most explicit first. All are closed-class function words or the
// small set of verbs that take a beneficiary. Nothing here names an industry or a buyer.
//
// ORDER IS LOAD-BEARING. The prepositions are tried before the verbs because a service
// description commonly contains both: "We sell medical mattresses into hospitals" matches
// "sell" earlier in the string than "into", and matching on "sell" returns the PRODUCT
// ("medical mattresses into hospitals") instead of the buyer. Measured on the live
// intake: preposition-first is what turns that case from a product string into
// "hospitals, care homes".
const RECIPIENT_MARKERS: RegExp[] = [
  /\b(?:to|into|for)\s+/i,
  /\b(?:help|helps|helping|serve|serves|serving|support|supports|supporting)\s+/i,
  /\bwith\s+/i,
]

// Tokens that cannot continue a noun phrase naming a population. The extraction stops at
// the first one, so an adjunct clause after the recipient is dropped rather than searched.
// Closed-class: prepositions that open an adjunct, subordinators, and relativisers.
const RECIPIENT_BOUNDARY_FUNCTION_WORDS =
  'on|through|by|using|via|across|from|so|who|which|that|because|when|while|and then'

// Generic English verbs that open a predicate about the recipient rather than continuing
// to name them. "help B2B consultants GET more meetings" names the buyer in the two words
// before the verb; without this the phrase runs on into the benefit being sold and the
// query asks about the outcome instead of the population.
//
// THIS ONE IS A HEURISTIC AND THE OTHER LIST IS NOT, which is why they are separate.
// Function words are a closed class and can be enumerated. Verbs cannot, so this list is
// the common ones and will miss others. The miss is safe by construction: an unrecognised
// verb leaves a LONGER descriptor, capped at MAX_RECIPIENT_WORDS, which is the behaviour
// before this list existed. It cannot produce a different population, only a wordier
// version of the right one.
//
// Every verb here is industry-neutral. None names a service, a sector or a buyer type,
// so the boundary falls in the same grammatical place for any client in any market.
const RECIPIENT_BOUNDARY_VERBS =
  'get|gets|getting|achieve|achieves|grow|grows|scale|scales|reduce|reduces|' +
  'increase|increases|improve|improves|save|saves|win|wins|build|builds|run|runs|' +
  'manage|manages|find|finds|generate|generates|become|becomes|avoid|avoids|' +
  'stop|stops|make|makes|hit|hits|move|moves|turn|turns|keep|keeps'

const RECIPIENT_BOUNDARY = new RegExp(
  `\\b(?:${RECIPIENT_BOUNDARY_FUNCTION_WORDS}|${RECIPIENT_BOUNDARY_VERBS})\\b`, 'i')

// A recipient phrase longer than this is no longer naming a population, it is describing
// the engagement. Caps the damage when no boundary token appears.
const MAX_RECIPIENT_WORDS = 8

// Pulls the recipient out of a service description. Returns '' when the description names
// no recipient, which is a real outcome and not an error: "We make industrial fasteners"
// genuinely does not say who buys them.
// Exported for tests.
export function recipientFromServiceDescription(raw: string): string {
  const text = raw.replace(/["‘’“”]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return ''

  for (const marker of RECIPIENT_MARKERS) {
    const match = marker.exec(text)
    if (!match) continue

    // Everything after the marker, cut at the end of its own sentence.
    let tail = text.slice(match.index + match[0].length).split(/[.!?;:]/)[0]

    const boundary = RECIPIENT_BOUNDARY.exec(tail)
    if (boundary) tail = tail.slice(0, boundary.index)

    const phrase = tail
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_RECIPIENT_WORDS)
      .join(' ')
      // "etc" and a trailing comma are list punctuation, not part of the population.
      .replace(/[,\s]*\betc\.?$/i, '')
      .replace(/[,\s]+$/, '')
      .trim()

    const words = phrase.split(/\s+/).filter(Boolean)
    if (words.length >= MIN_RECIPIENT_WORDS && readsAsPopulation(phrase)) return phrase
  }

  return ''
}

// Resolves the population the research is about, in the order the intake actually answers
// the question. Exported for tests and for the proof harness.
export function resolveBuyerDescriptor(intake: IntakeRow[]): BuyerDescriptor {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  // 1. The field that asks the question. When it is answered with a population, use it.
  const idealClient = usableDescriptor(condense(val('clients_clone'), 12))
  if (idealClient) return { text: idealClient, source: 'ideal_client' }

  // 2. Otherwise the recipient named inside the service description.
  const recipient = recipientFromServiceDescription(val('company_what_you_do'))
  if (recipient) return { text: recipient, source: 'service_recipient' }

  // 3. Nothing in intake names a population. The caller skips research and says so.
  return { text: '', source: 'none' }
}

// ─── Geography ────────────────────────────────────────────────────────────────

// Country-code top-level domains that genuinely signal where a business operates.
// This is an allowlist on purpose. The ccTLDs sold as generic vanity domains (.io, .ai,
// .co, .me, .tv and the rest) are absent, so they yield no hint rather than a wrong one.
const COUNTRY_BY_CCTLD: Record<string, string> = {
  ie: 'Ireland',        uk: 'United Kingdom', de: 'Germany',     fr: 'France',
  es: 'Spain',          it: 'Italy',          nl: 'Netherlands', be: 'Belgium',
  pt: 'Portugal',       at: 'Austria',        ch: 'Switzerland', se: 'Sweden',
  no: 'Norway',         dk: 'Denmark',        fi: 'Finland',     pl: 'Poland',
  cz: 'Czech Republic', gr: 'Greece',         ro: 'Romania',     hu: 'Hungary',
  ca: 'Canada',         au: 'Australia',      nz: 'New Zealand', us: 'United States',
  in: 'India',          sg: 'Singapore',      za: 'South Africa', jp: 'Japan',
  br: 'Brazil',         mx: 'Mexico',
}

// Geography comes from the ccTLD of the client's own website and from NOTHING ELSE.
//
// It used to come from currency, which is the inference CLAUDE.md's geography rule
// forbids: EUR spans twenty-odd countries, so a single-country client was searched
// against the whole zone. On the live school-meals client that produced "Ireland" in the
// service description and "Europe" in the same query string, contradicting itself.
//
// ACCEPTED TRADE-OFF, stated because it is a real cost and not an oversight. A generic
// TLD now yields NO geographic hint at all, where currency previously supplied a
// confident wrong one. Three of the five live organisations are on .com and lose their
// hint. A query with no geography returns broader results; a query with the wrong
// geography returns results about the wrong market and reads as though it worked.
// Broader beats wrong, and the fix for broader is a real country signal in intake,
// which does not exist today: there is no country field, and CLAUDE.md forbids
// reconstructing one from currency.
//
// Exported for tests.
export function geographyFromIntake(url: string): string {
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')

  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return ''

  return COUNTRY_BY_CCTLD[labels[labels.length - 1]] ?? ''
}

// ─── Research plan ────────────────────────────────────────────────────────────

// Joins query fragments, dropping the ones that are empty. Without this an absent
// geography hint leaves a double space in the middle of every query string.
function q(...parts: string[]): string {
  return parts.filter(s => s.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim()
}

export interface ResearchPlan {
  /** The queries to run. Empty exactly when skipped is true. */
  queries: string[]
  /** True when intake supplied no buyer population, so nothing should be searched. */
  skipped: boolean
  /**
   * Operator-facing explanation, appended to suggestion_reason. '' when not skipped.
   * This is the whole point of the type: "research was skipped because intake did not
   * name a buyer" and "research ran and found nothing" are different statements, and only
   * the first one tells the operator what to do about it.
   */
  skipReason: string
  /**
   * Operator-facing note naming the population that was researched, emitted when the
   * descriptor did NOT come from the ideal-client field. '' otherwise.
   *
   * WHY THIS EXISTS. A service description names who the service is DELIVERED to, which
   * is usually but not always who BUYS it. On the live school-meals client the service is
   * delivered to children and bought by the state, so the recipient is a real population
   * and the wrong one. No category-level rule separates those two without world
   * knowledge, so the fallback is not made cleverer. It is made VISIBLE: the operator is
   * told which population was researched and can see at a glance that it is wrong.
   * A silently wrong population researched confidently is the failure mode this whole
   * change is about, and it would otherwise reappear here in a smaller form.
   */
  descriptorNote: string
  /** Where the buyer descriptor came from. Recorded so the note can name the field. */
  buyerSource: BuyerDescriptorSource
}

// Derives targeted search queries from the client's intake data, or declines to.
//
// Queries cover: buyer pain points, buying triggers, buyer firmographics, and the
// client's competitive landscape. Each one informs a distinct part of the ICP.
//
// Every query interpolates the client's own intake text. Nothing here names an industry,
// a service type or a buyer archetype. An earlier version selected between two hardcoded
// consulting literals on each branch, so intake could not change the query, which put
// MargenticOS's own competitive set into every client's research.
export function buildResearchPlan(intake: IntakeRow[]): ResearchPlan {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  const buyer = resolveBuyerDescriptor(intake)

  // NO BUYER, NO RESEARCH. Three of the four queries are about the buyer population, and
  // the fourth is only useful alongside them. Sending them with a service description in
  // the buyer's place is what produced empty research on three consecutive generations,
  // reported to the operator as "web search returned limited results" — which reads as a
  // provider problem and is not actionable. Skipping and saying why is.
  if (buyer.source === 'none') {
    return {
      queries: [],
      skipped: true,
      descriptorNote: '',
      buyerSource: 'none',
      skipReason:
        ' ⚠️ Web research was SKIPPED, not attempted and failed. The intake did not supply ' +
        'anything naming a buyer population: the ideal-client answer reads as narrative ' +
        'rather than as a description of who buys, and the service description does not say ' +
        'who the service is delivered to. Every section below therefore comes from intake ' +
        'and framework logic only, with no live market data. To change that, the ' +
        'ideal-client answer needs to name a population, for example a role together with ' +
        'a kind of organisation. Regenerating without changing the intake will skip ' +
        'research again.',
    }
  }

  // The trigger is a search fragment in its own right and gets the same usability check.
  // WITHOUT THIS the raw answer reached the provider verbatim: all five live
  // organisations produced a query 2 opening with narrative prose, including
  // "They were dealing with feast and famine cycles. Their revenue was all buying trigger
  // why now". The earlier fix applied the check to the two descriptors and not to this.
  const trigger = usableDescriptor(condense(val('clients_trigger'), 12))

  // The client's own domain, not their currency. See geographyFromIntake.
  const geoHint = geographyFromIntake(val('company_url') || val('assets_website'))

  // The service the client sells, used only for the competitor query, where the subject
  // really is the client's own offer rather than the buyer.
  const service = usableDescriptor(condense(val('company_what_you_do'), 12))

  // Query 1: Buyer pain points — the language real buyers use for the problem this
  // client solves. Grounds four_forces.push entries in market reality.
  const buyerPainQuery = q(buyer.text, 'challenges problems pain points', geoHint, '2025')

  // Query 2: Trigger events — what business events cause this buyer to act?
  const triggerQuery = trigger
    ? q(buyer.text, trigger, 'buying trigger why now', geoHint)
    : q(buyer.text, 'buying trigger events when do they invest', geoHint)

  // Query 3: Buyer profile reality check — team size, revenue norms, stage language.
  const buyerProfileQuery = q(
    buyer.text, 'typical company size revenue headcount profile', geoHint, '2025')

  // Query 4: Competitive landscape — how do others selling THIS CLIENT'S service to
  // THIS CLIENT'S buyer position themselves? Informs disqualifiers and switching costs.
  const competitorQuery = service
    ? q(service, 'providers competitors positioning', geoHint, '2025')
    : q(buyer.text, 'suppliers competitors positioning', geoHint, '2025')

  return {
    queries: [buyerPainQuery, triggerQuery, buyerProfileQuery, competitorQuery],
    skipped: false,
    skipReason: '',
    descriptorNote:
      buyer.source === 'service_recipient'
        ? ` ⚠️ The ideal-client answer did not name a buyer population, so research was ` +
          `run against "${buyer.text}", taken from who the service description says it is ` +
          `delivered to. Check that this is who actually BUYS. Where a service is ` +
          `delivered to one party and bought by another, the research below is about the ` +
          `wrong one, and the fix is to answer the ideal-client question with a population.`
        : '',
    buyerSource: buyer.source,
  }
}


// ─── Prompt construction ──────────────────────────────────────────────────────

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  existingDocument: ExistingDocument | null
  patterns: PatternRow[]
  completeness: number
  research: ResearchBundle
  /** True when no search ran because intake named no buyer. Not the same as a search
   *  that ran and found nothing, and the prompt must not describe it as one. */
  researchSkipped: boolean
  refDocs: UploadedRefDoc[]
  websitePages: WebsitePageContext[]
  regeneration_notes: RegenerationNotes | undefined
}): string {
  const { intake, existingDocument, patterns, completeness, research, researchSkipped, refDocs, websitePages } = params

  // Group intake responses by section for readability in the prompt.
  const bySec = intake.reduce<Record<string, IntakeRow[]>>((acc, row) => {
    if (!acc[row.section]) acc[row.section] = []
    acc[row.section].push(row)
    return acc
  }, {})

  const intakeSections = Object.entries(bySec)
    .map(([section, rows]) => {
      const lines = rows
        .map(r => {
          const answered = r.response_value && r.response_value.trim().length > 0
          const value = answered ? r.response_value : '[not answered]'
          const flag = r.is_critical && !answered ? ' ⚠️ CRITICAL — NOT ANSWERED' : ''
          return `  Q: ${r.field_label}${flag}\n  A: ${value}`
        })
        .join('\n\n')
      return `### ${section}\n\n${lines}`
    })
    .join('\n\n---\n\n')

  // Refresh context: include the existing document so the agent can version correctly.
  const refreshContext = existingDocument
    ? `\n\n---\n\n## EXISTING ICP DOCUMENT (version ${existingDocument.version})\n\nThis is a refresh. The existing document is provided for context. ` +
      `Produce an improved version that incorporates any new intake data.\n\n${existingDocument.plain_text ?? JSON.stringify(existingDocument.content, null, 2)}`
    : ''

  // Pattern context: if patterns exist, include relevant ones.
  const patternContext = patterns.length > 0
    ? `\n\n---\n\n## CROSS-CLIENT PATTERNS (anonymised, ${patterns.length} patterns)\n\n` +
      'These patterns are derived from aggregated campaign data across multiple clients. ' +
      'They are supplementary context — not specific to this organisation.\n\n' +
      patterns
        .map(p => `- ${p.pattern_type} (${p.sample_size} data points): ${JSON.stringify(p.pattern_data)}`)
        .join('\n')
    : '\n\n---\n\n## CROSS-CLIENT PATTERNS\n\nNo pattern data available yet (phase one). ' +
      'Base your analysis entirely on the intake data above.'

  const completenessNote = completeness < 80
    ? `\n\n⚠️ INTAKE COMPLETENESS NOTE: Only ${completeness}% of critical fields have been answered. ` +
      'Derive what you can from what is available. Flag any significant gaps. Do not hallucinate specifics.'
    : ''

  // Research section: included only when searches returned usable results.
  // When research conflicts with intake data, your data quality rules apply:
  // flag the conflict rather than silently overriding either source.
  const researchSection = formatResearchForPrompt(research)
  const researchBlock = researchSection
    ? `\n\n---\n\n${researchSection}\n\n` +
      `RESEARCH WEIGHTING RULE: Use research to validate, enrich, and sharpen the language ` +
      `in the ICP. If research findings conflict with intake data, do NOT silently override ` +
      `intake. Instead, use the intake data as primary and state the conflict in the text of ` +
      `the field it affects, so a reader of the document can see it.`
    : researchSkipped
      // The model used to be told only "no usable research results available", and it
      // reported that back in its reasoning as research having been run and returned
      // nothing. That was never true when the real cause was a missing buyer descriptor,
      // and the document read as though the market had no data rather than as though we
      // had not asked. Say which of the two happened.
      ? '\n\n---\n\n## WEB RESEARCH\n\nNo web research was run for this document. ' +
        'The intake did not name a buyer population to research, so no search was ' +
        'attempted. Do NOT state or imply that research was performed, that it returned ' +
        'no results, or that no market data exists. Base your analysis entirely on intake ' +
        'data and framework logic, and where a section would normally be grounded in ' +
        'market research, say that it is derived from the intake alone.'
      : '\n\n---\n\n## WEB RESEARCH\n\nWeb research ran but returned no usable results. ' +
        'Base your analysis entirely on intake data and framework logic.'

  const websiteBlock = formatWebsiteContextForPrompt(websitePages)

  return `You are generating an ICP document for the B2B business described below.
Derive what this business does, who it sells to, and the industry it operates in from the
intake responses, uploaded documents and website content in this message. Do not assume an
industry, a service type, or a buyer archetype that the intake does not support.
${completenessNote}

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}${refDocs.length > 0
    ? '\n\n---\n\n## UPLOADED REFERENCE DOCUMENTS\n\n' +
      'The client has uploaded the following reference documents. ' +
      'Use them as primary source material alongside the intake responses above.\n\n' +
      refDocs.map(d =>
        `### ${d.filename} (${d.purpose === 'icp_doc' ? 'Existing ICP document' : 'Case study'})\n\n${d.text}`
      ).join('\n\n---\n\n')
    : ''}${websiteBlock}${researchBlock}${refreshContext}${patternContext}${buildRegenerationNotesBlock(params.regeneration_notes)}

---

Using the frameworks and rules in your system prompt, produce the ICP document now.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(userMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ICP agent: ANTHROPIC_API_KEY environment variable is not set. ' +
      'Add it to .env.local before running agents.'
    )
  }

  const client = new Anthropic({ apiKey })

  // Load the system prompt from the prompt file at runtime.
  // The file is read once per invocation — no module-level caching (stateless).
  const systemPrompt = await loadSystemPrompt()

  const message = await client.messages.create({
    model: ICP_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  })

  // Extract the text content from the response.
  const content = message.content.find(block => block.type === 'text')
  if (!content || content.type !== 'text') {
    throw new Error('ICP agent: Claude returned no text content in response.')
  }

  // Strip markdown code fences if present. Claude sometimes wraps JSON in ```json ... ```
  // despite explicit instructions not to. Strip defensively so parsing never fails on fences.
  return stripMarkdownFences(content.text.trim())
}

function stripMarkdownFences(text: string): string {
  // Remove opening fence: ```json or ``` at the very start
  const withoutOpen = text.replace(/^```(?:json)?\s*\n?/i, '')
  // Remove closing fence: ``` at the very end
  const withoutClose = withoutOpen.replace(/\n?```\s*$/i, '')
  return withoutClose.trim()
}

async function loadSystemPrompt(): Promise<string> {
  // Dynamic import of fs — only available server-side.
  // The prompt file is the source of truth for agent behaviour.
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')

  try {
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'icp-agent.md')
    const raw = await readFile(promptPath, 'utf-8')

    // Strip the frontmatter header lines (lines starting with #) and the Status block,
    // keeping only the content from "## System Prompt" onward.
    const systemPromptMarker = '## System Prompt'
    const idx = raw.indexOf(systemPromptMarker)
    if (idx === -1) {
      throw new Error('ICP agent: could not find "## System Prompt" section in icp-agent.md')
    }

    return raw.slice(idx + systemPromptMarker.length).trim()
  } catch (err) {
    throw new Error(`ICP agent: failed to load system prompt — ${String(err)}`)
  }
}

// ─── Write to document_suggestions ───────────────────────────────────────────

async function writeDocumentSuggestion(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    segment_id: string | null
    existingDocument: ExistingDocument | null
    generatedContent: string
    parsedDocument: Record<string, unknown>
    intake: IntakeRow[]
    completeness: number
    is_refresh: boolean
    researchLimitedNote: string
    truncatedPageCount: number
    regeneration_notes: RegenerationNotes | undefined
  }
): Promise<string> {
  const {
    organisation_id,
    segment_id,
    existingDocument,
    generatedContent,
    completeness,
    is_refresh,
    researchLimitedNote,
    truncatedPageCount,
  } = params

  // Build the human-readable reason that will appear in Doug's approval queue.
  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0 && r.is_critical
  ).length
  const totalCount = params.intake.filter(r => r.is_critical).length
  const refreshNote = is_refresh
    ? ` This is a refresh — the existing v${existingDocument?.version ?? '?'} document was used as context.`
    : ' This is the initial generation — no prior ICP document existed.'

  const completenessNote =
    completeness < 80
      ? ` ⚠️ Intake completeness was ${completeness}% (${answeredCount}/${totalCount} required fields answered). ` +
        'Some sections may be less specific than ideal. Consider completing the intake before approving.'
      : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} required fields answered).`

  // A cut page is a candidate explanation for a document that reads thin, and without
  // this line the operator has no way to see it. The cut is at the FETCH limit, so it is
  // not fixed by regenerating: the missing text is not in the database to be read.
  const truncationNote =
    truncatedPageCount > 0
      ? ` ⚠️ ${truncatedPageCount} website page${truncatedPageCount === 1 ? ' was' : 's were'} ` +
        'cut at the fetch limit before storage, so the agent did not see the end of ' +
        `${truncatedPageCount === 1 ? 'it' : 'them'}. Regenerating will not recover the ` +
        'missing text. If the document is thin on how this client actually delivers, that ' +
        'is where to look first.'
      : ''

  const suggestionReason =
    `ICP document generated by icp-generation-agent using ${ICP_MODEL}.` +
    refreshNote +
    buildRegenerationNotesReason(params.regeneration_notes) +
    completenessNote +
    researchLimitedNote +
    truncationNote

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,          // always scoped to this client
      segment_id,               // segment this ICP was generated for
      document_id: existingDocument?.id ?? null, // null for initial generation
      document_type: 'icp',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      suggested_value: generatedContent,
      suggestion_reason: suggestionReason,
      confidence_level: completeness >= 80 ? 'high' : 'low',
      signal_count: 0,           // phase one — not yet populated
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation on document_suggestions_org_type_pending_unique.
    // A pending suggestion already exists for this org+type — idempotent no-op.
    if ((error as { code?: string }).code === '23505') {
      logger.info('ICP agent: duplicate pending suppressed by idempotency index', { organisation_id })
      const { data: existing } = await supabase
        .from('document_suggestions')
        .select('id')
        .eq('organisation_id', organisation_id)
        .eq('document_type', 'icp')
        .eq('status', 'pending')
        .single()
      return (existing?.id ?? null) as string
    }
    throw new Error(`ICP agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
