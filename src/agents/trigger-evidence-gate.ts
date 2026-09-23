// The two things `evidence_to_find` must never contain, enforced in code.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A GATE AND NOT A PROMPT RULE
//
// Per ADR-028 a prompt instruction is advisory and only code gates. Measured on the ICP
// generator, 2026-09-23, with the ban written into the system prompt in plain terms:
//
//   run 1, no regeneration note    9 of 15 evidence items broke a ban
//   run 2, note naming the rule    9 of 15 evidence items broke a ban
//
// The rule was in front of the model both times. It changed nothing.
//
// BOTH DETECTORS ARE BORROWED, NOT WRITTEN. findFirmographicFigures owns what counts as a
// figure from the company record and is the same list that gates outbound copy;
// findActivityVerdicts owns what counts as naming an absence and carries the precision
// measurements that earned it a blocking role. A second pair written here would be a second
// definition of the same two bans, drifting from the day it shipped, and evidence that
// passed this gate could still produce copy the writer refuses.
//
// findActivityVerdicts takes (observation, bridge) because that is its call site in the
// writer. An evidence item is neither, so it is passed as the observation with an empty
// bridge, and only the names_an_absence hits are read: the other two kinds are about a gap
// landing on the wrong people, which is a property of a SENTENCE TO A PROSPECT and has no
// meaning for a line describing where to look for something.
// ═════════════════════════════════════════════════════════════════════════════

import { findFirmographicFigures } from '@/lib/style/firmographic'

/**
 * The firmographic labels that mean A FIGURE FROM THE COMPANY RECORD, as opposed to a way
 * of PHRASING size in an email.
 *
 * ═══ WHY A SUBSET AND NOT THE WHOLE LIST ═════════════════════════════════════
 * findFirmographicFigures is called unchanged; only which of its labels count here is
 * scoped. The list it owns serves outbound copy, where "a team of one person" is a size
 * claim about the reader. An evidence line is not addressed to anyone, so the same patterns
 * read differently.
 *
 * MEASURED 2026-09-23: "A post naming a person and the new title they have moved into"
 * returns ["a spelled-out team size"], because the pattern is
 * /\b(?:one|two|...|a|an)[- ]person\b/ and the line contains "a person". That is a clean
 * evidence item and gating it would have made this an outage rather than a check.
 *
 * IN: figures that could only come off a company record.
 * OUT: idioms about how an email refers to size, which describe prose rather than data.
 *      Every "a headcount of one (...)" entry, "a spelled-out team size", "an oblique
 *      reference to their size" and "an unchanged-headcount claim" are OUT for that reason:
 *      they match the way a sentence talks, not a number in a field.
 */
const RECORD_FIGURE_LABELS: ReadonlySet<string> = new Set([
  'a headcount',
  'a headcount claim',
  'a spelled-out headcount',
  'a team size',
  'a percentage from their record',
  'a currency amount',
  'a figure like 500K or 5M',
  'a figure in millions or billions',
])

/**
 * Absences as they appear in EVIDENCE TEXT, which is not the shape the activity-verdict
 * detector was built for.
 *
 * ═══ WHY NEW PATTERNS RATHER THAN THE EXISTING DETECTOR ══════════════════════
 * findActivityVerdicts owns absences in COPY ADDRESSED TO A PROSPECT: "you don't have", "no
 * outreach running". Measured against the six absence items the ICP generator actually
 * produced, it caught TWO. Its patterns are about a gap landing on a person; an evidence
 * line describes where to look.
 *
 * REPORT MODE. This counts and quotes; it never blocks. It is new and unmeasured, and this
 * codebase has a standing rule about that: ACTIVITY_VERDICT_MODE shipped in report mode and
 * stayed there until 246 attempts had been scanned and precision measured at ~83%. A
 * detector that has never been wrong yet has also never been tested.
 */
const EVIDENCE_ABSENCE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // WIDENED 2026-09-23 AFTER MISSING THREE. The first version listed the NOUNS an absence
  // could attach to (posts, content, roles...), built from the six examples on hand. It then
  // missed "but no clear call-to-action", "but no visible lead capture" and "have no system
  // converting that attention" — the same claim with nouns nobody had thought of.
  //
  // A closed noun list is the wrong shape for this: "no" followed by a noun phrase is an
  // absence whichever noun it is. Verified against every clean evidence item on file, none
  // of which contains the word "no" at all, so the wider pattern costs nothing.
  { pattern: /\bno\s+\w+/i,                                          label: 'says there is none of something' },
  { pattern: /\bwithout\s+\w+/i,                                     label: 'says something is missing' },
  { pattern: /\bnot\s+(?:been\s+)?(?:updated|active|listed|published|posted|visible)\b/i, label: 'says something has not happened' },
  { pattern: /\b(?:no\s+longer|never)\s+\w+/i,                      label: 'says something stopped or never happened' },
  { pattern: /\b(?:stale|absent|missing|dormant|inactive)\b/i,        label: 'names something as stale or absent' },
  { pattern: /\bmarked\s+(?:closed|expired|filled)\b/i,              label: 'says a listing closed' },
  { pattern: /\b(?:more than|over|at least)\s+\w+\s+(?:months?|years?)\s+ago\b/i, label: 'dates something by how long since it happened' },
  { pattern: /\bsince\b[^.]{0,30}\b(?:nothing|none)\b/i,            label: 'says nothing since a date' },
]

/**
 * Record FIELDS named without a number.
 *
 * ═══ WHY findFirmographicFigures CANNOT DO THIS ══════════════════════════════
 * Its headcount pattern is /\bheadcount\b[^.]{0,60}?\b\d+/ — the word NEAR A NUMBER. That
 * is right for outbound copy, where a bare "headcount" is unwriteable anyway and only a
 * figure can leak. It is wrong for evidence, where "a recent headcount reduction" names the
 * field as the thing to go and look at, which is exactly the dependency the rule bans.
 *
 * MEASURED on the run of 2026-09-23 with the section hidden: the figure gate passed with
 * zero faults, and two evidence items still told a researcher to read headcount.
 */
const RECORD_FIELD_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bheadcount\b/i,                     label: 'names headcount' },
  { pattern: /\brevenue\b/i,                       label: 'names revenue' },
  { pattern: /\bfunding\b|\braised\b/i,            label: 'names funding' },
  { pattern: /\bgrowth\s+rate\b|\bgrowth\s+%/i,    label: 'names a growth rate' },
  { pattern: /\bstaff\s+count\b|\bemployee\s+count\b/i, label: 'names a staff count' },
]

/** Record fields named in one evidence line, with or without a number. */
export function findRecordFields(text: string): Array<{ label: string; matched: string }> {
  const out: Array<{ label: string; matched: string }> = []
  for (const { pattern, label } of RECORD_FIELD_PATTERNS) {
    const m = text.match(pattern)
    if (m) out.push({ label, matched: m[0] })
  }
  return out
}

/** Absence hits in one evidence line. Report only: nothing acts on these. */
export function findEvidenceAbsences(text: string): Array<{ label: string; matched: string }> {
  const out: Array<{ label: string; matched: string }> = []
  for (const { pattern, label } of EVIDENCE_ABSENCE_PATTERNS) {
    const m = text.match(pattern)
    if (m) out.push({ label, matched: m[0] })
  }
  return out
}

export interface EvidenceFault {
  /** 1-based index of the trigger in tier_1.triggers. */
  trigger_index: number
  /** The trigger's own text, so a reader knows which one without counting. */
  trigger: string
  /** The offending evidence item, verbatim. */
  evidence: string
  /**
   * 'figure'       a number off the company record
   * 'absence'      says there is none of something
   * 'record_field' names a record field to go and read, with or without a number
   */
  kind: 'figure' | 'absence' | 'record_field'
  /** What matched: a firmographic label, or the span the absence detector found. */
  detail: string
}

/** Every fault in a generated trigger list. Empty means the list passes. */
export function findEvidenceFaults(triggers: unknown): EvidenceFault[] {
  const faults: EvidenceFault[] = []
  const list = Array.isArray(triggers) ? triggers : []

  list.forEach((t, i) => {
    const row = (t ?? {}) as Record<string, unknown>
    const triggerText = typeof row.trigger === 'string' ? row.trigger : String(t)
    const evidence = Array.isArray(row.evidence_to_find) ? row.evidence_to_find : []

    for (const raw of evidence) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue

      // FIGURES BLOCK. Scoped to the record-figure labels; see RECORD_FIGURE_LABELS.
      for (const label of findFirmographicFigures(raw)) {
        if (!RECORD_FIGURE_LABELS.has(label)) continue
        faults.push({ trigger_index: i + 1, trigger: triggerText, evidence: raw, kind: 'figure', detail: label })
      }
      // ABSENCES BLOCK SINCE 2026-09-23. They ran in report mode for one generation, which
      // is what report mode is for: the counter was new and unmeasured, and the run it
      // watched is what earned it a blocking role. It caught 9 of 9 real absence items on
      // file with no false positive across every clean evidence item.
      for (const hit of findEvidenceAbsences(raw)) {
        faults.push({ trigger_index: i + 1, trigger: triggerText, evidence: raw, kind: 'absence', detail: hit.matched })
      }
      // RECORD FIELDS BLOCK. findFirmographicFigures needs the word near a NUMBER, which is
      // right for copy and wrong for evidence: "a recent headcount reduction" names the
      // field to go and read, and that is the dependency being banned. Measured on the
      // hidden-section run, the figure gate passed clean while two items said exactly that.
      for (const hit of findRecordFields(raw)) {
        faults.push({ trigger_index: i + 1, trigger: triggerText, evidence: raw, kind: 'record_field', detail: hit.label })
      }
    }
  })
  return faults
}

/**
 * The faults as retry feedback, quoting the offending items.
 *
 * QUOTES THE ITEM RATHER THAN DESCRIBING THE RULE. The rule is already in the system prompt
 * and was ignored twice; what the model has not been shown is which of its own lines broke
 * it. This says nothing about what any trigger should be.
 */
export function evidenceFaultFeedback(faults: EvidenceFault[]): string {
  if (faults.length === 0) return ''
  const WHAT: Record<string, string> = {
    figure:       'a figure from the company record',
    absence:      'an absence',
    record_field: 'a field from the company record',
  }
  const lines = faults.map(f =>
    `  trigger ${f.trigger_index}, evidence "${f.evidence}" — names ${WHAT[f.kind]} (${f.detail})`)
  return [
    `${faults.length} evidence item(s) in the trigger list break a ban stated in HOW TO WRITE TRIGGERS.`,
    'Rewrite tier_1.triggers so none of them does. Everything else in the document stays as it is.',
    '',
    ...lines,
  ].join('\n')
}

export interface AbsenceReportItem {
  trigger_index: number
  trigger: string
  evidence: string
  label: string
  matched: string
}

/**
 * Every absence in a trigger list, for counting and quoting. REPORT ONLY.
 *
 * Deliberately a SEPARATE function returning a SEPARATE type from findEvidenceFaults. A
 * caller has to go and ask for these, and cannot receive them by accident while handling
 * faults it means to block on. The blocking and the counting are different decisions and
 * they are different call sites.
 */
export function findEvidenceAbsenceReport(triggers: unknown): AbsenceReportItem[] {
  const out: AbsenceReportItem[] = []
  const list = Array.isArray(triggers) ? triggers : []
  list.forEach((t, i) => {
    const row = (t ?? {}) as Record<string, unknown>
    const triggerText = typeof row.trigger === 'string' ? row.trigger : String(t)
    const evidence = Array.isArray(row.evidence_to_find) ? row.evidence_to_find : []
    for (const raw of evidence) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      for (const hit of findEvidenceAbsences(raw)) {
        out.push({ trigger_index: i + 1, trigger: triggerText, evidence: raw, label: hit.label, matched: hit.matched })
      }
    }
  })
  return out
}
