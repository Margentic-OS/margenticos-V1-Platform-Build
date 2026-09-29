// THE NEED AN EMAIL NAMES MUST BE ONE THE CLIENT'S SERVICE MEETS.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS, AND WHY NO EXISTING CHECK REACHES IT.
//
// The fact-check asks whether a claim ABOUT THE PROSPECT is carried by the findings. That is
// a question about the left-hand side of the bridge. Nothing asks about the right-hand side:
// whether the need the sentence points at is work THIS CLIENT ACTUALLY DOES.
//
// So a bridge and a question can be true of the prospect in every particular, pass every
// deterministic gate, pass the fact-check, pass the floor, beat the template, and promise
// something nobody is selling. Three shapes of that were read off the live batch:
//
//   a closing question offering to put the prospect's own article in front of more people
//   a closing question offering to follow up the people who did not attend their event
//   a bridge naming a need about the prospect's existing audience
//
// Each one describes work the positioning document does not describe. A reply to any of them
// is a call that opens with a correction.
//
// THE CHECK IS A SECOND MODEL CALL, AND ADR-018 IS WHY THAT IS ALLOWED. "Is this need met by
// the work this document describes" is reading comprehension over two texts. It is not
// counting, filtering, routing or pattern matching, and the three examples above share no
// token, no shape and no vocabulary.
//
// ═══ THE CODE HALF IS WHAT BINDS. ADR-028. ═══
//
// The model is asked to POINT: for each need, the numbered line of the client's own
// positioning document that names work meeting it. Code then checks THREE things the model
// cannot talk its way past: the line number exists, the quoted sentence is a real substring
// of THAT LINE, and the quote is long enough to be a sentence rather than a word.
//
// Citing a LINE and not just the document is stronger than the precedent in
// scripts/derive-trigger-reasons.ts, which checks a quote against the whole document. It has
// to be: 23% of the live document describes COMPETITORS AND ALTERNATIVES, measured, so a
// quote can be entirely real and describe work somebody else does. The line number carries
// the path label, so a rejection names where the support was claimed from.
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
//
// AN EMPTY VERDICT IS NOT A FAILURE HERE, unlike in the fact-check. The fact-check can tell a
// suspicious empty verdict from a clean one, because it can detect in code that a sentence
// NAMES the reader. There is no equivalent detector for "this sentence names a need": a need
// is a meaning, not a shape, and the one instrument that could judge it is the instrument
// being checked. Treating empty as a failure would therefore reject copy whenever the
// verifier was unhelpful, and nothing downstream could tell that apart from real copy that
// names no need. It is reported instead, so the rate is readable.
//
// NO CLIENT, MARKET OR SERVICE IS NAMED, and the worked examples are abstract for that
// reason. The obvious concrete pair, "reaching buyers who have not heard of them" against
// "converting the audience they already have", is one client's service shape and is already
// on the Rule Zero fix list for appearing hardcoded elsewhere. The rule here is about WHOSE
// PEOPLE and WHAT IS DONE TO THEM, which can be said without naming either.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { buildPositioningCorpus, positioningLines } from './positioning-text'
import { ZERO_TOKEN_USAGE, readTokenUsage, type TokenUsage } from './types'

const NEED_MATCH_MODEL = 'claude-sonnet-4-6'

/**
 * A quote shorter than this is not a sentence, and a two-word quote matches almost any
 * document. The same floor scripts/derive-trigger-reasons.ts uses, for the same reason.
 */
export const MIN_QUOTE_CHARS = 20

/**
 * One need the verifier found in the copy, and the line it points at for it.
 *
 * THERE IS NO `supported` FIELD, DELIBERATELY. The verifier returns a citation or none, and
 * whether that citation holds is decided by citationHolds. A boolean here would be a second
 * verdict able to disagree with the first, which is exactly what it did.
 */
export interface CheckedNeed {
  /**
   * WHICH SECTION the need was read from. An opaque number the caller chooses: the email
   * position for copy, the trigger's place in the list for an ICP reason.
   *
   * NOT `email`. The check is "does this text name a need the document supports", and that
   * question is the same whether the text is an email, a trigger reason or anything else a
   * client's own words have to back. Naming it `email` is what would have produced a second
   * copy of this file the day a non-email caller arrived.
   */
  id: number
  /** The need, quoted or paraphrased from the copy in one line. */
  need: string
  /** The 1-based positioning line cited, or null when the verifier found none. */
  line: number | null
  /** The sentence quoted from that line. Empty when nothing was cited. */
  quote: string
  /** One line on what the need asks for that the document does not offer. */
  why: string
}

export interface NeedMatchResult {
  needs: CheckedNeed[]
  /** Every reason this copy must not ship. Empty means it may. */
  failures: string[]
  usage: TokenUsage
  /** The raw reply, kept so a verdict can be read rather than inferred. */
  raw: string
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * WHETHER A NEED'S CITATION SURVIVES CODE VERIFICATION. The whole of the verdict.
 *
 * Three conditions, none of which the model can talk its way past: the line exists, the
 * quote is long enough to be a sentence rather than a word, and the quote really is on THAT
 * line. The third is the one that matters: 23% of the live positioning document describes
 * what OTHER providers do, so a quote can be entirely genuine and cited from the wrong place.
 */
export function citationHolds(
  need: CheckedNeed,
  lines: ReadonlyArray<{ path: string; text: string }>,
): boolean {
  if (need.line === null || need.line < 1 || need.line > lines.length) return false
  const quote = normalise(need.quote)
  if (quote.length < MIN_QUOTE_CHARS) return false
  return normalise(lines[need.line - 1].text).includes(quote)
}

/**
 * THE RULES, shared by Email 1 and the follow-ups and parameterised rather than copied, for
 * the reason buildFactCheckPrompt is: a second prompt holding the same rules is a second
 * thing to keep in step, and the rules are the expensive part.
 *
 * THE POSITIONING DOCUMENT IS IN THE SYSTEM MESSAGE, not the user message, and that is a
 * cost decision rather than a stylistic one. It is identical for every prospect of one
 * client, so a cache_control breakpoint on the system block makes it a cache read on every
 * prospect after the first within the window. At ~4,000 tokens it clears Sonnet's
 * 1,024-token minimum cacheable prefix several times over. The copy being checked, which is
 * the only part that changes, is the user message.
 */
export function buildNeedMatchPrompt(opts: {
  /** How the text is described to the model, e.g. 'one email' or '9 trigger reasons'. */
  shown: string
  /** An id used in the output example, so the model returns a number that parses. */
  exampleId: number
  /** The client's positioning document, flattened. */
  positioningText: string
}): string {
  return `You check whether the NEEDS a piece of text names are needs the sender's own service
meets. You are not writing, editing, fact-checking or judging quality. One question only.

You are shown the sender's POSITIONING DOCUMENT as numbered lines, and ${opts.shown}.

A NEED is anything the text says the reader now wants, lacks, has to do, or would get from
replying. Read every part of each section you are given, including any closing question,
which usually names the need as the thing being offered.

YOU RETURN A CITATION, NOT A VERDICT. For each need, give the ONE line of the positioning
document that comes closest to naming work that meets it, and quote that line's sentence
EXACTLY as it appears. Copy it character for character. Do not paraphrase it, do not join two
lines, and do not quote a line you cannot find.

If NO line names work that meets the need, set line to null and quote to an empty string, and
say in one line what the need asks for that the document does not offer.

Nothing else you write decides anything. Whether the need is met is settled by checking your
citation against the document, so the only question you are answering is WHICH LINE.

JUDGE THE WORK, NOT THE SITUATION. Your only question is whether the document describes work
that MEETS the need. It does not matter whether the document mentions the event that created
the need, that kind of company, or that moment in a company's life. Text like this is written
because something happened; the document is not expected to list what.

BE STRICT ABOUT TWO THINGS AND INDIFFERENT TO EVERYTHING ELSE:

  WHOSE PEOPLE. A need about people the reader already has a relationship with is a
  different need from one about people who have never heard of them. So is a need about the
  reader's own staff. If the document describes work done to one group, it does not support
  a need about another.

  WHAT IS DONE FOR THEM OR TO THEM. Two needs can name the same people and ask for entirely
  different work. Matching the group is not enough if the action differs, and the document
  supports a need only when it names the action as well as the people.

If you find yourself withholding a citation because the document does not mention the event
behind the text, the kind of company, or the industry, you are judging the situation, and the
line that describes the WORK is still the right citation.

THE LINE NUMBER IS CHECKED IN CODE. A quote that does not appear on the line you name counts
as no quote at all. Each line is labelled with where in the document it came from: lines
about ALTERNATIVES, COMPETITORS or what OTHER providers do describe work the sender does NOT
do, and must never be quoted as support.

A need the text does not name is not yours to invent. If a section names none, return
nothing for it.

Return ONLY this JSON, no prose around it:

{"needs":[{"id":${opts.exampleId},"need":"<in one line>","line":12,"quote":"the sentence, exactly","why":"<one line, only when line is null>"}]}

KEEP "why" TO ONE LINE. It records what the need asks for that the document does not offer,
when there is no line to cite. It is not a place to deliberate.

line is the NUMBER of the positioning line, or null when no line names work that meets it.

## The sender's positioning document

${buildPositioningCorpus(opts.positioningText)}`
}

/** Splits the JSON out of the reply. Absent or malformed reads as "checked nothing". */
export function parseNeedMatchResponse(raw: string, allowedIds: readonly number[]): CheckedNeed[] {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as { needs?: unknown }
    if (!Array.isArray(parsed.needs)) return []
    return parsed.needs.flatMap(n => {
      if (!n || typeof n !== 'object') return []
      const o = n as Record<string, unknown>
      const id = Number(o.id)
      if (!allowedIds.includes(id)) return []
      const line = o.line === null || o.line === undefined ? null : Number(o.line)
      // `supported` is IGNORED if the model sends one anyway. It is no longer in the schema,
      // and reading it back would quietly restore the second verdict this change removed.
      return [{
        id,
        need: typeof o.need === 'string' ? o.need : '',
        line: line !== null && Number.isFinite(line) ? line : null,
        quote: typeof o.quote === 'string' ? o.quote : '',
        why: typeof o.why === 'string' ? o.why : '',
      }]
    })
  } catch {
    return []
  }
}

/**
 * THE WHOLE OF THE VERDICT. A need is supported if and only if its citation survives
 * citationHolds; there is nothing else to consult, because the model no longer returns
 * anything else.
 *
 * Each failure ENDS WITH ITS OWN INSTRUCTION, because the writer's retry feedback appends a
 * general sentence about the fact-check after whatever it is given. A need-mismatch needs
 * different advice from an unsupported claim, and the advice next to the fault is the one
 * that has to be unambiguous.
 */
export function checkNeedCitations(
  needs: readonly CheckedNeed[],
  positioningText: string,
  /**
   * How a failure names the section it came from. NO DEFAULT, deliberately: a default would
   * mean a new caller silently inherits the email wording, and the follow-up writer routes
   * failures by matching "email 2" and "email 3" in this very string.
   */
  labelOf: (id: number) => string,
): string[] {
  const lines = positioningLines(positioningText)
  const failures: string[] = []

  for (const n of needs) {
    if (citationHolds(n, lines)) continue

    const label = labelOf(n.id)
    // WHY IT DID NOT HOLD, so a rejection can be read rather than counted. The four reasons
    // are distinguishable in code and each one means something different about what went
    // wrong: no line offered, a line that is not there, a quote too short to be a sentence,
    // and a quote that is not on the line it was claimed from.
    const why =
      n.line === null
        ? `no line of the document was cited for it` + (n.why ? `: ${n.why}` : '')
        : n.line < 1 || n.line > lines.length
          ? `it cites line ${n.line}, which does not exist: the document has ${lines.length} lines`
          : normalise(n.quote).length < MIN_QUOTE_CHARS
            ? `it cites line ${n.line} [${lines[n.line - 1].path}] and quotes nothing long enough to be a sentence`
            : `it cites line ${n.line} [${lines[n.line - 1].path}], which does not contain the sentence quoted as support: ${JSON.stringify(n.quote)}`

    failures.push(
      `${label} names the need ${JSON.stringify(n.need)} and ${why}. ` +
      `Name a need this service does meet, or drop it.`,
    )
  }

  return failures
}

export interface NeedMatchParams {
  apiKey: string
  /** The client's positioning document, flattened by flattenPositioningText. */
  positioningText: string
  /**
   * The text to read. `id` is the caller's own numbering, `heading` is what the model sees
   * above that section.
   */
  sections: ReadonlyArray<{ id: number; heading: string; text: string }>
  /** How a failure names a section. See checkNeedCitations. */
  labelOf: (id: number) => string
  /** How the whole input is described to the model, e.g. 'one email' or '9 trigger reasons'. */
  shown: string
  /** For the log line only. A prospect id for copy, a document id for an ICP reason. */
  prospectId: string
}

/**
 * Run the need-match check. Never throws for a model fault: a verifier that cannot run must
 * not take the email down with it, so an API failure returns no needs and no failures and
 * says so in the log. The copy has already passed every rule that is not this one.
 */
export async function checkNeedMatchesOffer(params: NeedMatchParams): Promise<NeedMatchResult> {
  const sections = params.sections.filter(s => s.text.trim().length > 0)
  if (sections.length === 0 || !params.positioningText.trim()) {
    return { needs: [], failures: [], usage: ZERO_TOKEN_USAGE, raw: '' }
  }

  const ids = [...new Set(sections.map(s => s.id))].sort((a, b) => a - b)
  const client = new Anthropic({ apiKey: params.apiKey })
  const user = sections.map(s => `## ${s.heading}\n\n${s.text}`).join('\n\n')

  let raw = ''
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  try {
    const res = await client.messages.create({
      model: NEED_MATCH_MODEL,
      max_tokens: 2000,
      temperature: 0,
      system: [{
        type: 'text',
        text: buildNeedMatchPrompt({
          shown: params.shown,
          exampleId: ids[0],
          positioningText: params.positioningText,
        }),
        // Identical for every prospect of one client, so every prospect after the first in
        // a batch reads it from cache. See the prompt builder's note.
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: user }],
    })
    usage = readTokenUsage(res.usage)
    raw = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  } catch (err) {
    throwIfFatal(err, 'need-matches-offer')
    logger.warn('need-matches-offer: the verifier did not run, the copy is not blocked on it', {
      prospect_id: params.prospectId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { needs: [], failures: [], usage, raw: '' }
  }

  const needs = parseNeedMatchResponse(raw, ids)
  const failures = checkNeedCitations(needs, params.positioningText, params.labelOf)

  logger.info('need-matches-offer: checked', {
    prospect_id: params.prospectId,
    ids,
    needs: needs.length,
    uncited: needs.filter(n => n.line === null).length,
    failures: failures.length,
    // REPORTED, NEVER GATED. See the header: there is no code-side detector for "this
    // sentence names a need", so an empty verdict cannot be told from copy that names none.
    // The rate is the only way to see the verifier going quiet.
    empty_verdict: needs.length === 0,
    rejected: failures,
  })

  return { needs, failures, usage, raw }
}

