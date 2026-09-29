/**
 * IS THE ABSENCE ABOUT THE PROSPECT, OR ABOUT SOMEBODY ELSE?
 *
 * WHY THIS WRAPPER EXISTS. findEvidenceAbsences in the trigger gate finds absence LANGUAGE
 * anywhere in a string, which is right for its own job: it reports on evidence lines so a
 * human can read them. Used to DISQUALIFY a candidate it over-fires badly. Measured across
 * 601 real candidates on 2026-09-28, it flagged 13, and three of those were plainly wrong:
 *
 *   "John published a post on 15 September positioning AGI against transactional recruiters
 *    who send resumes WITHOUT FOLLOW-through"      <- the absence is about RECRUITERS
 *   "Vanessa published 'Your Mission on the Wall. A Destination NO ONE Knows.'"
 *                                                  <- the absence is inside a QUOTED TITLE
 *   "a piece on why the right message is NOT ENOUGH WITHOUT the right audience"
 *                                                  <- the absence is the TOPIC she wrote about
 *
 * All three are dated things the prospect DID, which is exactly what a hook is supposed to be.
 *
 * DATE PRECISION DOES NOT SEPARATE THEM, which was the first idea and worth recording as a
 * dead end: of the 13, day-precise dates appear on both the true hits (Brian Murphy's
 * lifestyle-content survey, 2026-05-19) and the false ones (McCarthy 2026-09-15), so a
 * date-based rule keeps Brian and drops John, the precise opposite of what is wanted.
 *
 * WHAT DOES SEPARATE THEM IS WHOSE ABSENCE IT IS. Two exclusions, in order:
 *
 *   1. QUOTED SPANS ARE REMOVED FIRST. A title the prospect published is a thing they made,
 *      not a claim the research is making about them.
 *   2. THE ABSENCE MUST SIT IN A CLAUSE THAT REFERS TO THEM. Their name, their firm's name,
 *      or one of their own surfaces (their site, homepage, profile, team page, feed). An
 *      absence in a clause about a third party is about the third party.
 *
 * THE DIRECTION OF FAILURE IS DELIBERATE. A missed absence ships one weak hook. A false
 * positive removes a prospect's best fact and, when it is their only one, sends them the
 * template. So this errs towards keeping the candidate, and the gates downstream still read
 * the written sentence.
 */
import { findEvidenceAbsences } from '@/agents/trigger-evidence-gate'
import { companyNameForms } from '@/lib/style/followup-gates'

/** Straight and curly, single and double. Quoted spans are removed before detection. */
const QUOTED = /(["“”][^"“”]{2,}["“”])|(['‘’][^'‘’]{4,}['‘’])/g

/**
 * Their own surfaces. An absence on one of these is an absence about them even when neither
 * their name nor their firm's appears in the clause: "the site has no blog" is about their site.
 */
const THEIR_SURFACE =
  /\b(?:the\s+)?(?:site|website|homepage|home page|profile|team page|about page|feed|blog|newsletter|careers page)\b/i

/**
 * THE SUBJECT MATTER OF SOMETHING THEY PUBLISHED IS NOT AN ABSENCE ABOUT THEM.
 *
 * "published a piece on August 12 on why the right message is NOT ENOUGH WITHOUT the right
 * audience" is a dated thing they did. The absence is what the piece ARGUES, and the clause
 * names them, so an anchor test alone lets it through. Measured on the 2026-09-28 cohort: this
 * is the one false positive that survived the quoted-span and third-party exclusions.
 *
 * Matched narrowly: a publication verb, then a topic marker, then the absence. Everything
 * after the marker is the content of the thing, not a claim about its author.
 */
const PUBLISHED_TOPIC =
  /\b(?:published|posted|shared|wrote|authored|released)\b[^.]{0,80}?\b(?:on|about)\s+(?:why|how|what|whether|the)\b/i

/** The span from a topic marker to the end of the clause, which is reported content. */
function stripPublishedTopic(clause: string): string {
  const m = clause.match(PUBLISHED_TOPIC)
  if (!m || m.index === undefined) return clause
  return clause.slice(0, m.index + m[0].length - m[0].split(/\b(?:on|about)\s+/i).slice(-1)[0].length)
}

/** Clause boundaries. An absence is judged against the clause it sits in, not the whole line. */
function clauses(text: string): string[] {
  // A RELATIVE PRONOUN STARTS A NEW CLAUSE WITH OR WITHOUT A COMMA. Requiring the comma left
  // "positioning AGI against transactional recruiters who send resumes without follow-through"
  // as ONE clause, so the anchor (the firm's name, early) and the absence (about recruiters,
  // late) sat together and the candidate was wrongly excluded.
  //
  // THE COST IS A FALSE NEGATIVE, ACCEPTED. "the site that has no blog" now splits, and the
  // half carrying the absence no longer carries the surface noun, so it is kept. That is the
  // direction of failure this module chooses: a missed absence ships one weak hook, a false
  // positive can take a prospect's only fact and send the template.
  // NOT ON EVERY COMMA. That was tried and it broke the case this exists for: "...covering
  // vacations, family, and moving, with no IT, business development, or client-facing content"
  // split "with no IT" into its own clause with no anchor in it, so the candidate was kept.
  // A comma inside a list is not a clause boundary; a relative pronoun is.
  return text.split(/(?:[.;:]|\s+(?:who|which|that)\s+)/i).map(c => c.trim()).filter(Boolean)
}

export interface AbsenceAboutThemInput {
  observation: string
  companyName?: string | null
  firstName?: string | null
}

/** The clause carrying an absence about them, or null. Returned so a caller can log it. */
export function absenceAboutThem(input: AbsenceAboutThemInput): { clause: string; matched: string } | null {
  const bare = (input.observation ?? '').replace(QUOTED, ' ')
  if (!bare.trim()) return null

  const anchors = [
    ...companyNameForms(input.companyName ?? null),
    ...(input.firstName ? [input.firstName] : []),
  ].map(a => a.toLowerCase()).filter(a => a.length > 2)

  for (const raw of clauses(bare)) {
    const clause = stripPublishedTopic(raw)
    const hits = findEvidenceAbsences(clause)
    if (hits.length === 0) continue
    const low = clause.toLowerCase()
    const namesThem =
      anchors.some(a => low.includes(a)) ||
      THEIR_SURFACE.test(clause) ||
      // A second-person possessive is them by construction.
      /\byour\b/i.test(clause)
    if (namesThem) return { clause, matched: hits[0].matched }
  }
  return null
}
