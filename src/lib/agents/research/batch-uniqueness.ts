// Batch-scoped uniqueness for the two parts of a written opening that collapse first.
//
// WHY THIS GATES RATHER THAN REPORTS
// FrameRegistry has caught repeated sentence shapes since it was built, and it is
// report-only by design: it costs nothing, and re-generating on a collision would spend
// another Sonnet call and make the batch non-reproducible. That trade was right while the
// repetition was occasional. It stopped being right when a batch of twelve came back with
// eleven bridges on one skeleton, "Firms that X often find Y is the first thing that
// quietly Z", three of them close to word-identical. Report-only means the operator reads
// about the uniformity after it has already been written to the prospect rows.
//
// The cause was the prompt, and the prompt is fixed in the same change. This is the net
// underneath it: a prompt instruction is advisory (ADR-028), and "vary your sentence
// shape" is exactly the kind of instruction a model agrees with and then ignores.
//
// SCOPE. The BRIDGE only, plus the closing question. Two halves of the opening behave very
// differently:
//   - the observation is anchored to a named fact about one person, so it varies naturally
//     and gating it would reject legitimate copy. It stays report-only in FrameRegistry.
//   - the bridge is a general statement about a population, which is precisely why every
//     prospect's version gravitates to the same shape.
//   - the closing question has no per-prospect anchor at all, and six of twelve came back
//     carrying the same approved question verbatim.
//
// RESERVE, THEN RELEASE. An attempt reserves its frames synchronously, before the floor
// and judge calls it has to await. Checking and recording in two steps across an await
// would let two prospects in the p-limit pool both pass a clean check and then both commit
// the same frame. If the attempt later fails, or the template wins, the reservation is
// released so a rejected bridge cannot block a later prospect from using that shape.

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

  /**
   * Atomic check-and-record. Returns every collision found; records NOTHING when the
   * return value is non-empty, so a rejected attempt leaves no trace.
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

    if (collisions.length > 0) return collisions

    const uniqueFrames = [...new Set(frames)]
    for (const frame of uniqueFrames) this.bridgeFrames.set(frame, id)
    if (qKey) this.questions.set(qKey, id)
    this.owned.set(id, { frames: uniqueFrames, questions: qKey ? [qKey] : [] })

    return []
  }

  /** Drops everything `id` holds. Safe to call when it holds nothing. */
  release(id: string): void {
    const held = this.owned.get(id)
    if (!held) return
    for (const frame of held.frames) {
      if (this.bridgeFrames.get(frame) === id) this.bridgeFrames.delete(frame)
    }
    for (const key of held.questions) {
      if (this.questions.get(key) === id) this.questions.delete(key)
    }
    this.owned.delete(id)
  }

  /** True when `id` currently holds a reservation. Used by tests and diagnostics. */
  holds(id: string): boolean {
    return this.owned.has(id)
  }

  get bridgeFrameCount(): number {
    return this.bridgeFrames.size
  }

  get questionCount(): number {
    return this.questions.size
  }
}

/** Feedback the writer receives when a reservation is refused. */
export function uniquenessFeedback(collisions: UniquenessCollision[]): string {
  const bridge = collisions.filter(c => c.kind === 'bridge')
  const question = collisions.filter(c => c.kind === 'question')
  const parts: string[] = []

  if (bridge.length > 0) {
    const shapes = [...new Set(bridge.map(c => `"${c.key}"`))].slice(0, 3).join(', ')
    parts.push(
      `Another prospect in this batch already uses that sentence shape for the bridge: ${shapes}. ` +
      `Rewrite the bridge in a genuinely different CONSTRUCTION, not the same shape with different ` +
      `words. Try a conditional, a plain statement of what usually happens next, a contrast, or a ` +
      `consequence.`,
    )
  }

  if (question.length > 0) {
    parts.push(
      `Another prospect in this batch already uses that closing question. Do not reword it slightly. ` +
      `Ask about a different aspect of the problem you named.`,
    )
  }

  return parts.join(' ')
}
