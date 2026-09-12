// Fit Dimensions Agent
// Entry point for breaking one client's approved profile into the conditions a prospect must
// meet, each marked required or supporting and establishable or not.
// Model: claude-opus-4-6
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The research fit judge used to read the whole profile and reach a grade itself, and at
// temperature 0 on identical input it disagreed with itself on 8 of 20 prospects. Part of
// what it re-decided on every call was WHICH conditions the profile names and WHICH of them
// research could ever show. That is a property of the profile, not of the prospect, so it is
// decided here, once per approval, and stored on the filter spec. The judge then reads each
// dimension and code computes the grade (src/lib/agents/research/fit-dimensions.ts).
//
// ─── WHY THIS IS AN LLM AND NOT DETERMINISTIC CODE (ADR-018) ─────────────────
//
// The input is prose written for a human. Splitting a sentence that holds three conditions
// into three, merging two that say the same thing, and judging whether public research could
// show each one are reading tasks. Everything downstream is deterministic: the list is checked
// by checkFitDimensions, each source is checked against the profile, and the grade is rules.
//
// ─── ISOLATION ───────────────────────────────────────────────────────────────
//   1. The caller passes ONE client's profile and nothing else
//   2. No database access from this module at all
//   3. Prompt: the prompt carries only the statements it is given
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// This derivation is ABOUT what makes a good customer, which is the shortest distance in the
// codebase to writing one market's customer down. The prompt names no market, no buyer type,
// no figure and no company, and gives no worked example with real content. Enforced by
// fit-dimensions-agent.test.ts and by the prompt registry scan.
//
// ─── FAILURE ─────────────────────────────────────────────────────────────────
//
// It throws. The caller (persistIcpFilterSpec) catches and stores the spec WITHOUT dimensions,
// which leaves that client's judge grading the way it did before this existed. A dimension list
// that was guessed at would change every grade silently; a missing one changes nothing.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import {
  checkFitDimensions, normaliseForQuote, MAX_DIMENSIONS,
  type FitDimension, type FitDimensionSet,
} from '@/lib/agents/research/fit-dimensions'

const FIT_DIMENSIONS_MODEL = 'claude-opus-4-6'
const MAX_TOKENS = 4096

// Bounded, like the geography agent, because every route that reaches this has a 300 second
// budget and nothing retries a failed derivation. It runs alongside the geography call, so the
// two together cost the longer of the two rather than the sum.
const REQUEST_TIMEOUT_MS = 60_000
const MAX_RETRIES = 2

/** One statement from the profile, with where it came from. */
export interface FitStatement {
  label: string
  text: string
}

export const FIT_DIMENSIONS_PROMPT = `You break one business's approved targeting profile into the separate conditions a prospect must meet to be a good fit, so that each condition can later be checked, one at a time, against research about one person and their company.

You are given statements copied from that profile. Everything you produce must come from them. Do not add a condition the profile does not state, and do not bring in assumptions from any other market, sector or kind of business. Use the profile's own words.

WHAT A DIMENSION IS

One condition, about the person or about their company, that can be read as met or not met for a single prospect. Split a statement that holds several conditions into one dimension each. Merge statements that say the same thing into one dimension. The profile may describe more than one tier; a condition shared by the tiers you are given is one dimension, not one per tier.

Phrase every dimension so that meeting it is good for fit. A statement that rules prospects out becomes the condition of being clear of it.

TITLES AND LABELS

Where the profile names particular titles, labels or role words for the person, treat them as examples of the position, never as the only acceptable wording. The same position is worded differently from one business to the next, and a dimension met only by matching wording rejects the right person for saying it another way.

So write such a dimension as whether the person holds an EQUIVALENT position, and say what that position does, in the profile's own words: what they are accountable for, what they run, what they decide. Name the profile's examples only as examples, if at all.

ROLE

required: the profile states it as a condition or as something that rules a prospect out. A prospect who fails it is not a fit.
supporting: the profile describes it as typical of a good fit without making it a condition.

ESTABLISHABLE

The research gathered for each prospect is: the person's public professional profile and employment history; their company's own website; a public web search on the person and on the company; and the record a data provider holds on the company, which gives a staff count, an industry, a founding year, some keywords and, only sometimes, an estimated revenue figure.

establishable is true when that research will usually show, one way or the other, whether a prospect meets the dimension.
establishable is false when it usually will not. The private financial figures and commercial terms of a private business are the usual case, and so is how a business would behave inside a working relationship it has not yet entered. A fact the research shows only now and then is not establishable.

A CONDITION ABOUT WHAT IS NOT THERE, OR ABOUT HOW A BUSINESS IS ARRANGED INSIDE, IS FALSE BY DEFAULT. These sources show what a business publishes about itself, and silence about a thing is not evidence that the thing is absent. Nothing they read can establish that something does not exist inside a company, or how work is divided inside it. That covers whether a business has a particular function at all, who inside it is accountable for a task, and whether a responsibility sits with one person or is shared. Only a conversation settles those.

Where a condition mixes something visible from outside with something internal, split it in two: the visible part becomes its own dimension and can be established, and the internal part becomes its own, marked false. Do not let the internal half make the visible half unanswerable.

KEY

A short identifier in lower snake case, unique within the list, naming what the condition is about. Never put a number, a place, a name or a value in a key.

SOURCE

For each dimension, copy the words of the profile it came from, verbatim, as one continuous passage from a single statement. Code checks each source against the profile, and a source that is not found there stops the derivation.

Return between 3 and ${MAX_DIMENSIONS} dimensions. At least one must be establishable.

OUTPUT

Return JSON and nothing else, in exactly this shape:

{
  "dimensions": [
    { "key": "<lower_snake_case>", "statement": "<the condition, phrased so that meeting it is good for fit>", "source": "<verbatim words from one statement>", "role": "required" or "supporting", "establishable": true or false }
  ]
}`

/**
 * The statements this derivation may read, in document order, each once.
 *
 * THE TARGETING TIERS, as the other derivations read them: the summary, and on tiers 1 and 2
 * every company-profile field, the buyer's title and seniority, and the disqualifiers. Tier 3
 * describes who is not targeted at all, and its disqualifiers repeat the targeting tiers'.
 * Triggers and the four forces describe timing and motive, not whether a prospect fits.
 *
 * A statement the second tier repeats word for word is read once.
 */
export function collectFitStatements(doc: IcpDocument): FitStatement[] {
  const out: FitStatement[] = []
  const seen = new Set<string>()
  const add = (label: string, value: unknown) => {
    const text = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join(', ')
      : typeof value === 'string' ? value : ''
    const key = normaliseForQuote(text)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ label, text: text.trim() })
  }

  add('summary', doc.summary)
  for (const [tierKey, tierName] of [['tier_1', 'tier 1'], ['tier_2', 'tier 2']] as const) {
    const tier = doc[tierKey] as Record<string, unknown> | undefined
    if (!tier) continue
    const company = (tier.company_profile ?? {}) as Record<string, unknown>
    for (const [field, value] of Object.entries(company)) {
      if (field === 'unmatched_industries') continue
      add(`${tierName}, company ${field.replace(/_/g, ' ')}`, value)
    }
    const buyer = (tier.buyer_profile ?? {}) as Record<string, unknown>
    add(`${tierName}, buyer title`, buyer.title)
    add(`${tierName}, buyer seniority`, buyer.seniority)
    const disqualifiers = Array.isArray(tier.disqualifiers) ? tier.disqualifiers : []
    for (const d of disqualifiers) add(`${tierName}, rules a prospect out`, d)
  }
  return out
}

function buildUserMessage(statements: FitStatement[]): string {
  return statements.map((s, i) => `Statement ${i + 1} (${s.label}): ${s.text}`).join('\n\n')
}

/**
 * The model's answer, checked. Throws, naming what is wrong, rather than returning a partial
 * list: a list missing a condition changes every grade for that client without saying so.
 */
export function parseFitDimensionsResponse(text: string, statements: FitStatement[]): FitDimension[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('fit dimensions agent: the model returned no JSON object.')

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    throw new Error(`fit dimensions agent: the model's JSON did not parse (${err instanceof Error ? err.message : String(err)}).`)
  }

  const checked = checkFitDimensions((parsed as { dimensions?: unknown })?.dimensions)
  if (!checked.ok) throw new Error(`fit dimensions agent: ${checked.reason}.`)

  // Every dimension must point at words the client actually wrote. One that does not was
  // invented, and an invented condition is the market assumption this agent exists to avoid.
  const profile = statements.map(s => normaliseForQuote(s.text))
  const unfound = checked.dimensions.filter(d => !profile.some(p => p.includes(normaliseForQuote(d.source))))
  if (unfound.length > 0) {
    throw new Error(
      `fit dimensions agent: ${unfound.length} dimension(s) cite words not found in the profile: ` +
      `${unfound.map(d => d.key).join(', ')}. Nothing is stored.`,
    )
  }
  return checked.dimensions
}

/** Derive one client's fit dimensions from that client's own profile. Throws on any failure. */
export async function deriveFitDimensions(input: { doc: IcpDocument; apiKey?: string }): Promise<FitDimensionSet> {
  const statements = collectFitStatements(input.doc)
  if (statements.length === 0) {
    throw new Error('fit dimensions agent: the profile states nothing on its targeting tiers to derive dimensions from.')
  }

  const anthropic = new Anthropic({
    apiKey: input.apiKey ?? process.env.ANTHROPIC_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  })

  const response = await anthropic.messages.create({
    model: FIT_DIMENSIONS_MODEL,
    max_tokens: MAX_TOKENS,
    // Zero: this runs once per approval and its answer is then fixed for every prospect. There
    // is nothing to gain from sampling variety, and a second approval of the same profile
    // should produce the same list.
    temperature: 0,
    system: FIT_DIMENSIONS_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(statements) }],
  })

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`fit dimensions agent: the answer was cut off at ${MAX_TOKENS} tokens, so its JSON is incomplete.`)
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  const dimensions = parseFitDimensionsResponse(text, statements)

  logger.info('fit-dimensions-agent: derived', {
    statements_read: statements.length,
    dimension_count: dimensions.length,
    required_count: dimensions.filter(d => d.role === 'required').length,
    establishable_count: dimensions.filter(d => d.establishable).length,
    // What the one call cost, so an approval's spend is readable from the log.
    input_tokens: response.usage?.input_tokens,
    output_tokens: response.usage?.output_tokens,
  })

  return { dimensions, derived_at: new Date().toISOString(), model: FIT_DIMENSIONS_MODEL }
}
