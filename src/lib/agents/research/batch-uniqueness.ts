// Batch-scoped repetition tracking for the two parts of a written opening that collapse
// first: the BRIDGE and the CLOSING QUESTION.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS REPORTS. IT DOES NOT BLOCK. Changed 2026-09-23, and the reason matters more than the
// change, because the original reasoning was right and the world moved underneath it.
//
// It was built as a gate after a batch of twelve came back with eleven bridges on one
// skeleton. That was a batch where the bridges were interchangeable because the
// OBSERVATIONS were interchangeable: with nothing specific to attach to, every bridge
// drifted to the same general statement, and blocking forced the variety the prompt could
// not.
//
// The 2026-09-23 run inverted it. With a client trigger list the research now matches on,
// several prospects legitimately share a trigger, so their bridges legitimately converge:
// two prospects who both just posted a delivery role genuinely have the same thing said
// about them. Measured on that run: TWO prospects each lost their email on EVERY attempt
// to a bridge frame another prospect had reserved first, and both were logged
// `strong_material: true`. Two of the four prospects that fell back to the template did so
// for this reason alone.
//
// So the gate now fails in the direction the research got BETTER. A collision used to mean
// "the writer had nothing to say"; it now often means "two prospects are in the same
// situation". That is not a defect worth throwing away a researched email for, and the cost
// of blocking is paid by the prospect with the best material, because whoever writes second
// loses.
//
// WHAT REPLACES IT. Collisions are counted and quoted, and a per-batch tally flags any
// single phrase used by more than OVERUSE_FRACTION of the batch. Eleven of twelve bridges
// on one skeleton would still be caught and named loudly; two of twenty sharing a shape
// would not, because it is not a problem.
//
// The writer is still TOLD which questions are taken, via takenQuestions, before it writes.
// That is a prompt input, not a gate: it reduces collisions at no cost and fails nothing.
//
// RESERVE, THEN RELEASE, STILL. An attempt records its frames synchronously and releases
// them if the attempt stops being a candidate, so the end-of-batch tally counts what
// SHIPPED rather than everything that was ever drafted.
// ═════════════════════════════════════════════════════════════════════════════

import { frameShingles, sentenceKey } from '@/lib/style/sentence-frames'

export interface UniquenessCollision {
  kind: 'bridge' | 'question'
  /** The repeated skeleton, or the normalised question key. */
  key: string
  /** The id that reserved it first. */
  firstSeenId: string
}

export class BatchUniquenessRegistry {
  private readonly bridgeFrames = new Map<string, string>()   // frame  → owner id
  private readonly questions    = new Map<string, string>()   // key    → owner id
  private readonly owned        = new Map<string, { frames: string[]; questions: string[] }>()
  // key → the question as written. Kept so retry feedback can LIST what is already taken
  // rather than saying "that one is taken" and leaving the writer to guess. Kit burned all
  // three attempts re-offering questions that were already gone.
  private readonly questionText = new Map<string, string>()

  /**
   * Records this id's frames and question, and REPORTS every collision it found.
   *
   * RECORDS EVEN WHEN IT COLLIDES, which is the block-to-report change. The old version
   * recorded nothing on a collision because the attempt was about to be rejected; now the
   * attempt proceeds, so the frames it is actually using must be on the books or the
   * end-of-batch tally cannot count them and would report a phrase used five times as used
   * once.
   *
   * A frame already owned by someone else keeps its FIRST owner, so firstSeenId stays
   * meaningful, while `owned` records that this id uses it too. Ownership answers "who had
   * it first"; usage answers "how many of the batch said this", and only the second is what
   * the tally needs.
   *
   * Re-reserving for an id that already holds a reservation releases the old one first,
   * which is what makes a retry safe: the prospect's own previous attempt must not count
   * as a collision against itself.
   */
  reserve(id: string, bridge: string, question: string): UniquenessCollision[] {
    this.release(id)

    const frames = frameShingles(bridge)
    const qKey = sentenceKey(question)
    const collisions: UniquenessCollision[] = []

    for (const frame of frames) {
      const firstSeenId = this.bridgeFrames.get(frame)
      if (firstSeenId !== undefined && firstSeenId !== id) {
        collisions.push({ kind: 'bridge', key: frame, firstSeenId })
      }
    }

    if (qKey) {
      const firstSeenId = this.questions.get(qKey)
      if (firstSeenId !== undefined && firstSeenId !== id) {
        collisions.push({ kind: 'question', key: qKey, firstSeenId })
      }
    }

    const uniqueFrames = [...new Set(frames)]
    // FIRST OWNER WINS the ownership map, so a collision keeps naming whoever had it first.
    for (const frame of uniqueFrames) if (!this.bridgeFrames.has(frame)) this.bridgeFrames.set(frame, id)
    if (qKey && !this.questions.has(qKey)) {
      this.questions.set(qKey, id)
      this.questionText.set(qKey, question.trim())
    }
    this.owned.set(id, { frames: uniqueFrames, questions: qKey ? [qKey] : [] })

    return collisions
  }

  /**
   * Drops everything `id` holds. Safe to call when it holds nothing.
   *
   * The ownership entry is removed only when `id` is the one holding it. Since a frame can
   * now be used by several ids, another id may still be using a frame this one owned, and
   * deleting it unconditionally would make the next user of that frame look like the first.
   */
  release(id: string): void {
    const held = this.owned.get(id)
    if (!held) return
    this.owned.delete(id)

    // OWNERSHIP TRANSFERS, it does not just vanish. A frame this id owned may still be in
    // use by another prospect, and leaving the map pointing at a released id would make
    // firstSeenId name someone who is no longer in the batch. Deleting it instead would
    // make the remaining user look like the first to say it. Neither is true, so the
    // reservation moves to whoever is still using it.
    const nextUser = (phrase: string): string | undefined => {
      for (const [otherId, held2] of this.owned) {
        if (held2.frames.includes(phrase) || held2.questions.includes(phrase)) return otherId
      }
      return undefined
    }

    for (const frame of held.frames) {
      if (this.bridgeFrames.get(frame) !== id) continue
      const next = nextUser(frame)
      if (next === undefined) this.bridgeFrames.delete(frame)
      else this.bridgeFrames.set(frame, next)
    }
    for (const key of held.questions) {
      if (this.questions.get(key) !== id) continue
      const next = nextUser(key)
      if (next === undefined) {
        this.questions.delete(key)
        this.questionText.delete(key)
      } else {
        this.questions.set(key, next)
      }
    }
  }

  /**
   * Every closing question currently reserved by someone OTHER than `id`, as written.
   *
   * For retry feedback. A writer told only that its question is taken has to guess its way
   * around an invisible set, and guessing cost a prospect three attempts and a fallback.
   * Excluding `id` matters because a retrying prospect must not be shown its own reserved
   * question as an obstacle.
   */
  takenQuestions(excludeId?: string): string[] {
    const taken: string[] = []
    for (const [key, owner] of this.questions) {
      if (owner === excludeId) continue
      const text = this.questionText.get(key)
      if (text) taken.push(text)
    }
    return taken
  }

  /** True when `id` currently holds a reservation. Used by tests and diagnostics. */
  holds(id: string): boolean {
    return this.owned.has(id)
  }

  /** Every collision reported so far this batch, for the summary. */
  private readonly reported: UniquenessCollision[] = []

  recordReported(collisions: readonly UniquenessCollision[]): void {
    this.reported.push(...collisions)
  }

  get reportedCollisions(): readonly UniquenessCollision[] {
    return this.reported
  }

  get bridgeFrameCount(): number {
    return this.bridgeFrames.size
  }

  get questionCount(): number {
    return this.questions.size
  }
}

/**
 * A phrase used by more than this share of a batch is flagged.
 *
 * Ten per cent is chosen so the failure this class was built for is still caught loudly
 * (eleven of twelve bridges on one skeleton is 92%) while the ordinary convergence the
 * 2026-09-23 run produced is not. The comparison is STRICTLY GREATER THAN, so a phrase used
 * by exactly a tenth of the batch does not flag: a threshold that fires at its own value
 * turns every round batch size into a false positive.
 */
export const OVERUSE_FRACTION = 0.10

export interface OverusedPhrase {
  kind: 'bridge' | 'question'
  phrase: string
  /** How many prospects in the batch used it. */
  used: number
  share: number
  /** Up to three prospect ids, so the summary can be read without another query. */
  prospect_ids: string[]
}

/**
 * Phrases more than OVERUSE_FRACTION of the batch used, worst first.
 *
 * COMPUTED FROM WHAT SHIPPED, not from the registry, and that is the same discipline the
 * collision recount beside it already follows: a tally that reads the registry that recorded
 * the phrases cannot catch a bug in the recording. A draft that was written and then lost to
 * the template never reached a prospect and is not counted.
 *
 * The denominator is the batch SIZE, not the number that shipped, because a batch where half
 * fell back to the template must not make the surviving half look more uniform than it is.
 */
export function overusedPhrases(
  shipped: ReadonlyArray<{ prospect_id: string; bridge: string; question: string }>,
  batchSize: number,
): OverusedPhrase[] {
  if (batchSize <= 0) return []
  const seen = new Map<string, { kind: 'bridge' | 'question'; ids: Set<string> }>()

  const add = (kind: 'bridge' | 'question', phrase: string, id: string) => {
    const e = seen.get(phrase) ?? { kind, ids: new Set<string>() }
    e.ids.add(id)
    seen.set(phrase, e)
  }

  for (const s of shipped) {
    for (const frame of new Set(frameShingles(s.bridge))) add('bridge', frame, s.prospect_id)
    const qKey = sentenceKey(s.question)
    if (qKey) add('question', qKey, s.prospect_id)
  }

  return [...seen.entries()]
    .map(([phrase, { kind, ids }]) => ({
      kind, phrase, used: ids.size, share: ids.size / batchSize, prospect_ids: [...ids].slice(0, 3),
    }))
    .filter(r => r.used > 1 && r.share > OVERUSE_FRACTION)
    .sort((a, b) => b.used - a.used || (a.phrase < b.phrase ? -1 : 1))
}
