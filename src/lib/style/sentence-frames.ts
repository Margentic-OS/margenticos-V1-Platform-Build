// Cross-batch sentence-frame repetition detection.
//
// WHY THIS EXISTS
// Across three prospects the research synthesist produced "is a particular kind of
// balancing act" and "is a particular kind of juggle". A reused sentence frame inside the
// supposedly bespoke layer is the exact fingerprint the personalisation exists to avoid.
// At 500 prospects a repeated frame is a uniformity signal a recipient can spot by
// forwarding two emails to each other.
//
// Per-observation checks cannot see this: each sentence is individually fine. Repetition
// only exists ACROSS a batch, so detection has to hold state for the batch.
//
// HOW IT DETECTS
// Each text is reduced to a "frame skeleton": proper nouns, numbers and dates are masked
// out, leaving the structural words. Overlapping n-grams of that skeleton are the frames.
// Two texts collide when they share a frame. Masking is what makes this work: "Running
// Taffet alongside the CRC engagement" and "Running Full Bloom alongside the Stanford GSB
// role" differ in every content word but share the skeleton "running # alongside the #".
//
// Deterministic by design (ADR-018). Tokenising and hashing is counting, not judgement.
//
// COST AT 500 PROSPECTS
// One pass per text, no API calls, no LLM, no I/O. A 40-word trigger produces roughly 37
// five-gram keys, so 500 prospects is about 18,500 short strings in one Map: single-digit
// milliseconds of CPU and a couple of megabytes of memory for the whole batch. Cost is
// linear in total words and is irrelevant next to the four network sources and the Sonnet
// call each prospect already makes.

// Frame length in skeleton tokens. Four is too short (ordinary English collides:
// "with that role now"). Six rarely fires. Five catches "is a particular kind of" and
// "alongside the # role since" without flagging incidental grammar.
export const FRAME_LENGTH = 5

// Masked tokens: anything carrying prospect-specific content. Removing these is the point,
// because two frames are the same frame precisely when only the names differ.
const MASK = '#'

// Very common openers that legitimately repeat and carry no authorial fingerprint. Kept
// short on purpose: over-excluding hides the repetition the check exists to surface.
const IGNORED_FRAMES = new Set<string>([
  `${MASK} ${MASK} ${MASK} ${MASK} ${MASK}`,
])

export interface FrameCollision {
  /** The repeated skeleton, e.g. "is a particular kind of". */
  frame: string
  /** Identifier of the text this frame was first seen in. */
  firstSeenId: string
  /** Identifier of the text that repeated it. */
  repeatedById: string
  /** The offending sentence from the repeating text, verbatim. */
  repeatedText: string
}

// Reduces text to its structural skeleton. Masks numbers, dates, and capitalised words
// that are not sentence-initial (a serviceable proper-noun test for this copy, which is
// ordinary prose rather than headline case).
export function frameSkeleton(text: string): string[] {
  const words = (text ?? '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  return words.map((word, index) => {
    if (/\d/.test(word)) return MASK
    // First word of the text is capitalised by convention, so capitalisation says nothing
    // about it. Every later capital is treated as a name.
    if (index > 0 && /^\p{Lu}/u.test(word)) return MASK
    return word.toLowerCase()
  })
}

/** Overlapping n-grams of the skeleton. Empty when the text is shorter than FRAME_LENGTH. */
export function frameShingles(text: string, length: number = FRAME_LENGTH): string[] {
  const skeleton = frameSkeleton(text)
  const shingles: string[] = []

  for (let i = 0; i + length <= skeleton.length; i++) {
    const frame = skeleton.slice(i, i + length).join(' ')
    if (IGNORED_FRAMES.has(frame)) continue
    // A frame that is all mask carries no structure worth comparing.
    if (frame.split(' ').every(t => t === MASK)) continue
    shingles.push(frame)
  }

  return shingles
}

// Holds one batch's frames. Single-threaded JS means the p-limit concurrency in the batch
// orchestrator cannot interleave a register() call, so no locking is needed.
export class FrameRegistry {
  private readonly seen = new Map<string, string>()   // frame → id that first used it
  private readonly collisions: FrameCollision[] = []

  /**
   * Records a text and returns every frame it repeats from an earlier text.
   * Frames within a single text never collide with themselves.
   */
  register(id: string, text: string): FrameCollision[] {
    const found: FrameCollision[] = []
    const shingles = frameShingles(text)
    const newThisText = new Set<string>()

    for (const frame of shingles) {
      const firstSeenId = this.seen.get(frame)
      if (firstSeenId !== undefined && firstSeenId !== id) {
        const collision: FrameCollision = {
          frame,
          firstSeenId,
          repeatedById: id,
          repeatedText: text,
        }
        found.push(collision)
        this.collisions.push(collision)
      } else if (firstSeenId === undefined) {
        newThisText.add(frame)
      }
    }

    for (const frame of newThisText) this.seen.set(frame, id)

    return found
  }

  /** Every collision recorded so far, in detection order. */
  allCollisions(): FrameCollision[] {
    return [...this.collisions]
  }

  get size(): number {
    return this.seen.size
  }
}
