// ICP Geography Agent
// Entry point for deriving WHERE a client sells, from that client's own ICP document.
// Model: claude-opus-4-6
//
// ─── WHY THIS IS AN LLM AND NOT DETERMINISTIC CODE (ADR-018) ─────────────────
//
// The input is prose written for a human. A targeting profile states where a client
// sells in whatever words that client's market uses, mixing places at several levels of
// granularity inside one sentence, sometimes parenthetically. Deciding which words in
// that sentence are countries, and which are something larger or smaller, is a reading
// task and not a rule a lookup table performs.
//
// The alternative was a region-to-country table in this repository. That is the thing
// this module exists to avoid: it would be one worldview, written once, applied to every
// client, and wrong for the client who meant something narrower. See RULE ZERO below.
//
// Everything downstream of this call is deterministic: the codes it returns are
// normalised, validated and subtracted by pure functions that make no model call.
//
// ─── ISOLATION ───────────────────────────────────────────────────────────────
//   1. The caller passes statements from ONE client's document and nothing else
//   2. No database access from this module at all
//   3. Prompt: the prompt carries only the statements it is given
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// This derivation is ABOUT places. Every instinct when writing a prompt like this is to
// show the model what a good answer looks like, and every worked example naming a real
// place becomes that place's inclusion in some later client's spec. The same failure has
// been recorded eight times in this project with job titles and industries.
//
// So the prompt below names no real country, no real region and no real market. Its one
// illustration is invented. This is enforced rather than trusted: the prompt is scanned
// against the alias table in country-code.ts by icp-geography-agent.test.ts, which fails
// the build if any real place name appears in it.
//
// ─── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//
// It never expands a region word into the countries inside it. A phrase naming only an
// area larger than a country resolves to NOTHING and is recorded verbatim so the
// narrower result is visible to an operator rather than silent. Returning fewer
// countries than the client had in mind costs reach, which is recoverable by editing the
// document. Returning a country the client never wrote down spends money mailing people
// they did not ask for, which is not.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { toIso2CountryCode } from '@/lib/sourcing/country-code'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'

const ICP_GEOGRAPHY_MODEL = 'claude-opus-4-6'
const MAX_TOKENS = 2048

// ─── The call is bounded, unlike every other Anthropic client in this codebase ──
//
// The SDK defaults are a 10 minute timeout and 2 retries, so one bare client can occupy
// 30 minutes. Every route that reaches this code has a 300 second budget, and nothing
// retries a failed spec derivation: a promotion that runs out of time leaves
// icp_filter_spec NULL permanently until a human re-approves the document.
//
// So the worst case is stated here rather than inherited. 60s x 3 attempts fits inside
// the route budget alongside the buyer criterion call that precedes it.
const REQUEST_TIMEOUT_MS = 60_000
const MAX_RETRIES = 2

/** One phrase from the client's document and what it resolved to. */
export interface GeographyPhrase {
  /** The phrase, verbatim from the document. */
  phrase: string
  /** ISO 3166-1 alpha-2 codes this phrase named outright. Empty when it named none. */
  countries: string[]
}

export interface IcpGeography {
  /** Every ISO-2 code named across the targeting tiers, deduplicated, in document order. */
  countries: string[]
  /**
   * Every phrase that resolved to no country, verbatim.
   *
   * NOT AN ERROR LIST. A region word is skipped by design, and this is how the skip
   * becomes visible. It reaches the spec's notes so an operator reading a narrower
   * result than the document implies can see exactly which words produced nothing.
   */
  unresolved_phrases: string[]
  derived_at: string
  model: string
}

export interface IcpGeographyInput {
  /** Statements from the client's targeting tiers, in document order. */
  statements: string[]
  apiKey?: string
}

// ─── The prompt ──────────────────────────────────────────────────────────────
//
// Stated at category level throughout. "An area larger than a country" is a category;
// naming even one real example of such an area would put that example in front of every
// client's document forever. The illustration is invented for the same reason.

export const ICP_GEOGRAPHY_PROMPT = `You read a client's own targeting profile and extract the countries it names.

You will be given one or more STATEMENTS, copied verbatim from that profile. Break each
statement into the geographic PHRASES it contains, and resolve each phrase separately.

THE ONLY RULE THAT MATTERS

Resolve a phrase to a country ONLY when the phrase names that country outright. Never
expand a phrase, never infer a country from context, and never complete a set.

  - A phrase that names one or more countries resolves to exactly those countries and to
    no others.
  - A phrase that names an area LARGER than a single country resolves to NOTHING. This
    covers continents, compass regions, collective names for groups of neighbouring
    countries, trading and economic blocs, language areas, and any other term that stands
    for several countries at once. Do not list its members. Do not guess which of its
    members the client meant. Resolve it to nothing and move on.
  - A phrase that names an area SMALLER than a country adds nothing of its own. Where the
    surrounding text also names the country that contains it, that country is already
    resolved by the phrase that names it.
  - A phrase that names no place resolves to nothing.

Returning fewer countries is always acceptable. Returning a country the client did not
write down is always wrong, and preventing that is the entire purpose of this task.

AN INVENTED ILLUSTRATION, FOR SHAPE ONLY

The places below do not exist. They show the form of the answer and nothing else. Do not
treat them as a hint about which real places matter.

  Statement: "Placeholderia and Examplestan, especially the Northern Placeholder coast,
              plus the wider Sample Basin where partners already operate"

  "Placeholderia" names a country and resolves to it.
  "Examplestan" names a country and resolves to it.
  "the Northern Placeholder coast" is smaller than a country and adds nothing.
  "the wider Sample Basin" stands for several countries at once and resolves to nothing.

OUTPUT

Return JSON and nothing else, in exactly this shape:

{
  "phrases": [
    { "phrase": "<the phrase, copied verbatim from the statement>",
      "countries": ["<the country's common English name>"] }
  ]
}

Every phrase you identified appears exactly once, in the order you read it, with
"countries" set to [] when it resolved to nothing. Copy the phrase text verbatim, because
an operator reads the skipped phrases to decide whether the document needs editing. Give
each country's common English name; do not give codes or abbreviations.`

/**
 * The statements this derivation is allowed to read, in document order.
 *
 * TARGETING TIERS ONLY, AND THE OMISSION IS THE POINT. Tier 3 is the disqualifier tier:
 * it describes who is ruled OUT, and on four of the five documents live at the time this
 * was written it reads as some form of "any geography", because the disqualification is
 * structural rather than geographic. Reading it would turn "geography is irrelevant to
 * why we reject these" into "target everywhere", which is the widest possible misreading
 * of the narrowest possible statement.
 *
 * This mirrors what the rest of deriveFilterSpec already does: industries and headcount
 * are both taken from tier 1 and tier 2 only.
 */
export function collectTargetingGeographyStatements(doc: IcpDocument): string[] {
  return [doc.tier_1?.company_profile?.geography, doc.tier_2?.company_profile?.geography]
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(value => value.length > 0)
}

interface ParsedPhrase {
  phrase: string
  countries: string[]
}

function parseModelResponse(text: string): ParsedPhrase[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'ICP geography agent: the model returned no JSON object. Nothing can be derived ' +
      'from this response, and guessing a geography is the failure this agent prevents.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    throw new Error(
      `ICP geography agent: the model's JSON did not parse (${
        err instanceof Error ? err.message : String(err)
      }).`,
    )
  }

  const phrases = (parsed as { phrases?: unknown })?.phrases
  if (!Array.isArray(phrases)) {
    throw new Error('ICP geography agent: the model returned no "phrases" array.')
  }

  return phrases.map(entry => {
    const row = entry as { phrase?: unknown; countries?: unknown }
    return {
      phrase: typeof row?.phrase === 'string' ? row.phrase.trim() : '',
      countries: Array.isArray(row?.countries)
        ? row.countries.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [],
    }
  })
}

/**
 * Turn the model's country NAMES into canonical ISO-2, refusing anything that does not
 * resolve to a code.
 *
 * WHY NORMALISE HERE AND NOT ASK FOR CODES. A model asked for a two-letter code will
 * always produce two letters, including for a country it is unsure about, and a wrong
 * code is indistinguishable from a right one downstream. A common English name is
 * checkable, and country-code.ts already owns that translation for the whole platform.
 *
 * WHY A VERBATIM PASSTHROUGH IS REFUSED. toIso2CountryCode returns unmapped input
 * unchanged rather than nulling it, which is correct for its own caller: a prospect's
 * jurisdiction must never be erased by a missing alias. It is wrong here. A spec field
 * holding a country's name where a code belongs would reach the sourcing handler, which
 * compares codes, and would be reported as an unknown code rather than as a missing
 * alias. So anything that is not a well-formed ISO-2 code after normalisation stops the
 * derivation and names itself.
 */
function toCanonicalCode(name: string): string {
  const code = toIso2CountryCode(name)
  if (code === null || !/^[A-Z]{2}$/.test(code)) {
    throw new Error(
      `ICP geography agent: "${name}" did not resolve to a country code. Either the ` +
      'document names something this platform has no alias for, in which case add it to ' +
      'COUNTRY_ALIASES in src/lib/sourcing/country-code.ts, or the model returned ' +
      'something that is not a country. The spec is not written either way.',
    )
  }
  return code
}

/**
 * Derive one client's targeting geography from that client's own statements.
 *
 * THROWS rather than returning an empty result. There is no default geography and there
 * is deliberately no way to express one: a spec with no countries would be handed to the
 * sourcing handler, which refuses it, and the refusal would arrive at the operator days
 * later attached to a sourcing run rather than to the document that caused it.
 */
export async function deriveIcpGeography(input: IcpGeographyInput): Promise<IcpGeography> {
  const statements = input.statements.map(s => s.trim()).filter(s => s.length > 0)

  // No statement at all is a different fault from a statement that named no country, and
  // an operator fixes them differently: one is a missing field, the other is wording.
  if (statements.length === 0) {
    throw new Error(
      'ICP geography agent: the ICP document states no geography on either targeting ' +
      'tier, so there is nothing to derive a country list from. Add a geography to the ' +
      'tier 1 and tier 2 company profiles and re-approve the document.',
    )
  }

  const anthropic = new Anthropic({
    apiKey: input.apiKey ?? process.env.ANTHROPIC_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  })

  const response = await anthropic.messages.create({
    model: ICP_GEOGRAPHY_MODEL,
    max_tokens: MAX_TOKENS,
    system: ICP_GEOGRAPHY_PROMPT,
    messages: [
      {
        role: 'user',
        content: statements.map((s, i) => `Statement ${i + 1}: ${s}`).join('\n\n'),
      },
    ],
  })

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  const phrases = parseModelResponse(text)

  const countries: string[] = []
  const seen = new Set<string>()
  const unresolved: string[] = []

  for (const entry of phrases) {
    if (entry.countries.length === 0) {
      if (entry.phrase.length > 0) unresolved.push(entry.phrase)
      continue
    }
    for (const name of entry.countries) {
      const code = toCanonicalCode(name)
      if (!seen.has(code)) {
        seen.add(code)
        countries.push(code)
      }
    }
  }

  // Every phrase resolving to nothing is the case this agent must not paper over. The
  // document was read, it described places, and none of them was a country. Skipping a
  // region word is correct; deriving an empty geography from a document full of region
  // words and letting the run continue is not.
  if (countries.length === 0) {
    throw new Error(
      'ICP geography agent: the ICP document names no country on either targeting tier. ' +
      `${unresolved.length} phrase(s) were read and each named an area larger or smaller ` +
      `than a country: ${unresolved.map(p => `"${p}"`).join(', ')}. Region words are ` +
      'never expanded into country lists. Edit the document to name the countries ' +
      'outright and re-approve it.',
    )
  }

  const geography: IcpGeography = {
    countries,
    unresolved_phrases: unresolved,
    derived_at: new Date().toISOString(),
    model: ICP_GEOGRAPHY_MODEL,
  }

  logger.info('icp-geography-agent: derived', {
    statements_read: statements.length,
    phrases_returned: phrases.length,
    country_count: countries.length,
    unresolved_count: unresolved.length,
  })

  return geography
}
