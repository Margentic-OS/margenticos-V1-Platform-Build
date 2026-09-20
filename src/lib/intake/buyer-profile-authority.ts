// The buyer-targeting answers, presented to the ICP agent as BINDING on named schema
// fields, and read as values by the code downstream of it.
//
// ─── WHY A SEPARATE BLOCK AND NOT ANOTHER INTAKE SECTION ─────────────────────
//
// The twenty narrative answers reach the ICP agent as one undifferentiated block of
// "Q: <label> / A: <answer>" pairs, and the model decides for itself which answer informs
// which schema field. That works for narrative: the answers are prose, the fields are
// prose, and the reading is the model's job. It is also the measured root cause of every
// invented value in company_profile, because a field with no answer behind it looks
// exactly like a field whose answer the model failed to find.
//
// These five questions are different in kind. Each one was asked directly, about one
// schema field, in a control shaped like that field: two integers for a range, a list for
// a list, a fixed set for a fixed set. There is nothing to interpret and nothing to weigh.
// So they are not added to the narrative block. They are presented separately, and the
// prompt says what they are: not evidence, the value.
//
// ─── WHY IT IS ABSENT RATHER THAN EMPTY WHEN NOTHING WAS ANSWERED ────────────
//
// buildBuyerProfileBlock returns '' for an organisation with no row, and for one whose row
// is entirely unanswered. Four of the five live organisations have no row. An empty block
// with headings and "[not answered]" under each would change every one of their prompts,
// which is a change to document generation for clients this session was not asked to touch.
// Absent means the message is byte-identical to the one they get today.
//
// The same holds field by field. A client who answered the countries question and skipped
// the headcount one gets a block naming countries and silent about headcount, so the
// headcount rules elsewhere in the prompt apply unchanged.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// No static string in this file names a country, a job title, an industry, a sector, a
// seniority level or a client archetype. Every concrete value in the rendered block is the
// client's own text, interpolated at run time. There is deliberately NO worked example: an
// example in a targeting instruction is an instruction, and this project has written that
// lesson down eight times. Enforced by the scans in
// src/lib/intake/__tests__/buyer-profile-authority.test.ts, which read the same alias table
// the geography agent's prompt is scanned against.

import type { BuyerProfile } from '@/lib/intake/buyer-profile'

/** A stated headcount pair, or null when the client did not answer that question. */
export interface StatedHeadcount {
  min: number
  max: number
}

/**
 * The two integers the client typed, or null.
 *
 * BOTH OR NEITHER. The database CHECK already forbids half a range, and this repeats the
 * condition rather than trusting it: a row written before that constraint, or one arriving
 * from a fake in a test, would otherwise reach a caller that reads `.min` on null.
 */
export function statedHeadcount(profile: BuyerProfile): StatedHeadcount | null {
  const { buyer_headcount_min: min, buyer_headcount_max: max } = profile
  if (typeof min !== 'number' || typeof max !== 'number') return null
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null
  if (min < 1 || max < min) return null
  return { min, max }
}

/**
 * The geography hint for this client's web research queries, from the stated countries.
 *
 * ─── WHY A STATED LIST ALWAYS BEATS THE DOMAIN GUESS, IN BOTH BRANCHES ───────
 *
 * geographyFromIntake reads the ccTLD of the client's own website. It is an allowlist, it
 * is deliberate, and three of the five live organisations are on a generic TLD and get
 * nothing from it. It is also a guess about one country made from a domain registration,
 * and a client who has now typed the countries they sell to has answered the question the
 * guess was standing in for.
 *
 * ONE STATED COUNTRY becomes the hint.
 *
 * SEVERAL STATED COUNTRIES produce NO HINT, and the domain guess is not consulted either.
 * This is the branch worth explaining, because doing nothing looks like giving up. A web
 * search query is a bag of words the provider ANDs together: appending three countries
 * returns pages that mention all three, which is narrower than any one of them and usually
 * empty. Appending the domain's country instead names one country out of several the
 * client did not single out, and may name one they never listed at all. The existing
 * trade-off recorded against geographyFromIntake settles which way to fail: a query with
 * no geography returns broader results, a query with the wrong geography returns results
 * about the wrong market and reads as though it worked. Broader beats wrong.
 *
 * The full list is not lost by this. It reaches the model in the block below, where it
 * binds company_profile.geography outright, which is the channel that decides who gets
 * sourced. The research hint only shapes what gets searched for.
 */
export function statedGeographyHint(profile: BuyerProfile): string {
  const countries = profile.target_countries.filter(c => c.trim().length > 0)
  return countries.length === 1 ? countries[0].trim() : ''
}

/** True when the client stated at least one country. */
export function hasStatedCountries(profile: BuyerProfile): boolean {
  return profile.target_countries.some(c => c.trim().length > 0)
}

/** One value per line, so a value containing a comma needs no delimiter and no parser. */
function bullets(values: readonly string[]): string {
  return values
    .map(v => v.trim())
    .filter(v => v.length > 0)
    .map(v => `  - ${v}`)
    .join('\n')
}

/** The heading the block opens with. Exported so tests assert on it rather than a copy. */
export const BUYER_PROFILE_BLOCK_HEADING =
  '## THE CLIENT ANSWERED THESE DIRECTLY. THEY ARE THE VALUES, NOT EVIDENCE.'

/**
 * The block, or '' when this organisation answered none of these questions.
 *
 * Each entry names the schema path it binds and states the authority in the same sentence,
 * because a rule stated once at the top of a section is read once and a rule restated
 * beside each value is read where it applies.
 *
 * TIER 1 AND TIER 2 ONLY, stated explicitly. Tier 3 is the do-not-target tier: it
 * describes who this client should be kept away from, so binding a targeting answer into
 * it would make the disqualifier tier describe the target. The geography derivation and
 * the filter spec both already read tiers 1 and 2 and neither reads tier 3, so this
 * matches what the rest of the pipeline does rather than introducing a new rule.
 */
export function buildBuyerProfileBlock(profile: BuyerProfile): string {
  const parts: string[] = []

  const countries = profile.target_countries.filter(c => c.trim().length > 0)
  if (countries.length > 0) {
    parts.push(
      'COUNTRIES THE CLIENT SELLS INTO. This IS ' +
      '`company_profile.geography` for tier 1 and tier 2. Write it as these countries and ' +
      'nothing else. Do not widen it to a region that contains them, do not add a country ' +
      'because the research or the website suggests one, and do not write a phrase such as ' +
      'an ordinary-language description of a group of markets in place of the list. If the ' +
      'client named one country, the geography is that one country.\n' +
      bullets(countries),
    )
  }

  const headcount = statedHeadcount(profile)
  if (headcount) {
    parts.push(
      "THE BUYER COMPANY'S STAFF COUNT. This IS `company_profile.headcount` for tier 1 and " +
      'tier 2. The client was asked for the range directly and typed two whole numbers:\n' +
      `  - lower bound: ${headcount.min}\n` +
      `  - upper bound: ${headcount.max}\n` +
      'Write it as that range. Never a different range, never a single figure, never a ' +
      'band you reason to from anything else in this message. This field takes no ' +
      'unresolved_fields entry for this client: it is established.',
    )
  }

  const titles = profile.buyer_job_titles.filter(t => t.trim().length > 0)
  if (titles.length > 0) {
    parts.push(
      'THE TITLES THE BUYER HOLDS. These ARE `buyer_profile.title` for tier 1 and tier 2, ' +
      "in the client's own words. Use them as written. Do not substitute a title you " +
      'consider equivalent, do not translate them into the vocabulary of another market, ' +
      'and do not add one the client did not list:\n' +
      bullets(titles),
    )
  }

  const bands = profile.buyer_seniority_bands.filter(b => b.trim().length > 0)
  if (bands.length > 0) {
    parts.push(
      'THE SENIORITY THE CLIENT SELECTED. This IS the level `buyer_profile.seniority` ' +
      'describes for tier 1 and tier 2. These are the tokens the client ticked from a fixed ' +
      'set, so write the prose of that field to describe exactly this level and no other. ' +
      'Do not raise it, do not lower it, and do not hedge it into a range that includes a ' +
      'level not listed here:\n' +
      bullets(bands),
    )
  }

  const disqualifiers = profile.disqualifiers.filter(d => d.trim().length > 0)
  if (disqualifiers.length > 0) {
    parts.push(
      'WHO THE CLIENT WOULD TURN AWAY DESPITE FITTING EVERYTHING ABOVE. Every one of these ' +
      'MUST appear in `tier_3.disqualifiers`, in the sense the client wrote it. The client ' +
      'was asked for these directly, so a disqualifier missing from tier 3 is an answer ' +
      'discarded rather than a judgement made. You may add further disqualifiers that the ' +
      'rest of this message supports. You may not drop, soften or merge one of these:\n' +
      bullets(disqualifiers),
    )
  }

  const firstContact = profile.first_contact_role.trim()
  if (firstContact) {
    parts.push(
      'WHO RECEIVES THE EMAIL. The client named this person directly, so `buyer_profile` ' +
      'for tier 1 and tier 2 describes THEM: their working day, how they see themselves, ' +
      'and where the problem lands on them. This is who the document is about, whoever else ' +
      'is involved in the purchase:\n' +
      `  - ${firstContact}`,
    )
  }

  if (profile.signoff_required === true) {
    const signoff = profile.signoff_role.trim()
    parts.push(
      'THE PERSON NAMED ABOVE CANNOT BUY ALONE. The client says sign-off is required' +
      (signoff ? `, from:\n  - ${signoff}\n` : '.\n') +
      'Treat that internal sell as a real condition of the purchase. It belongs in ' +
      '`four_forces.anxiety` and in `buyer_profile.day_to_day` for tier 1 and tier 2, ' +
      'because the recipient has to carry this to someone else and that shapes what they ' +
      'hesitate over. Whoever signs off is NOT the buyer this document describes.',
    )
  } else if (profile.signoff_required === false) {
    parts.push(
      'THE PERSON NAMED ABOVE CAN BUY ALONE. The client says no sign-off is required. Do ' +
      'not write an internal approval step into `four_forces.anxiety`, into ' +
      '`buyer_profile.day_to_day`, or into any tier 1 or tier 2 field. It is a hesitation ' +
      'this buyer does not have, and the client has said so.',
    )
  }

  if (parts.length === 0) return ''

  return (
    `\n\n---\n\n${BUYER_PROFILE_BLOCK_HEADING}\n\n` +
    'Everything in this section was typed by the client into a control built for it: a ' +
    'list where the answer is a list, two whole numbers where the answer is a range, a ' +
    'fixed set where the answer is a choice from one. There is nothing here to interpret ' +
    'and nothing to weigh against anything else.\n\n' +
    'So where an item below names a schema field, that item IS the value of that field. It ' +
    'is not an input to reasoning about the field, it is not one signal among several, and ' +
    'it does not lose to a research result, to the website, to an uploaded document, to a ' +
    'narrative intake answer, or to a previous version of this document. Where those ' +
    'disagree with an answer below, the answer below wins and the disagreement is worth a ' +
    'sentence in the field it affects.\n\n' +
    'A field NOT named below is not established by this section. Derive it exactly as the ' +
    'rules elsewhere in this prompt require, including adding an unresolved_fields entry ' +
    'where you cannot ground it.\n\n' +
    parts.join('\n\n')
  )
}
