// Buyer Criterion Agent
// Entry point for deriving WHO a client's buyer is, from that client's own documents.
// Model: claude-opus-4-6
//
// ─── WHY THIS IS AN LLM AND NOT DETERMINISTIC CODE (ADR-018) ─────────────────
//
// The inputs are prose. A positioning document says what problem the client solves,
// and the person who owns that problem is the buyer. No rule engine reads a paragraph
// and answers that. Everything downstream of this call IS deterministic: the criterion
// it returns is applied by substring matching in buyer-criterion.ts, which makes no
// model call and is reproducible.
//
// ─── ISOLATION ───────────────────────────────────────────────────────────────
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: the prompt carries ONLY this client's documents and intake
//
// ─── RULE ZERO, AND WHY THIS FILE IS THE HIGHEST RISK IN THE PROJECT ─────────
//
// This derivation is ABOUT job titles. Every instinct when writing a prompt like this
// is to show the model what a good answer looks like. A worked example naming a real
// title does not stay an example: it gets reproduced verbatim for every client that
// ever runs through it, and the client whose market uses different words silently
// receives another market's vocabulary. That has happened eight recorded times in
// this project.
//
// So the prompt below contains zero example titles, zero example industries and zero
// example buyer archetypes. The criterion is stated at CATEGORY level only: who owns
// the problem, who controls the spend, who can convene the decision. The vocabulary
// comes from the client's documents at run time and from nowhere else.
//
// This is enforced, not trusted. findBannedContent() below scans the prompt, and
// buyer-criterion-agent.test.ts fails the build if it finds anything.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import type { BuyerCriterion, BuyerTitleFragment } from '@/lib/sourcing/buyer-criterion'
import { checkSanityBand } from '@/lib/sourcing/buyer-criterion'

const BUYER_CRITERION_MODEL = 'claude-opus-4-6'
const MAX_TOKENS = 2048

// ─── The Rule Zero guard ─────────────────────────────────────────────────────
//
// These two lists are the ONLY place in this codebase where job-title and industry
// vocabulary is written down on purpose. They exist to be searched for, not to be
// matched against a prospect. Nothing reads them at run time except the test.
//
// A word here is banned FROM THE PROMPT. That is a narrower claim than "this word is
// a job title": `head` and `lead` are ordinary English, and they are listed because a
// prompt that needs them is a prompt drifting toward describing a specific role.

export const BANNED_TITLE_WORDS = [
  'ceo', 'cfo', 'coo', 'cto', 'cmo', 'cio', 'chief', 'c-suite', 'csuite',
  'founder', 'cofounder', 'co-founder', 'owner', 'proprietor',
  'president', 'chairman', 'chairwoman', 'chairperson',
  'partner', 'principal', 'director', 'manager', 'managing',
  'vp', 'vice president', 'executive', 'officer', 'supervisor',
  'head of', 'lead of', 'coordinator', 'administrator',
  'sdr', 'bursar', 'superintendent', 'headteacher', 'governor',
] as const

export const BANNED_INDUSTRY_WORDS = [
  'consulting', 'consultancy', 'consultant', 'advisory', 'coaching',
  'saas', 'software', 'agency', 'staffing', 'recruitment',
  'education', 'school', 'healthcare', 'manufacturing', 'retail',
  'logistics', 'hospitality', 'insurance', 'banking', 'biotechnology',
] as const

/**
 * Every banned term found in `text`, as whole words.
 *
 * Whole-word matching, not substring: a substring scan flags `principal` inside
 * `principle` and `chief` inside nothing useful, and a guard that cries wolf is one
 * that gets loosened until it stops working.
 *
 * The industry list is the generic vocabulary PLUS every canonical industry name,
 * because the canonical list is the other place a real sector name could be copied
 * from. Derived from CANONICAL_INDUSTRIES rather than restated, so a sector added
 * there is covered here without anyone remembering to do it.
 */
export function findBannedContent(text: string): string[] {
  const haystack = text.toLowerCase()
  const canonical = CANONICAL_INDUSTRIES.map(name => name.toLowerCase())
  const terms = [...BANNED_TITLE_WORDS, ...BANNED_INDUSTRY_WORDS, ...canonical]

  const hits: string[] = []
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack)) {
      hits.push(term)
    }
  }
  return hits
}

// ─── The prompt ──────────────────────────────────────────────────────────────
//
// EXPORTED so the test can scan the exact string that is sent. A test that scanned a
// copy would prove something about the copy.

export const BUYER_CRITERION_PROMPT = `You are deriving, for one business, which people it should contact.

You are given that business's own approved strategy documents and its intake answers. Everything you conclude must come from those. Do not import assumptions from any other market, sector or business type. If the documents describe a market whose vocabulary you do not recognise, use the words the documents themselves use.

THE QUESTION

For this business's stated problem, identify the person on the buying side who satisfies all three of:

1. OWNS THE PROBLEM. The problem this business solves lands on them. They feel it, they are accountable for it, and it is their responsibility to resolve.
2. CONTROLS THE SPEND. They can authorise money for it, or their approval is what releases it.
3. CAN CONVENE THE DECISION. They can bring the other people needed into the room and make the matter get decided.

Someone who satisfies all three is PRIMARY. Someone who satisfies one or two, and would still be a worthwhile first contact, is SECONDARY. Someone who satisfies none is not a buyer, however senior they sound.

Seniority alone does not qualify anyone. A person can sit at the top of an organisation and still not own this particular problem, and if so they are not a buyer for this business.

WHAT TO RETURN

Return lowercase fragments that would appear inside the job title of such a person in this business's market. A fragment is matched as a literal substring against one part of a job title, so it should be the shortest form that is still unambiguous.

MATCHING IS LITERAL, WHICH MAKES THIS THE EASIEST THING TO GET WRONG. An abbreviation does not match the written-out form, and the written-out form does not match the abbreviation. Wherever a role is written both ways in this market, return BOTH as separate fragments, and do the same for any other spelling variant in genuine use. A missing variant does not degrade the result, it silently discards every person whose title happens to be written the other way.

Also return fragments that DISQUALIFY someone even when an accepting fragment also matched. These are the roles named after the person they support or deputise for, which therefore contain that person's title inside their own.

WHEN THE DOCUMENTS DO NOT SETTLE IT

If the documents do not establish who owns the problem, who controls the spend, or who can convene the decision, set "unsettled" to true and explain in "unsettled_reason" what is missing. Do not choose on thin evidence and do not fill the gap from what is usually true elsewhere. An unsettled answer becomes a question on the onboarding call, which is where an open question belongs. Being unsettled is a correct outcome, not a failure.

THE STATEMENT

Write "statement" as plain English to be read aloud to this client on a call. Two or three sentences. Say who you concluded their buyer is and why that person, in terms of the three tests above. Use the client's own words for their market. Do not mention fragments, matching, or anything about how the system works.

Fill "evidence" with short quotations or close paraphrases from the documents that support the statement. If you cannot evidence a conclusion from the documents, that conclusion is unsettled.

OUTPUT

Return only JSON, no prose around it:

{
  "unsettled": boolean,
  "unsettled_reason": string or null,
  "accept": [{ "fragment": "lowercase substring", "rank": "primary" or "secondary" }],
  "reject": ["lowercase substring"],
  "statement": "plain English, two to three sentences",
  "evidence": ["short quotation or close paraphrase"]
}`

// ─── Input assembly ──────────────────────────────────────────────────────────

export interface BuyerCriterionInput {
  supabase: SupabaseClient
  organisation_id: string
}

interface DocumentRow {
  document_type: string
  version: number | null
  plain_text: string | null
  content: unknown
}

interface IntakeRow {
  field_label: string | null
  response_value: string | null
  section: string | null
}

/**
 * Every approved document, and the intake.
 *
 * NOT THE ICP ALONE. An ICP describes a market. The positioning document says what
 * problem the business solves, and the problem is what identifies who owns it, which
 * is the first of the three tests. Deriving a buyer from the ICP alone would be
 * deriving it from a description of companies rather than of people.
 */
async function loadClientContext(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<{ documents: DocumentRow[]; intake: IntakeRow[] }> {
  const { data: documents, error: docError } = await supabase
    .from('strategy_documents')
    .select('document_type, version, plain_text, content')
    .eq('organisation_id', organisationId) // explicit isolation filter
    .eq('status', 'active')
    .order('document_type')

  if (docError) {
    throw new Error(`Buyer criterion agent: failed to load documents — ${docError.message}`)
  }

  const { data: intake, error: intakeError } = await supabase
    .from('intake_responses')
    .select('field_label, response_value, section')
    .eq('organisation_id', organisationId) // explicit isolation filter
    .order('section')

  if (intakeError) {
    throw new Error(`Buyer criterion agent: failed to load intake — ${intakeError.message}`)
  }

  return {
    documents: (documents ?? []) as DocumentRow[],
    intake: (intake ?? []) as IntakeRow[],
  }
}

/** Render the client's own material. Nothing here is a template value. */
function buildUserMessage(documents: DocumentRow[], intake: IntakeRow[]): string {
  const docBlocks = documents.map(doc => {
    const body = doc.plain_text?.trim()
      ? doc.plain_text
      : JSON.stringify(doc.content, null, 2)
    return `--- DOCUMENT: ${doc.document_type} (version ${doc.version ?? 'unknown'}) ---\n${body}`
  })

  const intakeBlock = intake.length
    ? intake
        .filter(row => row.response_value?.trim())
        .map(row => `${row.field_label ?? 'question'}: ${row.response_value}`)
        .join('\n')
    : '(no intake responses recorded)'

  return [
    'THE BUSINESS\'S APPROVED DOCUMENTS',
    docBlocks.length ? docBlocks.join('\n\n') : '(no approved documents)',
    '',
    'THE BUSINESS\'S INTAKE ANSWERS',
    intakeBlock,
  ].join('\n')
}

/**
 * The titles this client has already sourced, for the sanity band.
 *
 * Read-only and best-effort: a client with no prospects yet returns an empty list and
 * the band reports itself unchecked rather than failing the derivation.
 */
async function loadSourcedTitles(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('prospects')
    .select('job_title')
    .eq('organisation_id', organisationId) // explicit isolation filter
    .not('job_title', 'is', null)
    .limit(1000)

  if (error) {
    logger.warn('buyer-criterion-agent: could not load sourced titles for sanity band', {
      organisation_id: organisationId,
      error: error.message,
    })
    return []
  }

  return (data ?? []).map(row => row.job_title as string)
}

interface ModelResponse {
  unsettled: boolean
  unsettled_reason: string | null
  accept: BuyerTitleFragment[]
  reject: string[]
  statement: string
  evidence: string[]
}

function parseModelResponse(raw: string): ModelResponse {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error('Buyer criterion agent: model returned no JSON object')
  }

  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<ModelResponse>

  const accept = Array.isArray(parsed.accept)
    ? parsed.accept
        .filter(
          (entry): entry is BuyerTitleFragment =>
            !!entry &&
            typeof entry.fragment === 'string' &&
            entry.fragment.trim() !== '' &&
            (entry.rank === 'primary' || entry.rank === 'secondary'),
        )
        .map(entry => ({ fragment: entry.fragment.toLowerCase().trim(), rank: entry.rank }))
    : []

  const reject = Array.isArray(parsed.reject)
    ? parsed.reject
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        .map(entry => entry.toLowerCase().trim())
    : []

  if (typeof parsed.statement !== 'string' || parsed.statement.trim() === '') {
    throw new Error('Buyer criterion agent: model returned no statement')
  }

  return {
    unsettled: parsed.unsettled === true,
    unsettled_reason:
      typeof parsed.unsettled_reason === 'string' ? parsed.unsettled_reason : null,
    accept,
    reject,
    statement: parsed.statement.trim(),
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((e): e is string => typeof e === 'string')
      : [],
  }
}

/**
 * Derive one client's buyer criterion.
 *
 * Throws on transport or parse failure. The caller treats a throw as "no criterion",
 * which fails OPEN — see persistIcpFilterSpec.
 */
export async function deriveBuyerCriterion(
  input: BuyerCriterionInput,
): Promise<BuyerCriterion> {
  const { supabase, organisation_id } = input

  const { documents, intake } = await loadClientContext(supabase, organisation_id)

  if (documents.length === 0 && intake.length === 0) {
    throw new Error(
      `Buyer criterion agent: organisation ${organisation_id} has no active documents and no intake`,
    )
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    model: BUYER_CRITERION_MODEL,
    max_tokens: MAX_TOKENS,
    system: BUYER_CRITERION_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(documents, intake) }],
  })

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  const parsed = parseModelResponse(text)

  const base: BuyerCriterion = {
    status: parsed.unsettled ? 'unsettled' : 'derived',
    accept: parsed.accept,
    reject: parsed.reject,
    statement: parsed.statement,
    evidence: parsed.evidence,
    unsettled_reason: parsed.unsettled ? parsed.unsettled_reason : null,
    sanity: null,
    derived_at: new Date().toISOString(),
    model: BUYER_CRITERION_MODEL,
  }

  // A model that returns no accepting fragments while claiming to have settled the
  // question has not settled it. Treated as unsettled rather than as a criterion that
  // rejects everyone.
  if (base.status === 'derived' && base.accept.length === 0) {
    base.status = 'unsettled'
    base.unsettled_reason =
      base.unsettled_reason ??
      'The derivation returned no accepting criteria, so who decides is not established.'
  }

  const sampleTitles = await loadSourcedTitles(supabase, organisation_id)
  const { status, sanity } = checkSanityBand(base, sampleTitles)

  const criterion: BuyerCriterion = { ...base, status, sanity }

  logger.info('buyer-criterion-agent: derived', {
    organisation_id,
    status: criterion.status,
    accept_count: criterion.accept.length,
    reject_count: criterion.reject.length,
    documents_read: documents.length,
    intake_rows_read: intake.length,
    sanity_checked: sanity.checked,
    sanity_sample_size: sanity.sample_size,
    sanity_accept_rate: sanity.accept_rate,
  })

  return criterion
}
