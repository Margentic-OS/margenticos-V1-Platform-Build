// The must-fail controls of a faithfulness recheck, as a pure function.
//
// scripts/run-firm-fact.ts --recheck replays stored clause-and-quote pairs through the
// current code check and the current judge. A CONTROL is a clause known to add something
// its quote does not say; the recheck must show both gates rejecting it, or the gates have
// gone lenient.
//
// WHY THIS IS ITS OWN MODULE. The first version lived in the script and read "the judge
// did not pass it" as "the judge failed it". A judge call that errored returned no verdict,
// no verdict is not a pass, and so a run with the API down printed "all controls failed
// both the code check and the judge" and exited 0 with the judge never consulted. A control
// that cannot be told from an outage is not a control. It also counted a control as failing
// whatever the REASON, so the known addition could start to pass while an unrelated word
// kept the clause failing. Both are held here, where a test can reach them.

import type { JudgeVerdict } from './firm-fact'

export interface MustFailControl {
  /** Prefix of the prospect id the stored record belongs to. */
  idPrefix: string
  /** The word the clause is known to add. Both gates must reject the clause FOR THIS WORD. */
  word: string
}

/**
 * "1a2b3c4d=automation,5e6f7a8b=select" -> controls.
 *
 * EVERY CONTROL NAMES ITS WORD. A bare prefix would be confirmed by any rejection at all,
 * and the run would still print that each control was rejected "for its own word". A
 * prefix given twice is refused too: only its first entry would ever be read.
 */
export function parseMustFail(arg: string): MustFailControl[] {
  const controls = arg.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const [idPrefix, word] = part.split('=')
    if (!idPrefix?.trim() || !word?.trim()) {
      throw new Error(`--must-fail: "${part}" needs the word its clause adds, as <prospect id prefix>=<word>`)
    }
    return { idPrefix: idPrefix.trim(), word: word.trim().toLowerCase() }
  })
  const seen = new Set<string>()
  for (const c of controls) {
    if (seen.has(c.idPrefix)) throw new Error(`--must-fail: ${c.idPrefix} is listed twice`)
    seen.add(c.idPrefix)
  }
  return controls
}

/**
 * Did both gates reject this control, for the reason it is a control? Empty means yes.
 * `judge` null means the judge gave no verdict, which confirms nothing.
 */
export function controlProblems(input: {
  word: string | null
  /** findWordsAbsentFromQuote(clause, quote). */
  codeAbsent: readonly string[]
  judge: JudgeVerdict | null
  judgeFaithful: boolean
}): string[] {
  const problems: string[] = []
  const has = (words: readonly string[], word: string) => words.some(w => w.toLowerCase() === word)
  if (input.codeAbsent.length === 0) problems.push('the code check passed it')
  else if (input.word && !has(input.codeAbsent, input.word)) {
    problems.push(`the code check rejected it, but not for "${input.word}" (it named: ${input.codeAbsent.join(', ')})`)
  }
  if (input.judge === null) problems.push('the judge gave no verdict, so the judge was not tested')
  else if (input.judgeFaithful) problems.push('the judge passed it')
  else if (input.word && !has(input.judge.added_concepts, input.word)) {
    problems.push(`the judge rejected it, but not for "${input.word}" (it named: ${input.judge.added_concepts.join(', ') || 'nothing'})`)
  }
  return problems
}
