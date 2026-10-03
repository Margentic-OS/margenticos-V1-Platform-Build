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
import { companyNameForms } from '@/lib/style/followup-gates'
import { ZERO_TOKEN_USAGE, addTokenUsage, readTokenUsage, type TokenUsage } from './types'
import { scopeBlockForChecker, type FollowupScope } from './followup-scope'

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

/**
 * THE RULES, SHARED BY EVERY FACT-CHECK. Parameterised rather than copied: a second prompt
 * holding the same rules is a second thing to keep in step, and the rules are the expensive
 * part. Only what genuinely differs between Email 1 and the follow-ups is a parameter.
 */
export function buildFactCheckPrompt(opts: {
  /** How the corpus is described, e.g. 'two emails' or 'one email'. */
  emailsShown: string
  /** The email number used in the output example, so the model returns a number that parses. */
  exampleEmail: number
  /**
   * Whether a QUESTION can itself carry a claim.
   *
   * False for follow-ups, where the closing question is a CTA and asserts nothing. True for
   * Email 1, whose question is written against the observation and routinely PRESUPPOSES it:
   * "Is finding new clients to replace those introductions something you're working on?"
   * asserts that introductions existed, in a sentence ending in a question mark. Excluding
   * questions wholesale would let the single most confident claim in the email through
   * unchecked.
   */
  questionsCanCarryClaims: boolean
}): string {
  const questionRule = opts.questionsCanCarryClaims
    ? `A QUESTION CAN CARRY A CLAIM, and Email 1's usually does. "Is replacing those
introductions something you're working on?" asserts that introductions existed. Judge what
the question TAKES FOR GRANTED about them, not the asking. A question that assumes nothing
("Worth a look?") returns nothing.`
    : `  a question`

  return `You check whether an email's claims follow from a set of research findings. You are
not writing, editing or judging quality. One question only: is each claim supported?

You are shown NUMBERED FINDINGS and ${opts.emailsShown}. Return every claim they make ABOUT
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

THE SUBJECT DECIDES, NOT THE TOPIC. A sentence whose subject is the READER or their
company is ALWAYS a claim about them, even when what it describes sounds like the sender's
service. "Your outbound runs on a retained basis" is a claim about how THEIR outbound is
arranged, and needs a finding saying so. "We run outbound on a retained basis" is the
sender's offer and needs nothing. The two sentences describe the same service and only one
of them is a claim about the reader.

THAT COVERS THEIR ACTIVITIES, METHODS AND ARRANGEMENTS: how they sell, how they hire, how
they run delivery, what they have in place, what is or is not already working. Every one of
those is a fact about their business that somebody has to have established.

WHAT IS NOT A CLAIM ABOUT THEM, and must not be returned:
  what the SENDER does or offers, with the SENDER as the subject
${opts.questionsCanCarryClaims ? '' : '  a question\n'}  a statement about a whole market that would be equally true of any firm in it
  a greeting or a sign-off

${questionRule}

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

{"claims":[{"email":${opts.exampleEmail},"claim":"<quoted from the email>","finding":3,"supported":true,"why":"<one line>"}]}

finding is the NUMBER of the finding, or null when nothing supports the claim.`
}

/** Splits the JSON out of the reply. Absent or malformed reads as "checked nothing". */
export function parseFactCheckResponse(raw: string, allowedEmails: readonly number[]): CheckedClaim[] {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as { claims?: unknown }
    if (!Array.isArray(parsed.claims)) return []
    return parsed.claims.flatMap(c => {
      if (!c || typeof c !== 'object') return []
      const o = c as Record<string, unknown>
      const email = Number(o.email)
      if (!allowedEmails.includes(email)) return []
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
 * A SENTENCE ASSERTING HOW THE READER'S OWN BUSINESS IS ARRANGED.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS IN CODE AND NOT IN THE PROMPT. Measured 2026-09-24: a follow-up shipped
 * "Your outbound runs on a retained basis, meaning conversations are in motion before a
 * role needs filling." That is the SENDER'S SERVICE described as the reader's existing
 * arrangement, and the fact-check passed it: asked to exclude "what the sender does or
 * offers", the model read a sentence about retained outbound as an offer and returned an
 * empty list. The prompt was corrected to say the SUBJECT decides, with that exact sentence
 * as its worked example, and the model still returned a bare {"claims":[]} with no
 * reasoning. Three iterations, no movement.
 *
 * ADR-028: a prompt instruction is advisory and a code gate binds. So the SHAPE is detected
 * here, and the model's job is reduced to the part it is good at: saying which finding
 * supports it. A sentence of this shape that the fact-check did not cover is a failure
 * naming the sentence, rather than a silent pass.
 *
 * THE SHAPE IS NARROW ON PURPOSE: a second-person possessive SUBJECT, then a verb of state
 * or arrangement. "Your outbound runs...", "Your content is...", "Your pipeline depends...".
 * It is a claim about how their business works, which somebody has to have established.
 * Not matched: "Your 15 September post used X to name Y", which reports an event rather
 * than asserting an arrangement, and which the findings carry.
 */
const READER_ARRANGEMENT =
  /\byour\s+[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}\s+(runs?|run|works?|is|are|goes|go|sits?|relies|depends?|operates?|happens?)\b/i

export function findReaderArrangements(text: string): string[] {
  return splitIntoSentences(text).filter(s => READER_ARRANGEMENT.test(s)).map(s => s.trim())
}

/**
 * A DECLARATIVE sentence whose subject is the reader or their firm.
 *
 * NARROW ON PURPOSE, because this rule fails the whole email. A question is excluded: a
 * follow-up's CTA is not a claim. A sentence with the SENDER as subject is excluded, because
 * describing the offer asserts nothing about them. What is left is the shape that has to be
 * checked: "You did X", "Your team is Y", "<Firm> published Z".
 */
/**
 * THE OFFER, WRITTEN IN THE READER'S TERMS, AND THEREFORE NOT A CLAIM ABOUT THEM.
 *
 * "You stop chasing the calendar." "You stay in delivery while the calendar fills." "You keep
 * advising while the meetings come in." Every one has a second-person subject and asserts
 * nothing about the reader's present or past: it describes what CHANGES once the service runs.
 * Email 1's P3 is required to be written exactly this way, in the prospect's terms rather than
 * the sender's, so a rule that treats the shape as a claim rejects the copy the writer is
 * instructed to produce.
 *
 * MEASURED, 2026-09-28, and this is why the exemption exists rather than being a guess: the
 * first version of the coverage rule flagged 43 distinct sentences across the 104 and 26 of
 * them were this shape. Clearing on it would have destroyed good copy and then rejected every
 * rewrite for the same reason, because the rewrite is instructed to write the same line.
 *
 * THE DISCRIMINATOR IS A CONSEQUENCE VERB WITH NO FACT MARKER. A sentence asserting a present
 * or past fact carries one: a past-tense verb, a date, or a perfect. "You refreshed the site
 * in early 2026" has two. "You stop chasing the calendar" has neither, and its verb is one of
 * a closed list of consequence verbs. A state claim like "Your pipeline needs someone holding
 * it" is NOT exempt, because `needs` is not a consequence of the service starting; it is an
 * assertion about how things stand now.
 */
const CONSEQUENCE_VERB =
  /^(?:you|your\s+\w+)\s+(?:no longer\s+)?(stop|stops|start|starts|stay|stays|keep|keeps|join|joins|hand|hands|get|gets|see|sees|spend|spends|end|ends|stay out|step back|carry on)\b/i

/**
 * The marks of an assertion about what IS or WAS: a date, a month, a perfect, or a past-tense
 * verb naming something that HAPPENED.
 *
 * A CURATED EVENT-VERB LIST, NOT `\w+ed`. The first version used a bare -ed match and it
 * defeated the exemption it was written to guard: "You stay FOCUSED on delivery" is the offer,
 * and `focused` ends in -ed. So do `arranged`, `interested`, `based`, `retained` and every
 * other participial adjective the copy legitimately uses. Measured 2026-09-28 on the six
 * empty-verdict positions, which is where it surfaced.
 */
const FACT_MARKER = new RegExp([
  '\\b(19|20)\\d{2}\\b',
  '\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\b',
  '\\b(?:has|have|had)\\s+\\w+(?:ed|en)\\b',
  '\\b(?:refreshed|published|posted|launched|hired|joined|ended|won|attended|spoke|shared|' +
    'rebuilt|moved|opened|added|appeared|announced|released|founded|acquired|stepped|' +
    'presented|hosted|completed|received|raised|closed|signed|promoted)\\b',
].join('|'), 'i')

export function isOfferVoice(sentence: string): boolean {
  return CONSEQUENCE_VERB.test(sentence.trim()) && !FACT_MARKER.test(sentence)
}

function sentencesNamingThem(text: string, companyName: string | null | undefined): string[] {
  const forms = companyNameForms(companyName ?? null).map(f => f.toLowerCase()).filter(f => f.length > 2)
  return splitIntoSentences(text)
    .map(s => s.trim())
    .filter(s => {
      if (!s || s.endsWith('?')) return false
      const low = s.toLowerCase()
      // The sender as subject is the offer, not a claim about them.
      if (/^(we|our|i)\b/.test(low)) return false
      // The offer in the READER'S terms is still the offer. See isOfferVoice.
      if (isOfferVoice(s)) return false
      if (/^(you|your)\b/.test(low)) return true
      return forms.some(f => low.startsWith(f) || low.startsWith(`the ${f}`))
    })
}

/**
 * Does this claim cover the sentence's OPENING, i.e. its subject and verb?
 *
 * `covers` CANNOT ANSWER THIS, and using it here was the first version's bug. It is loose
 * containment in either direction, so a claim that is a FRAGMENT of the sentence reads as
 * covering the whole of it. That is exactly the decomposition being caught: Karl's trailing
 * clause "which signals active investment in growth" is contained in the sentence, so
 * `covers` said the sentence was checked while its premise was never looked at.
 *
 * Asking about the opening asks the right question. The subject and the verb are where the
 * assertion lives; a verifier that did not read them did not check the sentence.
 */
function coversOpening(claim: string, sentence: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const c = norm(claim)
  const opening = norm(sentence).slice(0, 30)
  return opening.length > 0 && c.includes(opening)
}

/** Loose containment, so a claim quoted with different trimming still counts as covering. */
export function covers(claim: string, sentence: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const c = norm(claim)
  const x = norm(sentence)
  if (!c || !x) return false
  return c.includes(x.slice(0, 40)) || x.includes(c.slice(0, 40))
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
  companyName?: string | null,
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

  // EVERY SENTENCE ASSERTING AN ARRANGEMENT MUST BE COVERED BY A SUPPORTED CLAIM.
  //
  // This is the fix for a sentence the model would not classify at all. Detecting the shape
  // is code's job; saying which finding supports it is the model's. An uncovered one is a
  // failure that NAMES THE SENTENCE, so the rewrite has something specific to change,
  // instead of the blunt "returned no claims" the shortfall check gives.
  for (const sentence of [...findReaderArrangements(prose2), ...findReaderArrangements(prose3)]) {
    const covered = claims.some(c => c.supported && covers(c.claim, sentence))
    if (!covered) {
      failures.push(
        `states how their business is arranged, with nothing cited for it: ${JSON.stringify(sentence)}. ` +
        'Say what the sender does, or name the finding that establishes this.',
      )
    }
  }

  // ═══ EVERY DECLARATIVE SENTENCE ABOUT THEM MUST BE COVERED BY A RETURNED CLAIM ═══
  //
  // WHAT THIS CATCHES, and it is a real escape rather than a hypothetical. Measured
  // 2026-09-25, a follow-up shipped:
  //
  //     "You refreshed the Brightpath site in early 2026, which signals active
  //      investment in growth."
  //
  // Nothing in that prospect's research mentions a website, a refresh, or 2026. The
  // fact-check RAN and REJECTED the sentence, but only its trailing clause: it returned the
  // claim as "which signals active investment in growth" and explained that "the finding
  // notes the site was refreshed but makes no claim about growth investment intent". There
  // is no such finding. The verifier DECOMPOSED the sentence, checked the inference, treated
  // the premise as established, and invented a finding to justify doing so.
  //
  // So the failure is not a wrong verdict on a claim. It is a claim that was never returned,
  // and the existing rules could not see it: the arrangement detector matches "your X runs",
  // not "You refreshed X", and the shortfall rule only fires when the list is EMPTY, which
  // it was not.
  //
  // ADR-028 again: deciding a sentence is about them is a shape, which is code's job. Saying
  // which finding supports it is the model's.
  // LABELLED BY EMAIL, and scanned per email rather than over both at once. Unlabelled
  // failures are attributed to BOTH positions by every caller that splits them, so one fault
  // in email 2 cleared email 3 as well. Measured 2026-09-28: 43 distinct coverage faults
  // reported as 86 instances, every one of them double-counted.
  for (const [position, prose] of [[2, prose2], [3, prose3]] as const) {
    for (const sentence of sentencesNamingThem(prose, companyName)) {
      if (!claims.some(c => coversOpening(c.claim, sentence))) {
        failures.push(
          `email ${position} states something about them that the fact-check never returned ` +
          `as a claim: ${JSON.stringify(sentence)}. Every sentence about this prospect has to be checked.`,
        )
      }
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

// ═════════════════════════════════════════════════════════════════════════════
// THE SENDER'S SCOPE, ASKED IN THE SAME CALL. Added 2026-10-03, operator instruction.
//
// The questions above are all about the PROSPECT. A follow-up after a prospect spoke at an
// event said the sender would go and contact the people who saw them there, which is a claim
// about the SENDER, so nothing above read it, and it is not what that client does: its brief
// says it finds THE CLIENT'S buyers. So when the client has a brief, the same call is also
// shown its scope and asked three things per email: every claim about what the sender does,
// and which scope item covers it; whether the email implies the reader ALREADY HAS what the
// offer provides; and whether it asserts something about the reader's firm the findings do
// not establish, which catches the population sentence ("firms without X rarely manage Y")
// that the claims list above is told to leave out.
//
// NO NEW MODEL CALL. The questions ride on the fact-check, and with no brief they are not
// asked at all, so a client without one is checked exactly as before.
//
// THE MODEL'S ANSWER IS A CLAIM AND CODE DECIDES, as with the citations above: a cited scope
// id must exist in the brief, a sentence whose subject is the sender must have been returned
// as a sender claim, and an email with no verdict at all fails rather than passing unread.
// ═════════════════════════════════════════════════════════════════════════════

/** Appended to the fact-check prompt only when the client has a brief. Rule Zero: no market's wording. */
export const FOLLOWUP_SCOPE_RULES = `## THE SENDER'S SCOPE, AND WHAT THE READER ALREADY HAS

You are also shown the SENDER'S SCOPE: what the sender does, what it never claims, and the
outcomes a reader can get from it, each with an id. For EACH email, also answer three things.

sender_claims: every statement in the email about what the SENDER does, will do or offers,
quoted exactly from the email, from the start of its sentence. A sentence whose subject is the
sender ("we", "our", "I") is always one. For each:
  covered_by: the id of the item in "What the sender does" that says the sender does this; or
    the id of an outcome when the statement only says the reader CAN get that outcome, with no
    number, no time and no promise added. null when nothing in the scope says the sender does
    it. Work that resembles a scope item but is done for different people, or on a different
    thing, is NOT covered by it.
  violates: the id of an item in "What the sender never claims" that the statement states or
    implies, or null.

reader_has_outcome: the sentence, quoted, that says or implies the reader ALREADY HAS what the
sender offers (one of the outcomes, or what the sender's work produces), or null. The offer is
something they can get. A sentence presenting it as theirs already, or as working for them
already, is this fault.

presumes_about_reader: the sentence, quoted, that asserts or presumes something about the
reader's firm which the numbered findings do not establish, or null. A sentence about firms in
general counts when this reader would take it as describing them: "firms without X rarely
manage Y" tells the reader they lack X. A question that presumes nothing does not count.

Add this field to the same JSON object, with an entry for EVERY email shown:

"emails":[{"email":2,"sender_claims":[{"claim":"<quoted from the email>","covered_by":"<id>","violates":null}],"reader_has_outcome":null,"presumes_about_reader":null}]

An email with no entry is treated as unchecked, and an unchecked email does not ship.`

/** One email's scope verdict, as the model gave it. */
export interface EmailScopeVerdict {
  email: number
  sender_claims: Array<{ claim: string; covered_by: string | null; violates: string | null }>
  reader_has_outcome: string | null
  presumes_about_reader: string | null
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Reads the per-email scope verdicts. An entry that is not shaped like one is DROPPED, and a
 * dropped entry reads as an email with no verdict, which checkScope fails. So a malformed
 * answer can only ever refuse a follow-up, never pass one.
 */
export function parseScopeVerdicts(raw: string, allowedEmails: readonly number[]): EmailScopeVerdict[] {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as { emails?: unknown }
    if (!Array.isArray(parsed.emails)) return []
    return parsed.emails.flatMap(e => {
      if (!e || typeof e !== 'object') return []
      const o = e as Record<string, unknown>
      const email = Number(o.email)
      if (!allowedEmails.includes(email) || !Array.isArray(o.sender_claims)) return []
      const senderClaims = o.sender_claims.flatMap(c => {
        if (!c || typeof c !== 'object') return []
        const x = c as Record<string, unknown>
        return typeof x.claim === 'string'
          ? [{ claim: x.claim, covered_by: textOrNull(x.covered_by), violates: textOrNull(x.violates) }]
          : []
      })
      return [{
        email,
        sender_claims: senderClaims,
        reader_has_outcome: textOrNull(o.reader_has_outcome),
        presumes_about_reader: textOrNull(o.presumes_about_reader),
      }]
    })
  } catch {
    return []
  }
}

/** A sentence whose subject is the sender. The narrow shape, the same one sentencesNamingThem excludes. */
function senderSentences(text: string): string[] {
  return splitIntoSentences(text)
    .map(s => s.trim())
    .filter(s => s && !s.endsWith('?') && /^(we|our|i)\b/i.test(s))
}

/**
 * THE CODE HALF OF THE SCOPE CHECK. Every failure names its email, so the routing in
 * write-followups charges it to that email alone and the other can still ship.
 */
export function checkScope(
  verdicts: readonly EmailScopeVerdict[],
  scope: FollowupScope,
  prose2: string,
  prose3: string,
): string[] {
  const failures: string[] = []
  const covers = new Set([...scope.does.map(d => d.id), ...scope.outcomes.map(o => o.id)])
  const neverById = new Map(scope.never_claims.map(n => [n.id, n.statement]))

  for (const [position, prose] of [[2, prose2], [3, prose3]] as const) {
    if (!prose.trim()) continue
    const v = verdicts.find(x => x.email === position)
    if (!v) {
      failures.push(`email ${position}: the fact-check returned no scope verdict for it, and an unchecked email is not a clean one`)
      continue
    }
    for (const c of v.sender_claims) {
      if (c.violates !== null) {
        const statement = neverById.get(c.violates)
        failures.push(
          `email ${position} says ${JSON.stringify(c.claim)}, which this client never claims` +
          (statement ? ` (${c.violates}: ${statement})` : ` (${c.violates})`),
        )
      } else if (c.covered_by === null) {
        failures.push(
          `email ${position} says the sender will ${JSON.stringify(c.claim)}, which is outside what this client does: ` +
          'say only what the brief says the sender does',
        )
      } else if (!covers.has(c.covered_by)) {
        // A citation to a scope item that does not exist, the same fault as a citation to a
        // finding that does not exist, and unsupported by definition.
        failures.push(
          `email ${position} says ${JSON.stringify(c.claim)} and cites scope item ${c.covered_by}, ` +
          'which is not in this client\'s brief',
        )
      }
    }
    // A SHORT VERDICT LOOKS CLEAN. Every sentence with the sender as its subject is a claim
    // about the sender, and one the model did not return was not checked.
    for (const sentence of senderSentences(prose)) {
      if (!v.sender_claims.some(c => coversOpening(c.claim, sentence))) {
        failures.push(
          `email ${position} says what the sender does, and the scope check never returned it as a claim: ` +
          `${JSON.stringify(sentence)}`,
        )
      }
    }
    if (v.reader_has_outcome !== null) {
      failures.push(
        `email ${position} implies the reader already has what the offer provides: ` +
        `${JSON.stringify(v.reader_has_outcome)}. The offer is something they can get, not something they have`,
      )
    }
    if (v.presumes_about_reader !== null) {
      failures.push(
        `email ${position} asserts something about their firm that the findings do not establish: ` +
        `${JSON.stringify(v.presumes_about_reader)}`,
      )
    }
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
  /** For spotting a sentence whose subject is their firm. Null is handled. */
  companyName?: string | null
  /**
   * The client's brief scope, or null/absent when the client has none. Absent means the
   * scope questions are not asked and the check runs exactly as it did before 2026-10-03.
   */
  scope?: FollowupScope | null
}

/**
 * Run the fact-check. Never throws for a model fault: a verifier that cannot run must not
 * take the emails down with it, so an API failure returns no claims and no failures and
 * says so in the log.
 */
export async function factCheckFollowups(params: FactCheckParams): Promise<FactCheckResult> {
  const client = new Anthropic({ apiKey: params.apiKey })
  const scope = params.scope ?? null
  const user = [
    // THE SCOPE FIRST, when there is one, so the ids the answer cites are in front of the
    // model before the emails that need them. Absent, the message is byte-identical to before.
    ...(scope ? [scopeBlockForChecker(scope), ''] : []),
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
      // MORE ROOM WHEN THE SCOPE IS ASKED: the answer now carries a second list per email,
      // and a reply cut off at the ceiling fails open (below), so a tight ceiling would turn
      // the scope check off on exactly the emails with the most to say.
      max_tokens: scope ? 3000 : 2000,
      system: buildFactCheckPrompt({ emailsShown: 'two emails', exampleEmail: 2, questionsCanCarryClaims: false }) +
        (scope ? `\n\n${FOLLOWUP_SCOPE_RULES}` : ''),
      messages: [{ role: 'user', content: user }],
    })
    usage = addTokenUsage(usage, readTokenUsage(reply.usage))
    raw = reply.content.map(c => (c.type === 'text' ? c.text : '')).join('')

    // ── A TRUNCATED REPLY IS THE CHECK FAILING, NOT THE EMAILS FAILING ────────
    //
    // The catch below fails open for an API fault, and the header promises that "a verifier
    // that cannot run must not take the emails down with it". A reply cut off at max_tokens
    // does NOT throw: the JSON has no closing brace, parseFactCheckResponse returns [], the
    // shortfall rule fires, and both follow-ups are discarded. So the promise held for the
    // rarer fault and broke for the likelier one, on a prompt that asks for EVERY claim.
    //
    // ADR-059 is the standing rule: a truncated model answer is a FAILURE WITH ITS OWN
    // REASON and is never filed as something else. Here that means the same branch as an
    // outage, because the copy has already passed every rule that is not this one.
    if (reply.stop_reason === 'max_tokens') {
      logger.warn('fact-check-followups: reply truncated at max_tokens, follow-ups not gated on it', {
        prospect_id: params.prospectId,
        output_tokens: reply.usage?.output_tokens,
      })
      return { claims: [], failures: [], usage, raw }
    }
  } catch (err) {
    throwIfFatal(err, `fact-check for prospect ${params.prospectId}`)
    logger.warn('fact-check-followups: the check itself failed, follow-ups not gated on it', {
      prospect_id: params.prospectId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { claims: [], failures: [], usage, raw: '' }
  }

  const claims = parseFactCheckResponse(raw, [2, 3])
  const scopeVerdicts = scope ? parseScopeVerdicts(raw, [2, 3]) : []
  const failures = [
    ...checkCitations(claims, params.findingsEvidence, params.prose2, params.prose3, params.companyName ?? null),
    ...(scope ? checkScope(scopeVerdicts, scope, params.prose2, params.prose3) : []),
  ]

  // THE FAILURES THEMSELVES, not just how many. Counted-only logging was enough to know the
  // check fired and useless for saying WHAT it rejected: after the run of 2026-09-24 the
  // rejected claims could not be quoted at all, because the prose that carried them is
  // discarded and follow-up attempts are not persisted the way Email 1's are.
  logger.info('fact-check-followups: checked', {
    prospect_id: params.prospectId,
    claims: claims.length,
    unsupported: claims.filter(c => !c.supported).length,
    failures: failures.length,
    rejected: failures,
    unsupported_claims: claims.filter(c => !c.supported).map(c => ({
      email: c.email, claim: c.claim, why: c.why,
    })),
    scope_checked: scope !== null,
    scope_verdicts: scope ? scopeVerdicts : undefined,
  })

  return { claims, failures, usage, raw }
}
