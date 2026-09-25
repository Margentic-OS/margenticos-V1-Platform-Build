// THE THREE COST ARMS, ALL OFF BY DEFAULT.
//
// ═══ WHY FLAGS AND NOT BRANCHES ══════════════════════════════════════════════
//
// Each arm changes what a paid call costs. Measuring one means running the SAME prospects
// twice, so the change has to be switchable at runtime rather than compiled in, and it has to
// default to today's behaviour so that merging this cannot alter production on its own.
//
// ENV VARS RATHER THAN system_flags, deliberately. system_flags is read by the queue on every
// claim and is a production control surface; these are measurement settings for one day, set
// on one command line, and they must not be reachable by anything that did not deliberately
// ask. An env var set for a single CLI invocation cannot leak into the next run. A database
// flag left on can.
//
// ═══ READ ONCE PER CALL, NOT CACHED AT MODULE LOAD ═══════════════════════════
//
// A module-level const would be captured when the process starts, which is wrong for a script
// that sets the variable and then imports the agent, and worse for a test that wants to
// exercise both sides. Reading process.env per call costs nothing measurable against a model
// call and removes a whole class of "the flag was on but nothing changed".

/**
 * True only for the exact string 'true'.
 *
 * '1', 'yes', 'TRUE' and ' true' are all OFF. A flag that turns itself on for a value somebody
 * guessed is worse than no flag, because this one spends money.
 */
function on(name: string): boolean {
  return process.env[name] === 'true'
}

// ─── ARM A: cap the candidate list ───────────────────────────────────────────
//
// Measured 2026-09-25 over 1,718 candidates across 308 prospects: 5.58 candidates a prospect,
// 1,172 characters each, and 84.6% of that output describes candidates that are NOT selected.
// Output is 15 of every 18 dollars of a synthesis call, so the candidate list is where the
// money is.
//
// THE INSTRUCTION GOES IN THE USER MESSAGE, NOT THE SYSTEM PROMPT. The system prompt carries
// the cache breakpoint and is byte-identical across a batch; changing it would cost every
// prospect a fresh cache write and confound the thing being measured with a cache effect.
// Same reasoning, and the same placement, as CONSTRAINED_REASONING_INSTRUCTION under ADR-059.

/** The cap, or null when ARM_CANDIDATE_CAP is unset. */
export function candidateCap(): number | null {
  const raw = process.env.ARM_CANDIDATE_CAP
  if (!raw) return null
  const n = Number(raw)
  // A cap of 0 or a non-number is a configuration mistake. Silently reading it as "no cap"
  // would report the arm as having run when it did not, which is the one result that would be
  // believed and wrong. Refuse loudly instead.
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`ARM_CANDIDATE_CAP must be a positive integer, got "${raw}"`)
  }
  return n
}

/**
 * Appended to the synthesis USER message when the cap is on.
 *
 * It caps what is WRITTEN OUT, not what is considered. Asking the model to consider fewer
 * candidates would change the verdict by changing the evidence; asking it to report only its
 * best N changes the bill and leaves the reasoning intact. Whether that distinction survives
 * contact with the model is exactly what the arm measures.
 */
export function candidateCapInstruction(cap: number): string {
  return [
    '',
    '',
    '## Output limit for this request',
    '',
    `Consider every candidate as instructed above. Then WRITE OUT only the strongest ${cap}.`,
    'Rank them as you always would and report the top ones in full, with every field they',
    'normally carry. Do not shorten the fields of the candidates you do report, and do not',
    'change how you score or select. The selected candidate must be among the ones you write.',
  ].join('\n')
}

// ─── ARM B: a cheaper synthesis model ────────────────────────────────────────
//
// Synthesis is 90.6% of a prospect's Anthropic cost, measured over 105 prospects on
// 2026-09-24: $0.2034 against $0.0211 for the writer, floor judge and judge together. Haiku
// 4.5 is a third of Sonnet 4.6 on both input and output.
//
// THE MODEL IS NOT FREE-FORM. It is chosen from a list USD_PER_MTOK can price, because an
// unpriced model would write a ledger row this experiment cannot read back. ADR-013 also
// requires the model to be passed explicitly on every call, and a typo here would be a
// silently different experiment.

/** Models this arm may switch synthesis to. Every one must exist in USD_PER_MTOK. */
export const ARM_SYNTHESIS_MODELS = ['claude-haiku-4-5-20251001'] as const
export type ArmSynthesisModel = typeof ARM_SYNTHESIS_MODELS[number]

/** The model synthesis should use, or null to keep ADR-013's default. */
export function synthesisModelOverride(): ArmSynthesisModel | null {
  const raw = process.env.ARM_SYNTHESIS_MODEL
  if (!raw) return null
  if (!(ARM_SYNTHESIS_MODELS as readonly string[]).includes(raw)) {
    throw new Error(
      `ARM_SYNTHESIS_MODEL must be one of ${ARM_SYNTHESIS_MODELS.join(', ')}, got "${raw}". ` +
      'An unlisted model cannot be priced from USD_PER_MTOK, so its ledger row would be unreadable.',
    )
  }
  return raw as ArmSynthesisModel
}

// ─── ARM C: brief web search ─────────────────────────────────────────────────
//
// THIS ARM IS A SWITCH ON SOMETHING ALREADY BUILT AND ALREADY MEASURED, which is why it is the
// cheapest of the three to trust. webSearch has had a `brief` option since 2026-09-09. The
// tuner uses it; prospect research, which is where the volume is, does not:
// sources/web-search.ts passes `{ maxUses: 1 }` and nothing else.
//
// What brief mode does and does not do, from docs/tuner-cost.md, measured over 40 paired
// lookups on the same companies:
//
//   billable searches   1.48 -> 1.00      the whole of the saving
//   input tokens        9,637 -> 9,619    no change at all
//
// The page text is the provider's decision and there is no parameter at any price that
// shrinks it. Brief mode aims at HOW MANY search blocks arrive, not how big each one is.
//
// AND THE CAP IS NOT THE LEVER, which is why this arm is not "maxUses: 0". Research already
// passes maxUses 1 and measured 2.83 billable searches per prospect over 73 prospects. The
// provider runs more searches than the cap and bills for them, so lowering the number changes
// nothing. Brief mode is the only instrument that moved the count.
//
// Its quality evidence, also from the tuner: verdicts held on 33 of 40, against a judge that
// moves 6 of 40 on identical input. The difference is inside the judge's own noise, which is a
// weaker claim than "it made no difference" and the honest one.
export function briefWebSearch(): boolean {
  return on('ARM_BRIEF_WEB_SEARCH')
}

/** Every arm variable that is set, for a run to print and a ledger row to carry. */
export function activeArms(): Record<string, string> {
  const out: Record<string, string> = {}
  if (process.env.ARM_CANDIDATE_CAP)   out.ARM_CANDIDATE_CAP = process.env.ARM_CANDIDATE_CAP
  if (process.env.ARM_SYNTHESIS_MODEL) out.ARM_SYNTHESIS_MODEL = process.env.ARM_SYNTHESIS_MODEL
  if (briefWebSearch())                out.ARM_BRIEF_WEB_SEARCH = 'true'
  return out
}
