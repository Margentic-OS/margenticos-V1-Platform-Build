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
// Vantor alongside the ORRIN engagement" and "Running Northwell alongside the Merrow Institute
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
/**
 * THE ONE MASKING RULE, used by everything that needs to ignore prospect-specific content.
 *
 * `index` is the word's position in its own text: the first word is capitalised by
 * convention, so capitalisation says nothing about it. Every later capital is treated as a
 * name, which is a serviceable proper-noun test for ordinary prose.
 *
 * EXPORTED so a second caller cannot end up with a second copy of the rule. frameSkeleton
 * renders a masked token as "#" because it is building shingles; stripProperNouns removes
 * the word entirely because it is building text to measure. Same rule, two renderings.
 */
export function isMaskedWord(word: string, index: number): boolean {
  if (/\d/.test(word)) return true
  return index > 0 && /^\p{Lu}/u.test(word)
}

export function frameSkeleton(text: string): string[] {
  const words = (text ?? '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  return words.map((word, index) => (isMaskedWord(word, index) ? MASK : word.toLowerCase()))
}

/**
 * The text with proper nouns, numbers and quoted titles REMOVED, sentence punctuation kept.
 *
 * ═══ WHY THIS EXISTS, AND IT IS ONLY FOR MEASURING READING GRADE ═══
 *
 * A reason written for one prospect has to name their firm and their role, and a reading
 * grade formula counts syllables per word. Those names are long, and they cannot be
 * simplified: the whole point of them is that they are that company's name and not another.
 * So the formula charges a specific sentence for being specific, which is the opposite of
 * what the ceiling is there to encourage.
 *
 * Measured on the first three prospects a run reached: reasons scored 6.9, 9.9 and 10.9
 * against a ceiling of 6, and every one was dropped, so every email fell back to the
 * trigger's generic reason and line two became identical for everyone matching that
 * trigger. That defeats the purpose of having a per-prospect reason at all.
 *
 * SENTENCE PUNCTUATION IS KEPT because the grade formula divides by sentence count. Joining
 * two sentences into one would inflate words-per-sentence and undo the correction.
 */
export function stripProperNouns(text: string): string {
  // Quoted titles first: a title in quotes is a name however it is capitalised.
  const unquoted = (text ?? '').replace(/["\u201c\u201d'\u2018\u2019][^"\u201c\u201d'\u2018\u2019]{2,}["\u201c\u201d'\u2018\u2019]/g, ' ')
  const tokens = unquoted.split(/\s+/).filter(Boolean)
  const bare = (t: string | undefined) => (t ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  let wordIndex = -1
  const kept = tokens.map((token, tokenIndex) => {
    // The word without surrounding punctuation, for the test; the punctuation itself is
    // kept so sentence boundaries survive.
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (!word) return token
    wordIndex += 1
    // THE FIRST WORD, WHICH isMaskedWord DELIBERATELY EXEMPTS. That exemption is right for
    // shingling, where every sentence starts capitalised and the opener carries no name
    // information. It is wrong here: a reason that begins with the prospect's firm was left
    // holding half a name ("Everdene Lane" kept "Everdene"), and half a name is still an
    // unsimplifiable polysyllable charged against the grade.
    //
    // A capitalised first word FOLLOWED BY another capitalised word is part of a multi-word
    // name. A capitalised first word alone is an ordinary sentence opener and is kept,
    // which is why "More staff means..." and "Steady income just stopped." score unchanged.
    const firstWordOfAName = wordIndex === 0
      && /^\p{Lu}/u.test(word)
      && /^\p{Lu}/u.test(bare(tokens[tokenIndex + 1]))
    if (!isMaskedWord(word, wordIndex) && !firstWordOfAName) return token
    const trailing = token.match(/[.!?;:]+$/)
    return trailing ? trailing[0] : ''
  })
  return kept.filter(Boolean).join(' ').replace(/\s+([.!?;:])/g, '$1').trim()
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

// ─── Full-sentence reuse across variants ─────────────────────────────────────
//
// A DIFFERENT QUESTION FROM THE SHINGLES ABOVE, answered with the same normaliser.
//
// frameShingles asks "do two texts share a sentence SHAPE with different nouns swapped
// in", which is the research-agent failure ("is a particular kind of balancing act" vs
// "...juggle"). Cross-variant reuse asks "is this the same sentence, verbatim", which is
// the messaging failure: variants A, B and C all ended Email 1 with "You take the calls
// and close them."
//
// Shingles are the wrong granularity for that second question. A 5-gram fires on a shared
// fragment inside two otherwise-different sentences, and phrases like "most consultants at
// your stage" are legitimate shared vocabulary that all four variants may reasonably use.
// So the comparison happens at whole-sentence granularity, while REUSING frameSkeleton as
// the normaliser rather than introducing a second one. That reuse is worth having on its
// own: the skeleton masks proper nouns and numbers, so "We book meetings for Acme" and
// "We book meetings for Beta" normalise to the same key and are correctly caught as the
// same sentence with a name swapped.

// Sentences shorter than this are exempt. "It doesn't." and "Fair enough." will collide
// across variants no matter how different the copy is, and failing on them would make
// generation impossible without improving anything. Four words is low enough to still
// catch a real fingerprint like "Last one from me."
export const MIN_SHARED_SENTENCE_WORDS = 4

/** Normalised comparison key for one sentence. Empty string when nothing comparable remains. */
export function sentenceKey(sentence: string): string {
  return frameSkeleton(sentence).join(' ')
}

/**
 * Splits a body into comparable sentences.
 *
 * Drops the {{first_name}} greeting and any line exactly equal to one of excludeLines,
 * which is how the mandatory two-line sign-off is kept out: it is identical in all
 * sixteen emails by design, so counting it as reuse would flag every variant against
 * every other and drown the real signal.
 */
export function comparableSentences(
  body: string,
  excludeLines: string[] = [],
): string[] {
  const excluded = new Set(excludeLines.map(l => l.trim().toLowerCase()).filter(Boolean))

  return body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !/^\{\{first_name\}\},?\s*$/.test(p))
    // Split paragraphs into lines first so the sign-off block's two lines can be dropped
    // individually. The sign-off carries no sentence-ending punctuation, so a
    // punctuation-only split would keep it as one chunk.
    .flatMap(p => p.split('\n'))
    .map(l => l.trim())
    .filter(l => l.length > 0 && !excluded.has(l.toLowerCase()))
    .flatMap(l => l.split(/(?<=[.!?])\s+/))
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).filter(Boolean).length >= MIN_SHARED_SENTENCE_WORDS)
}

export interface SentenceReuse {
  /** The sentence as written in the offending text. */
  sentence: string
  /** Identifier of the text that used it first. */
  firstSeenId: string
}

// Tracks whole sentences across the variants of one document. Same shape as FrameRegistry
// deliberately: register-and-report, first writer wins, later reuse is the violation.
export class SentenceRegistry {
  private readonly seen = new Map<string, string>()   // sentence key → id that used it first

  /** Sentences in `body` that an EARLIER id already used. Does not record them. */
  findReuse(id: string, body: string, excludeLines: string[] = []): SentenceReuse[] {
    const found: SentenceReuse[] = []
    for (const sentence of comparableSentences(body, excludeLines)) {
      const key = sentenceKey(sentence)
      if (!key) continue
      const firstSeenId = this.seen.get(key)
      if (firstSeenId !== undefined && firstSeenId !== id) {
        found.push({ sentence, firstSeenId })
      }
    }
    return found
  }

  /** Records every sentence in `body` against `id`, keeping the first writer. */
  register(id: string, body: string, excludeLines: string[] = []): void {
    for (const sentence of comparableSentences(body, excludeLines)) {
      const key = sentenceKey(sentence)
      if (!key) continue
      if (!this.seen.has(key)) this.seen.set(key, id)
    }
  }

  get size(): number {
    return this.seen.size
  }
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
