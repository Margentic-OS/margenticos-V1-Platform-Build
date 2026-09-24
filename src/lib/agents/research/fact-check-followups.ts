// EVERY CLAIM IN A FOLLOW-UP MUST CITE THE FINDING THAT SUPPORTS IT.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS, MEASURED 2026-09-24.
//
// The follow-up writer had NO check of any kind comparing what it wrote against the
// findings. checkFollowupGates accepted a findingsEvidence corpus whose doc comment claimed
// "the traceability and firmographic checks read" it; the field appeared exactly once in
// the file, as the interface declaration, and was never destructured. Email 1's equivalent
// was not exported and so unreachable.
//
// TWO FABRICATION SHAPES CAME OUT OF THAT, and they need different treatment:
//
//   AN INVENTED PREDICATE. One prospect's findings say a post DIRECTED CANDIDATES TO a
//   named person. Both follow-ups said the prospect had "brought on" that person. Every
//   proper noun in the sentence is in the findings, so a name-matching traceability check
//   returns clean: the invention is in the VERB.
//
//   AN INVENTED CATEGORY. Another prospect's raw LinkedIn source is, in full,
//   {"error":"...no posts in the last 180 days"}. His research row has one candidate, an
//   employment record. Both his follow-ups describe a body of LinkedIn posts that does not
//   exist. There is no wrong word to find; the whole subject is absent.
//
// NEITHER IS REACHABLE BY PATTERN. A predicate is not a token, and an absence is not a
// string. So this is the one part of the follow-up path where a second model call is
// justified under ADR-018: the judgement is "does this sentence follow from that finding",
// which is reading comprehension and nothing else.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT KEEPS IT HONEST. A model asked to check itself will agree with itself, and a model
// asked to cite will cite something. So the MODEL'S CITATION IS A CLAIM, NOT PROOF, and
// code checks every one of them:
//
//   1. the cited finding number must EXIST in the numbered corpus. A citation to finding 7
//      of a five-line corpus is a fabricated citation, and the claim it supports is
//      unsupported by definition.
//   2. a claim marked supported must carry a citation at all.
//   3. every sentence in the copy must be accounted for. A verifier that returns two claims
//      about a six-sentence email has not checked the other four, and the shortfall is
//      reported rather than read as a pass.
//
// Rule three is the one that matters most and is the cheapest to get wrong: the failure
// mode of a verifier is not a wrong verdict, it is a SHORT verdict that looks clean.
// ═════════════════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '@/lib/logger'
import { throwIfFatal } from '@/lib/agents/fatal-api-error'
import { splitIntoSentences } from '@/lib/style/sentence-count'
import { ZERO_TOKEN_USAGE, addTokenUsage, readTokenUsage, type TokenUsage } from './types'

const FACT_CHECK_MODEL = 'claude-sonnet-4-6'

/** One claim the verifier found, and what it says supports it. */
export interface CheckedClaim {
  /** 2 or 3. */
  email: number
  /** The sentence or clause from the copy, quoted. */
  claim: string
  /** The 1-based finding number the verifier cited, or null when it found none. */
  finding: number | null
  supported: boolean
  /** The verifier's one-line reason. */
  why: string
}

export interface FactCheckResult {
  claims: CheckedClaim[]
  /** Every reason this pair must not ship. Empty means it may. */
  failures: string[]
  usage: TokenUsage
  /** The raw reply, kept so a verdict can be read rather than inferred. */
  raw: string
}

/**
 * The corpus the verifier cites into, numbered so a citation is checkable.
 *
 * SAME SHAPE AS buildFindingsEvidence, which already numbers from 1. Kept as its own
 * function so the count of lines is derived from the string the model actually saw, rather
 * than from a second copy of the candidate list that could disagree with it.
 */
export function countFindingLines(findingsEvidence: string): number {
  return findingsEvidence.split('\n').filter(l => /^\s*\d+\.\s/.test(l)).length
}

export function buildFactCheckPrompt(): string {
  return `You check whether an email's claims follow from a set of research findings. You are
not writing, editing or judging quality. One question only: is each claim supported?

You are shown NUMBERED FINDINGS and two emails. Return every claim the emails make ABOUT
THE PROSPECT OR THEIR COMPANY, and for each one the finding number that supports it.

WHAT COUNTS AS A CLAIM ABOUT THEM:
  something they did, published, won, launched, hired, attended or announced
  something their company is, has or does
  a date, a duration, or a count
  a statement about their situation presented as fact

A STATEMENT WITH NO "YOU" IN IT IS STILL ABOUT THEM if a reader would take it as
describing THIS business. "The bandwidth that used to go to business development is now
going elsewhere" names no one and is a claim about how their week is spent. "Delivery is
consuming the week" is the same. Ask who the sentence would be false about if it were
wrong: if the answer is this reader, it is a claim about them.

WHAT IS NOT A CLAIM ABOUT THEM, and must not be returned:
  what the SENDER does or offers
  a question
  a statement about a whole market that would be equally true of any firm in it
  a greeting or a sign-off

SUPPORTED MEANS THE FINDING SAYS IT. Not "is consistent with", not "is plausible given".
THE VERB MATTERS AS MUCH AS THE NOUN. If a finding says a post directed people to someone,
an email saying they HIRED that person is NOT supported: the names match and the action
does not. If the findings contain no material on a subject at all, every claim about that
subject is unsupported, however reasonable it sounds.

RETURN EVERY CLAIM, including the ones that are obviously fine. A short list reads as a
clean email, and an email you only half-checked is the failure this exists to prevent.

AN EMPTY LIST IS ALMOST ALWAYS WRONG. If an email contains any sentence that is not a
question, it is making a claim, and that claim is either supported or it is not. "The
bandwidth that used to go to business development is now going elsewhere" is a claim about
their business, not a statement about a market. "Your LinkedIn content is consistent" is a
claim about their publishing. Return them. Returning nothing is read as not having
checked, which is treated as a failure.

Return ONLY this JSON, no prose around it:

{"claims":[{"email":2,"claim":"<quoted from the email>","finding":3,"supported":true,"why":"<one line>"}]}

finding is the NUMBER of the finding, or null when nothing supports the claim.`
}

/** Splits the JSON out of the reply. Absent or malformed reads as "checked nothing". */
export function parseFactCheckResponse(raw: string): CheckedClaim[] {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as { claims?: unknown }
    if (!Array.isArray(parsed.claims)) return []
    return parsed.claims.flatMap(c => {
      if (!c || typeof c !== 'object') return []
      const o = c as Record<string, unknown>
      const email = Number(o.email)
      if (email !== 2 && email !== 3) return []
      const finding = o.finding === null || o.finding === undefined ? null : Number(o.finding)
      return [{
        email,
        claim: typeof o.claim === 'string' ? o.claim : '',
        finding: finding !== null && Number.isFinite(finding) ? finding : null,
        supported: o.supported === true,
        why: typeof o.why === 'string' ? o.why : '',
      }]
    })
  } catch {
    return []
  }
}

/**
 * THE CODE HALF. Every failure here is derived from the verifier's own output plus the
 * corpus, never from trusting it.
 */
export function checkCitations(
  claims: readonly CheckedClaim[],
  findingsEvidence: string,
  prose2: string,
  prose3: string,
): string[] {
  const failures: string[] = []
  const lineCount = countFindingLines(findingsEvidence)

  for (const c of claims) {
    // A CITATION TO A FINDING THAT DOES NOT EXIST. The model invents these, and a claim
    // resting on one is unsupported whatever the verdict says.
    if (c.supported && (c.finding === null || c.finding < 1 || c.finding > lineCount)) {
      failures.push(
        `claims ${JSON.stringify(c.claim)} is supported by finding ${c.finding ?? 'none'}, ` +
        `which does not exist: the findings have ${lineCount} lines`,
      )
      continue
    }
    if (!c.supported) {
      failures.push(
        `email ${c.email} states ${JSON.stringify(c.claim)}, which the findings do not support` +
        (c.why ? `: ${c.why}` : ''),
      )
    }
  }

  // THE SHORTFALL CHECK, and it is the one that matters. A verifier that returns two claims
  // about a six-sentence email has checked neither the other four nor itself. Counted
  // against sentences that make a statement, so questions and the sign-off do not inflate it.
  const statements = [prose2, prose3].flatMap(p =>
    splitIntoSentences(p).filter(s => s.trim().length > 0 && !s.trim().endsWith('?')),
  ).length
  if (statements > 0 && claims.length === 0) {
    failures.push(
      `the fact-check returned no claims for ${statements} statements: ` +
      'an empty verdict is not a clean one',
    )
  }

  return failures
}

export interface FactCheckParams {
  apiKey: string
  prose2: string
  prose3: string
  /** The NUMBERED findings the verifier cites into. */
  findingsEvidence: string
  prospectId: string
}

/**
 * Run the fact-check. Never throws for a model fault: a verifier that cannot run must not
 * take the emails down with it, so an API failure returns no claims and no failures and
 * says so in the log.
 */
export async function factCheckFollowups(params: FactCheckParams): Promise<FactCheckResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const user = [
    '## Numbered findings',
    '',
    params.findingsEvidence,
    '',
    '## Email 2',
    '',
    params.prose2,
    '',
    '## Email 3',
    '',
    params.prose3,
  ].join('\n')

  let raw = ''
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  try {
    const reply = await client.messages.create({
      model: FACT_CHECK_MODEL,
      max_tokens: 2000,
      system: buildFactCheckPrompt(),
      messages: [{ role: 'user', content: user }],
    })
    usage = addTokenUsage(usage, readTokenUsage(reply.usage))
    raw = reply.content.map(c => (c.type === 'text' ? c.text : '')).join('')
  } catch (err) {
    throwIfFatal(err, `fact-check for prospect ${params.prospectId}`)
    logger.warn('fact-check-followups: the check itself failed, follow-ups not gated on it', {
      prospect_id: params.prospectId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { claims: [], failures: [], usage, raw: '' }
  }

  const claims = parseFactCheckResponse(raw)
  const failures = checkCitations(claims, params.findingsEvidence, params.prose2, params.prose3)

  logger.info('fact-check-followups: checked', {
    prospect_id: params.prospectId,
    claims: claims.length,
    unsupported: claims.filter(c => !c.supported).length,
    failures: failures.length,
  })

  return { claims, failures, usage, raw }
}
