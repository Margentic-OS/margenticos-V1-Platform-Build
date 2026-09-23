// Which arm a prospect is in, and whether its follow-ups still match its Email 1.
//
// TWO SMALL FUNCTIONS, ONE FILE, because both are read by the research path AND by
// composition and both must give the same answer in both places. A second copy of either
// would drift silently: the research path would write follow-ups for one arm while
// composition recorded another, or would fingerprint one string while composition hashed a
// different one, and nothing would fail loudly. That is the parallel-arrays shape one
// level up, and the fix is the same in kind: one definition, imported twice.

import { createHash } from 'node:crypto'
import { stableHash } from './variant-assignment'

/** The two arms. 'generated' means written follow-ups were attempted for this prospect. */
export type FollowupArm = 'template' | 'generated'

/**
 * A distinct salt, so the arm is INDEPENDENT of the variant assignment.
 *
 * Both are derived from the prospect id through the same stableHash. Without a salt they
 * would be correlated: every prospect in a given variant would land in the same arm, and a
 * reply-rate difference between arms could not be told apart from a difference between
 * variants. Salting decorrelates them, which is the whole reason the comparison is worth
 * running.
 */
const ARM_SALT = ':followup-arm'

/**
 * What share of prospects are assigned the generated arm, as a percentage.
 *
 * ═══ 100 TODAY. THE SPLIT IS A CAPABILITY THAT IS NOT IN USE. ═══
 *
 * Every prospect whose Email 1 is personalised is assigned generated follow-ups, and falls
 * back to the approved template ones only when they fail their gates or the Email 1
 * fingerprint no longer matches. That is a decision about what to ship, not a property of
 * the mechanism.
 *
 * THE MECHANISM IS PARAMETERISED ANYWAY, AND THAT IS THE POINT. Setting this to 50 gives a
 * 50/50 split, deterministically and with no other change anywhere: the arm is already
 * recorded on every prospect in followup_arm, so a comparison later is this number and a
 * deploy, not a rebuild. Hardcoding `% 2` today would have thrown that away and made the
 * comparison a feature to build again from nothing.
 *
 * A CONSTANT RATHER THAN A DATABASE FLAG, deliberately. system_flags is boolean-shaped
 * (a job type is on or off) and a percentage does not fit it without widening a table that
 * every queue check reads. If runtime control is ever wanted, that is a deliberate change
 * with its own migration, not something to anticipate here: CLAUDE.md's rule is that
 * configurability nobody asked for is not built speculatively.
 *
 * Must be an integer from 0 to 100. 100 assigns every prospect, 0 assigns none.
 */
export const GENERATED_ARM_PERCENT = 100

/**
 * The arm this prospect is ASSIGNED, deterministically.
 *
 * Same prospect id and same percentage always yield the same arm, with no database read
 * and no randomness, so the research path and composition agree without coordinating
 * (ADR-018).
 *
 * THIS IS THE ASSIGNMENT, NOT WHAT THE PROSPECT RECEIVES. A prospect assigned 'generated'
 * whose follow-ups are rejected by a gate, or whose Email 1 changed underneath them, still
 * receives the approved template follow-ups. Both facts are recorded, in followup_arm and
 * followup_mode, because counting only the outcome would move exactly the prospects whose
 * research produced unusable copy into the template group and make that group look worse
 * for a reason that has nothing to do with follow-ups.
 *
 * SPREAD OVER 100 BUCKETS RATHER THAN 2, so the percentage is honoured at any value and
 * membership is monotonic: a prospect assigned 'generated' at 50 is still 'generated' at
 * 100. Lowering the percentage therefore only ever removes prospects from the generated
 * arm, and never reshuffles the two, which is what makes a change mid-campaign readable.
 */
export function assignFollowupArm(
  prospectId: string,
  generatedPercent: number = GENERATED_ARM_PERCENT,
): FollowupArm {
  if (generatedPercent >= 100) return 'generated'
  if (generatedPercent <= 0) return 'template'
  return Math.abs(stableHash(prospectId + ARM_SALT)) % 100 < generatedPercent
    ? 'generated'
    : 'template'
}

/**
 * The fingerprint of the Email 1 a set of follow-ups was written against.
 *
 * ═══ TAKEN OVER THE COMPOSED BODY, AND THAT IS THE WHOLE DESIGN ═══
 *
 * Not over personalisation_trigger. The body is the artifact the prospect receives, and
 * hashing it folds every input that can change it into one value: the written observation,
 * the written question, the written subject, the variant frame, and the version of the
 * messaging document those came from. If any one of them moves, this moves.
 *
 * WHY THAT MATTERS RIGHT NOW. Another session re-runs Email 1 for these same prospects to
 * fix copy faults, and the messaging document moved twice on 2026-09-21. A follow-up opens
 * with a callback to a specific observation; under a DIFFERENT Email 1 that callback points
 * at something the prospect never read. Nothing would error, the word counts would be
 * right, and the only person who notices is the recipient.
 *
 * The check belongs at COMPOSITION, not at generation, because a check at generation time
 * cannot see a change made afterwards, which is the entire hazard. And it needs no
 * coordination between sessions: the other session's write changes the trigger, the hash
 * stops matching, and the follow-ups retire themselves.
 *
 * Normalised on trailing whitespace only. Anything more aggressive would let a real
 * difference in the shipped copy hash the same, which is the failure this exists to stop.
 */
export function fingerprintEmail1(body: string): string {
  return createHash('sha256').update(body.trimEnd(), 'utf8').digest('hex')
}

/**
 * Whether stored follow-ups may ship with this Email 1.
 *
 * FAILS CLOSED, in every direction. A missing fingerprint, a missing body, or any mismatch
 * all return false, and false means the client's approved template follow-ups ship, which
 * is the current behaviour and always safe. There is no branch here that returns true on
 * incomplete information.
 */
export function followupsMatchEmail1(
  storedFingerprint: string | null | undefined,
  composedEmail1Body: string | null | undefined,
): boolean {
  if (!storedFingerprint || !composedEmail1Body) return false
  return storedFingerprint === fingerprintEmail1(composedEmail1Body)
}
