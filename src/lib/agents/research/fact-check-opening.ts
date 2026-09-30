// THE FACT-CHECK FOR EMAIL 1's BRIDGE AND QUESTION.
//
// WHY EMAIL 1 NEEDS ITS OWN. The deterministic gates in checkOpeningGates already read the
// bridge and the question, and they catch SHAPES: a bare pronoun, a back-reference, a
// firmographic figure, a banned word. None of them can see whether a sentence is TRUE of this
// prospect, because that is not a property of the string. Two real examples from the 104,
// both of which passed every existing gate:
//
//   "A structured role like that one brings new people to Brightpath regularly."
//        The findings say only that the role ENDED. Nothing says it ever brought anyone in.
//   "The Delivery Company now needs to win new clients without a second income behind it."
//        The findings say a second role ended. Nothing says the company needs clients, and
//        nothing establishes its finances.
//
// Both assert a fact about the reader's business that no finding carries. That is the same
// failure the follow-up fact-check was built for, one email earlier, and Email 1 is where
// most replies originate.
//
// THE RULES ARE SHARED, NOT COPIED. buildFactCheckPrompt in fact-check-followups.ts is
// parameterised rather than duplicated, because the rules are the expensive part and a second
// copy is a second thing to keep in step. Only what genuinely differs is passed in.
//
// WHAT DIFFERS: THE QUESTION IS CHECKED HERE AND EXCLUDED THERE. A follow-up's closing
// question is a CTA and asserts nothing. Email 1's question is written against the observation
// and routinely PRESUPPOSES it. From the 104:
//
//   "Is finding new coaching clients to replace those introductions something you're working on?"
//
// "those introductions" asserts that introductions existed, inside a sentence ending in a
// question mark. A rule excluding questions wholesale would let the most confident claim in
// the email through unchecked.
//
// A GENERAL STATEMENT ABOUT A POPULATION STAYS ALLOWED, and that is not a loophole: Email 1's
// bridge is SUPPOSED to be one. The rule is about the SUBJECT. "Most firms that grow this way
// hit the same week twice a year" is a claim about a market. "A structured role like that one
// brings new people to Brightpath regularly" names the firm and is a claim about it.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { splitIntoSentences } from '@/lib/style/sentence-count'
import { isStrangerGroupStatement } from '@/lib/style/stranger-group'
import { companyNameForms } from '@/lib/style/followup-gates'
import { ZERO_TOKEN_USAGE, readTokenUsage, type TokenUsage } from './types'
import {
  buildFactCheckPrompt,
  parseFactCheckResponse,
  countFindingLines,
  findReaderArrangements,
  covers,
  isOfferVoice,
  type CheckedClaim,
  type FactCheckResult,
} from './fact-check-followups'

const FACT_CHECK_MODEL = 'claude-sonnet-4-6'

/**
 * A sentence whose SUBJECT is the reader or their company, which makes it a claim about them
 * by construction whatever else it says.
 *
 * USED ONLY TO DECIDE WHETHER AN EMPTY VERDICT IS SUSPICIOUS, never to reject on its own. The
 * follow-up checker treats any empty verdict as a failure because a follow-up is several
 * sentences and an empty list means the verifier did not work. That reasoning does not carry
 * to Email 1: the bridge is one sentence and is MEANT to be a population statement, so empty
 * is the correct answer much of the time. Firing the shortfall rule here unconditionally would
 * reject the copy the writer is being asked to produce.
 */
function sentencesAboutThem(text: string, companyName: string | null): string[] {
  const forms = companyNameForms(companyName).map(f => f.toLowerCase())
  return splitIntoSentences(text).filter(s => {
    const trimmed = s.trim()
    if (!trimmed) return false
    // A QUESTION IS NOT EVIDENCE THE VERIFIER FAILED. This rule only asks whether an empty
    // verdict is suspicious, and a CTA asserts nothing, so counting it made three prospects
    // fail for having a closing question. Whether a question PRESUPPOSES a fact is still the
    // model's job, and it still returns such claims; this is only the shortfall trigger.
    if (trimmed.endsWith('?')) return false
    // The offer in the reader's terms is not a claim about them. Same rule the follow-up
    // checker applies, imported rather than restated so the two cannot drift.
    if (isOfferVoice(trimmed)) return false
    const low = trimmed.toLowerCase()
    if (/^(we|our|i)\b/.test(low)) return false
    // THE FIRM'S NAME ANYWHERE, BUT "YOU" ONLY AS THE SUBJECT, and the asymmetry is the point.
    //
    // "A structured role like that one brings new people to Brightpath regularly" has the
    // firm as its OBJECT and is squarely a claim about the firm. "The deals worth winning
    // require the right buyers to find you before the wrong ones do" has the reader as its
    // object and is a statement about a market. Subject position alone cannot tell them apart,
    // so it is not asked to: naming the firm is specific enough to count wherever it appears,
    // and a bare second-person pronoun is only a claim when it is what the sentence is about.
    if (forms.some(f => f.length > 2 && low.includes(f))) return true
    return /^(you|your)\b/.test(low)
  })
}

/**
 * The sentences of the copy that a quoted claim could have come from.
 *
 * MATCHED LOOSELY ON PURPOSE. The verifier paraphrases and re-punctuates, so an exact
 * substring test finds nothing more than half the time. A claim is attributed to a sentence
 * when they share enough distinctive words for it not to be a coincidence, and to EVERY
 * sentence that qualifies rather than the best one: the caller only asks whether any of them
 * is the permitted shape, and guessing wrong in the narrowing direction would reinstate the
 * false positive this exists to remove.
 */
function sentenceCarrying(claim: string, bridge: string, question: string): string[] {
  const words = (t: string) =>
    new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3))
  const c = words(claim)
  if (c.size === 0) return []
  return splitIntoSentences(`${bridge}\n${question}`)
    .map(s => s.trim())
    .filter(s => {
      const w = words(s)
      let shared = 0
      for (const x of c) if (w.has(x)) shared++
      return shared / c.size >= 0.5
    })
}

export interface OpeningFactCheckParams {
  apiKey: string
  /** Email 1's second paragraph: the sentence carrying the reason to reply. */
  bridge: string
  /** Email 1's closing question. */
  question: string
  /** The NUMBERED findings the verifier cites into. */
  findingsEvidence: string
  prospectId: string
  /** For deciding whether a sentence names their firm. Null is handled. */
  companyName: string | null
}

/**
 * THE CODE HALF. Every failure is derived from the verifier's own output plus the corpus,
 * never from trusting its verdict.
 */
export function checkOpeningCitations(
  claims: readonly CheckedClaim[],
  findingsEvidence: string,
  bridge: string,
  question: string,
  companyName: string | null,
): string[] {
  const failures: string[] = []
  const lineCount = countFindingLines(findingsEvidence)

  for (const c of claims) {
    // A CITATION TO A FINDING THAT DOES NOT EXIST. A claim resting on an invented citation is
    // unsupported whatever the verdict says.
    if (c.supported && (c.finding === null || c.finding < 1 || c.finding > lineCount)) {
      failures.push(
        `claims ${JSON.stringify(c.claim)} is supported by finding ${c.finding ?? 'none'}, ` +
        `which does not exist: the findings have ${lineCount} lines`,
      )
      continue
    }
    if (!c.supported) {
      // ═══ THE PERMITTED STRANGER LINE IS NOT A CLAIM. Suppressed 2026-09-30. ═══
      //
      // "Buyers who have never heard of <firm> won't find this on their own" DEFINES a group
      // and says what that group will not do. It is true by construction, needs no finding,
      // and is still true if the group is empty. The asserting form, "Buyers have not heard
      // of <firm> yet", is a statement about a market nobody has measured and keeps failing.
      //
      // The verifier cannot tell them apart and rejects both. Measured 2026-09-28: five
      // prospects were templated on stranger lines, four on the asserting form and ONE on
      // the permitted form, and the permitted form is the most common bridge in the corpus.
      // So this is not a rare false positive, it is a false positive on the working shape.
      //
      // JUDGED ON THE SENTENCE, NOT THE CLAIM. The verifier quotes fragments, and a fragment
      // of a relative clause loses the very syntax the test depends on. isStrangerGroupStatement
      // needs both halves present to say yes.
      if (sentenceCarrying(c.claim, bridge, question).some(isStrangerGroupStatement)) continue

      failures.push(
        `Email 1 states ${JSON.stringify(c.claim)}, which the findings do not support` +
        (c.why ? `: ${c.why}` : ''),
      )
    }
  }

  // The same shape rule the follow-ups use: an asserted arrangement that no supported claim
  // covers is a failure NAMING THE SENTENCE, so a rewrite has something specific to change.
  for (const sentence of [...findReaderArrangements(bridge), ...findReaderArrangements(question)]) {
    if (!claims.some(c => c.supported && covers(c.claim, sentence))) {
      failures.push(
        `states how their business is arranged, with nothing cited for it: ${JSON.stringify(sentence)}. ` +
        'Say what the sender does, or name the finding that establishes this.',
      )
    }
  }

  // THE NARROWED SHORTFALL. Fires only when a sentence NAMES them, because only then is an
  // empty verdict evidence that the verifier did not check rather than evidence that the copy
  // makes no claims. A bridge written as a population statement returns nothing and passes,
  // which is the intended outcome and not an escape.
  const about = sentencesAboutThem(`${bridge}\n${question}`, companyName)
  if (about.length > 0 && claims.length === 0) {
    failures.push(
      `the fact-check returned no claims, but ${about.length} sentence(s) name the reader or ` +
      `their company, starting ${JSON.stringify(about[0])}: an empty verdict is not a clean one`,
    )
  }

  return failures
}

/**
 * Run the fact-check on Email 1. Never throws for a model fault: a verifier that cannot run
 * must not take the email down with it, so an API failure returns no claims and no failures
 * and says so in the log.
 */
export async function factCheckOpening(params: OpeningFactCheckParams): Promise<FactCheckResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const user = [
    '## Numbered findings',
    '',
    params.findingsEvidence,
    '',
    '## Email 1, the paragraph that gives the reason to reply',
    '',
    params.bridge,
    '',
    '## Email 1, the closing question',
    '',
    params.question,
  ].join('\n')

  let raw = ''
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  try {
    const res = await client.messages.create({
      model: FACT_CHECK_MODEL,
      max_tokens: 2000,
      temperature: 0,
      system: buildFactCheckPrompt({
        emailsShown: 'one email',
        exampleEmail: 1,
        questionsCanCarryClaims: true,
      }),
      messages: [{ role: 'user', content: user }],
    })
    usage = readTokenUsage(res.usage)
    raw = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  } catch (err) {
    throwIfFatal(err, 'fact-check-opening')
    logger.warn('fact-check-opening: the verifier did not run, Email 1 is not blocked on it', {
      prospect_id: params.prospectId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { claims: [], failures: [], usage, raw: '' }
  }

  const claims = parseFactCheckResponse(raw, [1])
  const failures = checkOpeningCitations(
    claims, params.findingsEvidence, params.bridge, params.question, params.companyName,
  )

  logger.info('fact-check-opening: checked', {
    prospect_id: params.prospectId,
    claims: claims.length,
    unsupported: claims.filter(c => !c.supported).length,
    failures: failures.length,
    rejected: failures,
  })

  return { claims, failures, usage, raw }
}
