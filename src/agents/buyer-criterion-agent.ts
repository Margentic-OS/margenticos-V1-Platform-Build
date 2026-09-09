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
import {
  PROVIDER_SENIORITY_BANDS, keepHonourableBands,
} from '@/lib/sourcing/handlers/provider-seniority'
import type { SpecSeniority } from '@/lib/agents/icp-filter-spec'
import { parseProposedSearch, type ProposedSearch } from '@/lib/tuner/proposed-search'
import { OMITTABLE_AXES } from '@/lib/agents/icp-filter-spec'

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

THE WHOLE SEARCH

Everything above concerns who to contact. This section concerns WHERE TO LOOK, and you must reason from the ENTIRE document, not from the fields that happen to be labelled for it.

Most of what a document says is currently thrown away when a search is built. Only the categories, the size and the place are read. Everything else — what triggers a purchase, what the buyer does day to day, what would make them switch, what disqualifies them, how they describe themselves, and the whole third tier — is discarded. That material is usually where the distinguishing information is, and it is why searches built from the labelled fields alone reach organisations that could never buy.

Propose a complete search. For each part, give the value AND a short reason, and mark whether the document STATES it or you INFERRED it.

  categories        the kinds of organisation to look in, in the document's own words
  words             words that would appear in the NAME of a buying organisation
  size              the smallest and largest number of people, if the document settles it
  revenue           the smallest and largest revenue, if the document settles it
  places            where the buyers are, in the document's own words
  omit              parts of the search that should NOT constrain at all

TRACEABILITY IS THE HARD RULE. Every element you propose must be traceable to something the document actually states. If you cannot point at what supports it, do not propose it. An element proposed on no evidence is worse than a missing one, because it looks like a finding. A misread sentence has already turned one client's strongest market into a rejection rule.

NEVER CONTRADICT AN EXPLICIT STATEMENT. Where the document says something plainly, your proposal agrees with it. Where the document is silent you may infer, and you mark it inferred so a reader can tell the two apart.

OMITTING A FILTER IS A REAL PROPOSAL. A filter that would not narrow anything, or that would cut out people the document says are buyers, should be omitted rather than set narrowly. Measured on real clients, one of these filters has never once added a person to a search: it only ever removes. Only the parts named in the OMITTABLE list at the end of this message may be omitted.

THE BUYER'S LEVEL IN THEIR OWN ORGANISATION

The sourcing tool has a coarse filter for how senior somebody is. It accepts only the exact values listed at the end of this message under AVAILABLE LEVELS, in that spelling. Return every one of those values that the buyer you identified above could hold, in this business's market, according to this business's own documents.

BE GENEROUS, AND UNDERSTAND WHY. This filter can only ever REMOVE people. A value you omit silently discards everybody at that level, including people whose job title matches perfectly. A value you include that turns out not to apply costs nothing, because the people it would add are already excluded by the job titles. So include every level the buyer could plausibly hold, and leave out only the ones that plainly could not be them.

Read the documents for what they actually say about where this person sits. Different markets put the same responsibility at very different levels, and the words a market uses for its own leadership may not resemble the tool's words at all. Match on what the role IS, not on whether the spelling looks similar.

Return an empty list if the documents do not establish where this person sits. An empty list is a correct answer and it stops the run, which is what should happen: there is no default and nothing will be assumed on this business's behalf.

WHAT THE BUSINESS SELLS

Separately from the question above, describe what this business sells and what it is used for, in the words its own documents use. Two short pieces of prose, not a category label and not a list.

Then give candidate words that would appear in the NAME of an organisation that buys this. A candidate is a single word or a short phrase in ordinary use. Prefer the word that names the kind of work the buyer does over a word that names a whole sector, because a sector word matches organisations of every description and tells a search nothing. Return the ones you would expect to find inside a real organisation's name, not the ones that describe the market from outside it. Ten at most, fewer if fewer are honest. Return an empty list rather than filling it out.

Nothing checks these words before you return them. They are measured afterwards against how many organisations each one actually finds, and the ones that find nobody are dropped. So a word you are unsure about costs nothing to include and a word you invent to reach ten costs a measurement.

OUTPUT

Return only JSON, no prose around it:

{
  "unsettled": boolean,
  "unsettled_reason": string or null,
  "accept": [{ "fragment": "lowercase substring", "rank": "primary" or "secondary" }],
  "reject": ["lowercase substring"],
  "statement": "plain English, two to three sentences",
  "evidence": ["short quotation or close paraphrase"],
  "sells": "what this business sells, in its own documents' words",
  "used_for": "what it is used for and by whom, in its own documents' words",
  "name_words": ["lowercase word or short phrase"],
  "seniority_bands": ["exact value copied from AVAILABLE LEVELS"],
  "seniority_evidence": "one sentence on what in the documents established the level",
  "search": {
    "categories": [{ "value": "in the document's own words", "reason": "what supports it", "basis": "stated" or "inferred" }],
    "words": [{ "value": "lowercase word or short phrase", "reason": "...", "basis": "stated" or "inferred" }],
    "size": { "min": number or null, "max": number or null, "reason": "...", "basis": "stated" or "inferred" },
    "revenue": { "min": number or null, "max": number or null, "reason": "...", "basis": "stated" or "inferred" },
    "places": [{ "value": "in the document's own words", "reason": "...", "basis": "stated" or "inferred" }],
    "omit": [{ "value": "exact value copied from OMITTABLE", "reason": "why constraining on it would hurt" }]
  }
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

/**
 * The provider's accepted seniority values, appended to the user message at run time.
 *
 * ─── WHY IT IS INJECTED AND NOT WRITTEN INTO THE PROMPT ──────────────────────
 *
 * The model has to be told which values the provider will accept, or it invents spellings
 * the provider drops silently. But writing them into BUYER_CRITERION_PROMPT would put
 * seniority vocabulary into a prompt file, which is the thing findBannedContent exists to
 * stop, and the static prompt is what that guard scans.
 *
 * So the vocabulary stays in the handler layer that owns it, and arrives here as DATA. The
 * prompt asks the model to choose from a list it is handed; it does not contain the list.
 * That is the same separation the industry-code and country tables already have, and it is
 * why this file names no band either.
 */
function renderAvailableLevels(): string {
  return `AVAILABLE LEVELS\n\nThese are the only values the sourcing tool accepts. Copy them exactly.\n${PROVIDER_SENIORITY_BANDS.join('\n')}`
}

/**
 * The axes that may be deliberately omitted, appended at run time for the same reason the
 * levels are: the list is a property of the system, not a sentence in a prompt, and the
 * banned-content scan reads the prompt.
 */
function renderOmittable(): string {
  return `OMITTABLE\n\nOnly these parts of a search may be omitted. Copy them exactly.\n${OMITTABLE_AXES.join('\n')}`
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
    '',
    renderAvailableLevels(),
    '',
    renderOmittable(),
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
  vocabulary: ClientVocabulary
  seniority: SpecSeniority
  search: ProposedSearch
}

/**
 * What the client sells, in the client's own words, and candidate words for a buyer's name.
 *
 * ─── WHY THIS RIDES ON THE EXISTING CALL RATHER THAN ITS OWN ─────────────────
 *
 * This agent already loads every approved document and the whole intake, roughly 16,000
 * input tokens, and the answer to "what does this business sell" is in that material. A
 * second call would re-send the same context to ask a question the first call could have
 * answered, and it would double the run's only expensive step.
 *
 * MEASURED 2026-09-08, three identical calls to this agent returned accept lists of 11, 11
 * and 8 fragments and reject lists of 7, 4 and 3. So this derivation is non-deterministic at
 * roughly a quarter of its output, and the consequence for any caller that reads it more than
 * once is that the difference between two readings is the model, not the world. The tuner
 * therefore calls this ONCE per run and reuses the answer across every round.
 *
 * NOTHING VALIDATES `name_words` HERE, on purpose. A word list checked by the model that
 * produced it is checked by nothing. The tuner measures each candidate against the provider,
 * alone, and drops the ones that find nobody. That measurement is the validation, and it is
 * free.
 */
export interface ClientVocabulary {
  sells: string
  usedFor: string
  nameWords: string[]
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

  // The vocabulary is OPTIONAL and its absence is not an error. Every criterion stored
  // before this block existed was produced by a prompt that did not ask for it, and a model
  // may legitimately return an empty word list rather than inventing one. An absent or empty
  // vocabulary reaches the tuner as "no candidate words", which it reports and works around
  // by falling back to numbers. Throwing here would make a tuning feature able to break the
  // spec derivation, which is a live path this must never affect.
  const vocab = parsed as unknown as Record<string, unknown>
  const vocabulary: ClientVocabulary = {
    sells: typeof vocab.sells === 'string' ? vocab.sells.trim() : '',
    usedFor: typeof vocab.used_for === 'string' ? vocab.used_for.trim() : '',
    nameWords: Array.isArray(vocab.name_words)
      ? [...new Set(
          (vocab.name_words as unknown[])
            .filter((w): w is string => typeof w === 'string')
            .map(w => w.toLowerCase().trim())
            .filter(w => w.length > 0),
        )]
      : [],
  }

  // ── The seniority bands ──
  //
  // FILTERED AGAINST THE PROVIDER'S OWN LIST, not trusted. A value the model invents is a
  // value the provider drops silently, and a silently dropped filter is indistinguishable
  // from one that worked. What it invented is KEPT SEPARATELY rather than discarded, so an
  // operator can see that it happened.
  const rawBands = Array.isArray(vocab.seniority_bands)
    ? (vocab.seniority_bands as unknown[])
    : []
  const bands = keepHonourableBands(rawBands)
  const bandSet = new Set<string>(bands)
  const seniority: SpecSeniority = {
    bands,
    discarded: rawBands
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.trim())
      .filter(v => v.length > 0 && !bandSet.has(v)),
    evidence: typeof vocab.seniority_evidence === 'string' ? vocab.seniority_evidence.trim() : '',
    omitted: parseProposedSearch(vocab.search).omit.map(o => o.axis),
  }

  const search = parseProposedSearch(vocab.search)

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
    vocabulary,
    seniority,
    search,
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
  return (await deriveBuyerCriterionWithVocabulary(input)).criterion
}

/**
 * The same single call, returning the client's vocabulary alongside the criterion.
 *
 * TWO ENTRY POINTS, ONE CALL, and the split exists so the spec derivation's type does not
 * change. persistIcpFilterSpec wants a BuyerCriterion and storing a vocabulary inside it
 * would put two new keys into every client's stored spec to serve a feature that does not
 * write specs at all.
 */
export async function deriveBuyerCriterionWithVocabulary(
  input: BuyerCriterionInput,
): Promise<{ criterion: BuyerCriterion; vocabulary: ClientVocabulary; seniority: SpecSeniority; search: ProposedSearch }> {
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
    seniority_bands_derived: parsed.seniority.bands.length,
    seniority_values_discarded: parsed.seniority.discarded.length,
    search_categories: parsed.search.categories.length,
    search_words: parsed.search.words.length,
    search_places: parsed.search.places.length,
    search_omissions: parsed.search.omit.map(o => o.axis),
    // Loud, because an element dropped for having no traceable reason is the model
    // proposing something it could not support, and that is worth an operator seeing.
    search_dropped_untraceable: parsed.search.droppedUntraceable,
  })

  return { criterion, vocabulary: parsed.vocabulary, seniority: parsed.seniority, search: parsed.search }
}
