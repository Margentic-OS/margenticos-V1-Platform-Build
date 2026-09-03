// src/lib/benchmarks/sample-gate.ts
//
// Decides whether a rate has enough behind it to be worth printing.
//
// DETERMINISTIC. Arithmetic and a threshold, no model, per ADR-018.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A GATE AT ALL
//
// Live right now: 1 reply from 26 emails. That renders as 3.8%, which sits neatly inside
// the published industry range and looks like a measurement. It is not one. The next
// reply takes it to 7.7%, and a single email arriving moves the number by four percentage
// points. Any decision made on it would be made on noise.
//
// A dash and "too early to report" is a smaller thing to show a client than a number that
// will be unrecognisable next week. It is also the honest answer, and it stops the
// dashboard from being wrong in a way that is hard to walk back.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE NUMBERS COME FROM
//
// The standard error of a measured proportion is sqrt(p(1-p)/n).
//
// SEND-DENOMINATED RATES (meeting booking, bounce, opt-out): the thresholds worth
// distinguishing sit about a percentage point apart, so a standard error under one point
// is the bar.
//   reply rate near 4%:            0.01 = sqrt(0.04 * 0.96 / n)  ->  n ~= 384
//   meeting rate near 1%, half a point:  0.005 = sqrt(0.01 * 0.99 / n)  ->  n ~= 396
// Both land in the same place, so one number covers them: 400 emails.
//
// PEOPLE-DENOMINATED RATES (reply, since 2026-09-03): same arithmetic, different unit.
// n is a count of PEOPLE, and the number is the same 400 because the algebra above does
// not care what the trial is, only how many independent ones there are.
//
// AND THAT IS THE REAL ARGUMENT FOR THE UNIT, not just comparability with published
// figures. sqrt(p(1-p)/n) assumes n INDEPENDENT trials. Four emails to one person are not
// four independent chances of a reply: they are one person deciding once, prompted up to
// four times. Counting them as four overstates the sample by roughly the sequence length,
// which is exactly the direction that makes a noisy number look settled. 400 people is a
// real 400 trials; 400 emails to 100 people is not.
//
// So this is a STRICTER gate in wall-clock terms, not a looser one. At a four-step
// sequence it is about four times as many emails before a reply rate prints. That is the
// cost of the number meaning what it says.
//
// POSITIVE REPLY SHARE: the denominator is replies, not emails, and the proportion sits
// near half, where the standard error is at its widest. A ten-point standard error, which
// is as tight as is reachable before a client has hundreds of replies:
//   0.10 = sqrt(0.5 * 0.5 / n)  ->  n = 25 replies.
//
// These are deliberately round. They are a judgement about when a number stops being
// noise, not a precision instrument, and pretending otherwise by writing 384 would be its
// own small dishonesty.

export const MIN_SENDS_FOR_RATE = 400

// Deliberately a separate constant with the same value rather than a reuse of the one
// above. They are the same number in different units, and the whole defect this file's
// reply-rate change addresses was a denominator whose unit nobody could see. A single
// MIN_SENDS_FOR_RATE used under a people-denominated rate would put "around 400 emails"
// in the card's own too-early line, under a rate measured in people.
//
// If one of them ever moves, the other must be considered separately, not dragged along.
export const MIN_PEOPLE_FOR_RATE = 400

export const MIN_REPLIES_FOR_POSITIVE_RATE = 25

export interface RateReading {
  // True only when the denominator clears the minimum. Callers must render a dash and
  // "too early to report" when this is false, never a value.
  reportable: boolean
  // The percentage, or null when it is not reportable. Null rather than a number the
  // caller might print anyway.
  value: number | null
  numerator: number
  denominator: number
  // How much more of the denominator is needed. Zero once reportable.
  shortfall: number
  minimum: number
}

export function readRate(numerator: number, denominator: number, minimum: number): RateReading {
  const reportable = denominator >= minimum && denominator > 0
  return {
    reportable,
    value: reportable ? (numerator / denominator) * 100 : null,
    numerator,
    denominator,
    shortfall: Math.max(0, minimum - denominator),
    minimum,
  }
}

export type RangePosition = 'below' | 'within' | 'above'

/**
 * Where a reportable rate sits relative to a published industry range.
 *
 * Deliberately positional and not evaluative. It says where the number is, not whether it
 * is good, because "good" would be a target, and a target is a promise. For a bounce rate
 * 'below' is excellent and for a reply rate it is not, and the client is better placed
 * than a colour to know which of their numbers they care about.
 */
export function positionInRange(value: number, range: { min: number; max: number }): RangePosition {
  if (value < range.min) return 'below'
  if (value > range.max) return 'above'
  return 'within'
}
