// Layer E: read a filter spec back and say what is wrong with it.
//
// WHY THIS EXISTS. Two different silent failures meet here.
//
// 1. STORED SPECS ARE FROZEN. deriveFilterSpec has exactly one caller,
//    persistIcpFilterSpec, which runs only when a document is promoted. Nothing
//    recomputes a spec on read. So changing deriveFilterSpec leaves every existing row
//    on the old shape, and production carries a MIXED POPULATION of spec shapes.
//    Every reader casts (`icpDoc.icp_filter_spec as ICPFilterSpec`) with no runtime
//    check, so a field that is absent on an old row reads as `undefined`. The two
//    places that matter both guard with `&&` (tier-classification.ts, industries and
//    industries_excluded), which means an absent field degrades to NO SCORING and NO
//    EXCLUSION rather than to an error. The pipeline keeps running and quietly stops
//    applying the rule. This module is what makes that shape visible.
//
// 2. AN INDUSTRY CAN BE TARGETED AND UNCLASSIFIABLE AT THE SAME TIME. See
//    CLASSIFIABLE_INDUSTRIES in industry-mapping.ts. That tag map is many-to-one, so a
//    canonical name can pass the orchestrator's reachability gate and then never be
//    produced by the classifier, and every prospect for it is removed as
//    `industry_off_target` with nothing saying why.
//
//    This module names no vendor on purpose. The tool-specific taxonomy is owned by the
//    translation layer (industry-mapping.ts) and by the handlers; everything upstream of
//    those speaks canonical names only. See CLAUDE.md on industry naming.
//
// REPORT ONLY, ON PURPOSE. Nothing here throws and nothing here gates. Promoting any of
// these to a hard gate is a deliberate decision that changes which runs fail, and it is
// not this ship. The findings are returned so the caller decides the log level.

import {
  FILTER_SPEC_FIELDS,
  type FilterSpecField,
} from '@/lib/agents/icp-filter-spec'
import { CLASSIFIABLE_INDUSTRIES } from '@/lib/sourcing/industry-mapping'

export type SpecFindingCode =
  | 'field_missing'
  | 'field_wrong_type'
  | 'industry_unclassifiable'

export interface SpecFinding {
  code: SpecFindingCode
  field: string
  detail: string
}

// The runtime kind of every filter field.
//
// Typed as Record<FilterSpecField, ...> WITHOUT a cast, so omitting a field is a compile
// error rather than an untested field. CLAUDE.md's rule on `as` over an object literal:
// the cast would switch off exactly the check that makes this correct.
const FIELD_KINDS: Record<FilterSpecField, 'string[]' | 'number'> = {
  job_titles: 'string[]',
  job_titles_excluded: 'string[]',
  seniority_levels: 'string[]',
  person_countries: 'string[]',
  company_countries: 'string[]',
  company_headcount_min: 'number',
  company_headcount_max: 'number',
  industries: 'string[]',
  industries_excluded: 'string[]',
  keywords: 'string[]',
  keywords_excluded: 'string[]',
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

/**
 * Inspect a stored or freshly derived filter spec.
 *
 * `alsoClassifiable` lets a caller that has already loaded industry_tag_mappings pass the
 * operator-added canonical names, since those can only ADD to what is classifiable. A
 * caller with none passes nothing and accepts that the check may over-report.
 *
 * Never throws. Returns [] for a spec with nothing wrong.
 */
export function inspectFilterSpec(
  spec: unknown,
  alsoClassifiable: Iterable<string> = [],
): SpecFinding[] {
  const findings: SpecFinding[] = []

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{
      code: 'field_missing',
      field: '(whole spec)',
      detail: `Expected an object, got ${spec === null ? 'null' : typeof spec}.`,
    }]
  }

  const s = spec as Record<string, unknown>

  // Presence and shape of every filter field. Metadata fields (notes,
  // unmatched_industries) are deliberately not checked: they constrain nothing, and a
  // missing `notes` is cosmetic rather than a rule that stopped being applied.
  for (const field of FILTER_SPEC_FIELDS) {
    const value = s[field]
    if (value === undefined || value === null) {
      findings.push({
        code: 'field_missing',
        field,
        detail:
          'Absent on this spec. Readers guard with && rather than throwing, so this ' +
          'field is silently not applied. Re-approve the ICP to rewrite the spec.',
      })
      continue
    }
    const kind = FIELD_KINDS[field]
    const ok = kind === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : isStringArray(value)
    if (!ok) {
      findings.push({
        code: 'field_wrong_type',
        field,
        detail: `Expected ${kind}, got ${Array.isArray(value) ? 'array' : typeof value}.`,
      })
    }
  }

  // Industries that no classifier output can ever match.
  const extra = new Set(Array.from(alsoClassifiable, x => x.toLowerCase()))
  const classifiable = new Set(
    Array.from(CLASSIFIABLE_INDUSTRIES, x => x.toLowerCase()),
  )
  const industries = s.industries
  if (isStringArray(industries)) {
    for (const name of industries as string[]) {
      const key = name.toLowerCase()
      if (!classifiable.has(key) && !extra.has(key)) {
        findings.push({
          code: 'industry_unclassifiable',
          field: 'industries',
          detail:
            `"${name}" is targeted but no sourcing-tool industry tag maps to it, so a ` +
            'prospect can never be classified as this industry and every one will be ' +
            'removed as industry_off_target. Add an industry_tag_mappings row, or ' +
            'map a tool tag to it in industry-mapping.ts, which owns that translation.',
        })
      }
    }
  }

  return findings
}

/** One-line summary for a log field. Empty string when there is nothing to say. */
export function summariseSpecFindings(findings: SpecFinding[]): string {
  if (findings.length === 0) return ''
  return findings.map(f => `${f.code}:${f.field}`).join(', ')
}
