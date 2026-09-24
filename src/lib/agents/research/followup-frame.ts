// The frame of a follow-up email: greeting, middle, sign-off.
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS DETERMINISTIC CODE RATHER THAN A PROMPT
// INSTRUCTION.
//
// The writer is being asked to learn the JOB and the REGISTER of emails 2 and 3 from the
// client's own approved copy, which is the only reference material in the system that is
// guaranteed to be about the right buyer in the right industry. Measured on the active
// document of the one live organisation on 2026-09-21: EIGHT of the EIGHT template emails
// at positions 2 and 3 open with a population opener, the one move this feature forbids.
// Four of them open by naming a population outright, the other four by stating a cost or a
// pattern in the abstract with no second person in the sentence at all.
//
// This writer imitates. The prompt already records seven separate occasions on which one
// of its own worked examples came back almost word for word, and the position most likely
// to be copied is the first sentence, because it is the one the reference and the task
// have in common. So passing the template whole would hand it eight worked examples of the
// banned move, labelled as the standard to hit.
//
// THE STRIP IS THEREFORE STRUCTURAL, NOT ADVISORY. An instruction not to copy the opener
// is exactly the kind of rule this file's neighbours record as not converging. Removing
// the paragraph removes the thing that can be copied, and what remains is precisely what
// the reference is FOR: how the service is described, the sentence length, the register,
// the shape of the ask.
//
// It also keeps Rule Zero intact in the direction that actually bites. The reference is
// client data read at runtime, never a hardcoded example, so nothing industry-specific
// enters the repository. But an UNSTRIPPED reference would put one client's population
// noun in front of the writer as a model of how to open, for whatever client is running,
// and a copied opener would carry that noun into another client's email. The strip is what
// stops a runtime read becoming a hardcoded assumption by way of imitation.

/**
 * What the follow-up writer is shown, and what the gates measure against afterwards.
 *
 * THESE TYPES LIVE HERE AND NOT IN write-opening.ts, ON PURPOSE. write-opening.ts is the
 * Email 1 writer and it is BYTE-IDENTICAL TO MAIN in this branch, which is what makes the
 * positive control a `diff` returning nothing rather than an argument about which changes
 * were safe. Putting a type there, even an unused one, would end that.
 *
 * THE REFERENCE IS ALREADY STRIPPED when it arrives: buildFollowupReference removes the
 * template's opening paragraph, because that paragraph is a population opener in every
 * case measured and it is the most copyable position in the reference.
 *
 * `templateBody2` and `templateBody3` are the UNSTRIPPED bodies, for a different job:
 * composing written prose back into a real frame so the gates can count the words of a
 * complete email rather than of a fragment. They are never shown to the writer.
 */
export interface FollowupReference {
  /** Template Email 2 with its opener and closing question removed. Shown to the writer. */
  reference2: string
  /** Template Email 3 with its opener and closing question removed. Shown to the writer. */
  reference3: string
  /**
   * The position whose own reference stripped to nothing and is borrowing the other's, or
   * null when both have their own.
   *
   * CARRIED RATHER THAN HIDDEN, because the writer is shown the reference under a heading
   * that names a position. Substituting one for the other without saying so would put a
   * label on the block that is not true, and this writer reads its headings: the whole
   * reason the opener is stripped is that it copies what it is shown. The prompt states the
   * substitution, so the writer knows it is reading the register of a DIFFERENT email.
   */
  borrowedPosition: 2 | 3 | null
  /** Template Email 2's full body. The frame for word counting. Never shown. */
  templateBody2: string
  /** Template Email 3's full body. The frame for word counting. Never shown. */
  templateBody3: string
  /** The prospect's company name, which counts as addressing them in the callback gate. */
  companyName?: string | null
}

/**
 * A written follow-up that survived its gates, or the reason it did not.
 *
 * BOTH HALVES ARE KEPT. An empty result has two causes that mean different things, and a
 * reader of the empty string alone cannot tell "the writer returned nothing" from "it
 * returned something the gate threw away". On this feature that distinction is the
 * measurement.
 */
export interface FollowupOutcome {
  /** The middle prose that would ship, or null when the template follow-up ships instead. */
  prose: string | null
  /** The complete composed body, greeting and sign-off included. Null whenever prose is. */
  body: string | null
  /** The prose the gates rejected, else null. */
  discarded: string | null
  /** Why it was rejected. Empty when nothing was. */
  failures: string[]
}

/**
 * Nothing written and nothing rejected.
 *
 * THE VALUE THE COHERENCE RULE RETURNS. Every path on which the approved template Email 1
 * ships resolves to this, so a consumer reading `.prose` with no condition of its own
 * still gets null.
 */
export const EMPTY_FOLLOWUP: FollowupOutcome = {
  prose: null, body: null, discarded: null, failures: [],
}

/**
 * The paragraphs that always sit at the END of a follow-up email body. One: the sign-off
 * block, which is two lines (sender first name, sender company name) in a single
 * paragraph, with nothing after it.
 *
 * NAMED AND COUNTED FROM THE END, for the same reason EMAIL1_FRAME_TAIL_PARAGRAPHS is in
 * compose-sequence: what varies is the middle, and an index counted from the front moves
 * whenever the middle grows. Counting from the end is why that file's question replacer
 * survived the Email 1 slot growing from one paragraph to two while every fixed-index read
 * broke.
 */
export const FOLLOWUP_TAIL_PARAGRAPHS = 1

/** The greeting paragraph, which is the merge tag and nothing else. */
const GREETING_RE = /^\{\{first_name\}\},?\s*$/

/**
 * The most lines a sign-off paragraph may hold. Two, per the mandatory sign-off: sender
 * first name, then sender company name.
 *
 * CHECKED RATHER THAN ASSUMED, because this is what tells a real frame from a body that
 * merely has three paragraphs. A trailing paragraph of four lines is prose, not a
 * sign-off, and treating it as one would hand the caller a "middle" with the last
 * paragraph of real copy missing from it and no error to say so.
 */
const SIGNOFF_MAX_LINES = 2

export interface FollowupFrame {
  /** The greeting paragraph verbatim, or null when the body opens straight into prose. */
  greeting: string | null
  /** Every paragraph between the greeting and the sign-off, in order. Never empty. */
  middle: string[]
  /** The sign-off paragraph verbatim: first name and company name, one per line. */
  signOff: string
}

/**
 * Split a follow-up email body into its three parts.
 *
 * RETURNS NULL RATHER THAN A PLAUSIBLE WRONG ANSWER when the body does not have a
 * recognisable frame, which is the same contract findSlotParagraphs uses in
 * compose-sequence and for the same reason: every caller then decides for itself what to
 * do. Here both callers decline the feature for that variant and fall back to the template
 * follow-up, which is the outcome the whole design already treats as correct.
 *
 * A body with no middle at all is not a frame. Two paragraphs of greeting and sign-off
 * carry no copy, so there is nothing to reference and nothing to replace.
 */
export function splitFollowupFrame(body: string): FollowupFrame | null {
  const paras = body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)

  const greeting = GREETING_RE.test(paras[0] ?? '') ? paras[0] : null
  const start = greeting === null ? 0 : 1
  const end = paras.length - FOLLOWUP_TAIL_PARAGRAPHS

  // At least one middle paragraph has to survive between the two ends.
  if (end - start < 1) return null

  const signOff = paras[end]
  if (signOff === undefined) return null
  if (signOff.split('\n').length > SIGNOFF_MAX_LINES) return null

  return { greeting, middle: paras.slice(start, end), signOff }
}

/**
 * The tone-and-length reference for one template follow-up: its middle paragraphs with
 * the FIRST one removed, and the CLOSING QUESTION removed from the end.
 *
 * The first middle paragraph is the opener, and the opener is the one part of this
 * reference that must not transfer. See the header of this file for the measurement.
 *
 * THE CLOSING QUESTION IS STRIPPED FOR THE SAME REASON, ADDED 2026-09-24. It is the last
 * middle paragraph, and it is the second most copyable position in the reference after the
 * opener, because it is the other part the reference and the task have in common. Measured
 * on Email 1 the same day: shown the variant's approved question and told plainly that it
 * was there for register and length only, the writer handed it back, and eight of nine
 * shipped questions ended in the same four words. Email 1's question was removed from
 * everything its writer sees; this is the follow-up half of that change. The register and
 * the length are STATED in the system prompt, which is what the sample was said to be for.
 *
 * WHAT IS LEFT IS STILL THE THING THE REFERENCE IS FOR: how the service is described, the
 * sentence length, the register. Only the two positions that get copied verbatim are gone.
 *
 * Returns the empty string when nothing survives the strip, which now happens whenever the
 * template follow-up is an opener and a question and nothing else. Callers treat an empty
 * reference as "no reference available" and decline. That is the correct outcome and not a
 * regression to work around: a reference whose entire surviving content is the approved
 * question is exactly what this strip exists to prevent reaching the writer.
 */
export function buildFollowupReference(body: string): string {
  const frame = splitFollowupFrame(body)
  if (frame === null) return ''
  const withoutOpener = frame.middle.slice(1)
  const last = withoutOpener[withoutOpener.length - 1]
  const kept = last !== undefined && last.trimEnd().endsWith('?')
    ? withoutOpener.slice(0, -1)
    : withoutOpener
  return kept.join('\n\n')
}

/**
 * Put written middle prose back into a template's frame, so the result is a complete,
 * genuinely sendable body.
 *
 * THE GREETING AND THE SIGN-OFF ARE NEVER WRITTEN BY THE MODEL, and that is deliberate
 * rather than incidental. The sign-off is two mandatory lines read per client from the
 * organisation record; an email ending with only the first name fails validation, and the
 * company name is required rather than optional precisely because optionality means it
 * does not get populated. Handing those two lines to a model that has already been
 * measured lifting its own reference material would put a house rule inside the thing the
 * house rule polices.
 *
 * So this is the same division of labour Email 1 already uses: the model writes the slot,
 * the frame is composed around it. The opt-out footer is likewise NOT appended here, for
 * the same reason it is not appended at generation time anywhere else: it is applied once
 * at composition, after word counts, so it never consumes an email's word budget.
 */
export function composeFollowupBody(templateBody: string, middleProse: string): string | null {
  const frame = splitFollowupFrame(templateBody)
  if (frame === null) return null

  const written = middleProse
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
  if (written.length === 0) return null

  return [frame.greeting, ...written, frame.signOff]
    .filter((p): p is string => p !== null)
    .join('\n\n')
}
