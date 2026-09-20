// WHAT THE CLIENT IS TOLD ABOUT AUTOMATIC APPROVAL.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE BUG THIS FIXES, MEASURED RATHER THAN REASONED
//
// The banner read "Auto-approved on 15 Aug 2026 if no action taken" during a walkthrough on
// 2026-09-17. The date was five weeks in the past.
//
// Read from production on 2026-09-17, for the one live organisation:
//
//   tier_1  earliest tier_published_at  2026-08-11 21:59:36+00
//           latest   tier_published_at  2026-09-17 20:17:14+00
//           + AUTO_SANCTION_DAYS (4)  ->  2026-08-15 21:59:36+00   <- the date on screen
//
// getTierData reads `tier_published_at ASC LIMIT 1`, so the anchor is the FIRST time
// anything in that tier was ever published. Every batch published afterwards inherits that
// same deadline. It went into the past on 15 August and can never move again, because the
// earliest publish date of a tier only ever gets older.
//
// SO THE DATE WAS NOT SLIGHTLY STALE. It was anchored to the wrong event, and the error
// grows without bound.
//
// ═════════════════════════════════════════════════════════════════════════════
// AND THE PROMISE COULD NOT BE KEPT EITHER, WHICH IS THE HALF THAT IS NOT A DATE BUG
//
// The write that performs automatic approval is guarded by `isAutoSanctioned && !tierIsLocked`.
// `tierIsLocked` is true as soon as ANY prospect in the tier has been uploaded to the sending
// tool. Measured the same day: 121 locking rows on tier_1, 36 on tier_2, 3 on tier_3. All
// three tiers are locked, and have been since sending started.
//
// So for this organisation nothing will ever be auto-approved, and the banner was promising
// it daily. A deadline that will not be honoured is worse than no deadline: it tells a client
// they can safely do nothing.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE DOES, AND DELIBERATELY DOES NOT DO
//
// It decides what to SAY. It changes no gate and no write: whether and when prospects are
// auto-approved is exactly what it was, and the anchoring fault in that write is recorded
// for a separate change rather than fixed inside a labelling one. This function's contract
// is narrower and is the thing the screen actually needs:
//
//   A DATE IS SHOWN ONLY WHEN IT IS IN THE FUTURE AND WILL ACTUALLY BE ACTED ON.
//
// Every other case gets a sentence that is true, with no date in it.

/** Days after publication before an untouched batch is approved automatically. */
export const AUTO_SANCTION_DAYS = 4

export interface AutoApprovalInputs {
  /**
   * When the prospects STILL AWAITING A DECISION were published, earliest first.
   *
   * THE ROWS IN FRONT OF THE CLIENT, not the tier's whole history. This is the correction:
   * anchoring on the tier's first-ever publish is what put the date five weeks in the past.
   * An empty array means nothing is pending.
   */
  pendingPublishedAt: string[]
  /**
   * True when the tier has prospects already handed to the sending tool.
   *
   * A locked tier is never auto-approved, so a deadline must not be quoted for one. Read
   * from the same `tier_is_locked` the data layer already computes.
   */
  locked: boolean
  /** Injected so a test can fix "now" rather than wait four days. */
  now?: Date
}

export type AutoApprovalNotice =
  /** Nothing is pending, so there is nothing to say. */
  | { kind: 'nothing_pending' }
  /** A real future deadline. `onISO` is safe to render. */
  | { kind: 'scheduled'; onISO: string }
  /**
   * Pending, but no automatic approval is coming: the tier is locked, or the window has
   * already elapsed without the sweep acting. The screen says so instead of quoting a date.
   */
  | { kind: 'no_automatic_approval' }

/**
 * What to tell the client about automatic approval, if anything.
 *
 * THE INVARIANT, and it is the one worth testing: this never returns a date that is not in
 * the future. A past deadline is not rendered in a softer form, it is not rendered at all,
 * because "auto-approved on <a date last month>" is not a late notice, it is a false one.
 */
export function autoApprovalNotice(inputs: AutoApprovalInputs): AutoApprovalNotice {
  const { pendingPublishedAt, locked, now = new Date() } = inputs

  if (pendingPublishedAt.length === 0) return { kind: 'nothing_pending' }

  // A locked tier is never auto-approved, whatever the dates say. Checked before the
  // arithmetic so a freshly published batch inside a locked tier cannot produce a deadline
  // that looks perfectly plausible and will never arrive.
  if (locked) return { kind: 'no_automatic_approval' }

  // The EARLIEST pending publication decides the deadline, because that batch has been
  // waiting longest and is the first that would be swept. A row with an unparseable date
  // contributes nothing rather than being guessed at.
  const earliest = pendingPublishedAt
    .map(iso => new Date(iso).getTime())
    .filter(t => !Number.isNaN(t))
    .sort((a, b) => a - b)[0]

  if (earliest === undefined) return { kind: 'no_automatic_approval' }

  const deadline = earliest + AUTO_SANCTION_DAYS * 24 * 60 * 60 * 1000

  // Already elapsed. Something that was going to happen automatically has not, so promising
  // it again on a date that has passed would repeat the original defect in a new place.
  if (deadline <= now.getTime()) return { kind: 'no_automatic_approval' }

  return { kind: 'scheduled', onISO: new Date(deadline).toISOString() }
}
