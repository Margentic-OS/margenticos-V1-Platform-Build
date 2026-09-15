// Whether a client can see their pipeline screen.
//
// ONE LINE, AND IT IS NAMED ON PURPOSE. The decision used to live inline in the page as
// `if (!org.pipeline_unlocked)`, which is not wrong, but it meant the rule could not be
// stated or tested anywhere, and the screen beside it promised a DIFFERENT rule that
// nothing implemented: "unlocks after your first 5 meetings or two months of sending".
// organisations.pipeline_unlocked was read in 30 places and written in none.
//
// So the value of naming it is not reuse. It is that there is now exactly one place that
// says what opens a pipeline, it says "an operator did", and a test can reach it.
//
// WHAT IS DELIBERATELY ABSENT: any reference to a meeting count or an elapsed date.
// ADR-008's automatic rule is not implemented, and a predicate that took meetings as an
// argument would be the first step back toward a screen that promises one.

export interface PipelineVisibility {
  pipeline_unlocked: boolean
}

/** True only when an operator has opened it. Nothing else opens a pipeline. */
export function isPipelineVisibleToClient(org: PipelineVisibility): boolean {
  return org.pipeline_unlocked
}
