// The error a reuse run puts on all four source stubs in place of fetching them.
//
// EXTRACTED from prospect-research-agent-v2.ts on 2026-09-23, unchanged. It moved because
// source-integrity.ts needs it and the agent imports source-integrity: leaving it where it
// was would have made those two files import each other. A circular import passes
// `tsc --noEmit` and the whole vitest suite and fails only `npm run build`, which is why
// this is a separate file rather than a cross-import.
//
// Shared by the code that WRITES the stubs and the code that READS them, because the two
// have to agree on the exact string and stating it twice is how they stop agreeing.
export const SOURCE_SKIPPED_REUSE = 'skipped: stored findings reused'

/**
 * The marker a source puts on its error when IT RAN AND FOUND NOTHING.
 *
 * ═══ THE DISTINCTION THIS FILE'S SIBLING CLAIMED AND DID NOT IMPLEMENT ═══════
 *
 * source-integrity.ts opens by saying "we looked and found nothing" and "we could not
 * look" are different answers. It then had two buckets, skipped and failed, and nowhere
 * to put the first one. So a source that ran, was paid for, and correctly reported an
 * absence was classified as a failure.
 *
 * MEASURED 2026-09-23, on the run that exposed it: 4 of the first 8 prospects were HELD
 * on `Apify posts actor returned no posts`. Apify ran. Apify was paid. The person simply
 * had not posted inside the window. Holding them means anyone who does not post on
 * LinkedIn can never be researched at all.
 *
 * AND THE SAME DAY'S OTHER CHANGE IS WHAT MADE IT COMMON. Until postedLimitDate was
 * added that morning, the actor returned up to 50 posts of any age, so an empty result
 * was rare. With a 90-day filter, every prospect who has not posted recently returns
 * zero. Two changes, each correct alone, wrong together: the filter turned a rare
 * condition into a common one, and the classifier called that condition a failure.
 */
export const SOURCE_RAN_FOUND_NOTHING = 'ran and found nothing'
