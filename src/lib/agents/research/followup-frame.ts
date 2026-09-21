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
 * the FIRST one removed.
 *
 * The first middle paragraph is the opener, and the opener is the one part of this
 * reference that must not transfer. See the header of this file for the measurement.
 *
 * Returns the empty string when nothing survives the strip, which happens whenever the
 * template follow-up is a single paragraph. Callers treat an empty reference as "no
 * reference available" and decline, rather than passing a blank heading to the writer.
 */
export function buildFollowupReference(body: string): string {
  const frame = splitFollowupFrame(body)
  if (frame === null) return ''
  return frame.middle.slice(1).join('\n\n')
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
