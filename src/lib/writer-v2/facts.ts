// THE FACTS WRITER V2 MAY USE, and the writer's own rules for which research facts qualify.
//
// Every dated research candidate is offered, not only those the old synthesis passed as a
// hook. The old pass/fail verdicts (use_as_hook, mention_only, the trigger match, the need
// match) are deliberately NOT read: the relevance test of 2026-10-02 showed they reject facts
// a person would happily open on. The writer applies only these rules:
//
//   - dated, within the last 12 months, and not in the future;
//   - the last 6 months are preferred (marked RECENT for the writer, never a filter);
//   - never a founding date, a tagline or an ended role.
//
// The firm fact (what the firm does, quoted from its own website) and the stored record (the
// industry field) are offered as standing descriptions, with no date rule.

import type { ObservationCandidate } from '@/lib/agents/research/types'
import type { FirmFactRecord } from '@/lib/agents/research/firm-fact'

export type FactKind = 'research' | 'firm' | 'record'

export interface WriterFact {
  /** R1, R2 ... for research; FIRM or RECORD for the standing descriptions. */
  id: string
  kind: FactKind
  source: string
  date: string | null
  evidence: string
  provenance: string
  /** Somebody else's post the prospect re-shared. */
  shared: boolean
  /** Dated within the last six months. */
  recent: boolean
  /** Why a research fact may not be used, or null when it may. */
  ineligible: string | null
}

const DAY_MS = 24 * 3600 * 1000

/** A stored date as a Date, or null. Accepts YYYY, YYYY-MM and YYYY-MM-DD. */
export function parseFactDate(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1))
}

// A founding date, a tagline or an ended role is never a fact to open on.
const NOT_AN_EVENT = /\b(founded|co-?founded|established in|since (19|20)\d\d|tagline|slogan|motto|formerly|former|previously|stepped down|left (his|her|their|the) role|departed|ex-)\b/i

export function researchFact(c: ObservationCandidate, i: number, today: Date): WriterFact {
  const d = parseFactDate(c.date)
  const windowStart = new Date(today.getTime() - 365 * DAY_MS)
  const recentStart = new Date(today.getTime() - 183 * DAY_MS)
  let ineligible: string | null = null
  if (!d) ineligible = 'undated'
  else if (d < windowStart) ineligible = `dated ${c.date}, older than 12 months`
  else if (d > today) ineligible = `dated ${c.date}, in the future`
  else if (NOT_AN_EVENT.test(c.observation)) ineligible = 'reads as a founding date, tagline or ended role'
  return {
    id: `R${i + 1}`,
    kind: 'research',
    source: String(c.source),
    date: c.date ?? null,
    evidence: c.observation,
    provenance: c.provenance || 'no provenance',
    shared: (c as { is_reshare?: boolean }).is_reshare === true,
    recent: !!d && d >= recentStart && d <= today,
    ineligible,
  }
}

/** The firm fact when it carries a quote from the site, else the stored industry, else nothing. */
export function standingFact(firmFact: FirmFactRecord | null, industry: string | null): WriterFact | null {
  if (firmFact?.quote) {
    return { id: 'FIRM', kind: 'firm', source: 'website', date: firmFact.source_fetched_at?.slice(0, 10) ?? null, evidence: firmFact.quote, provenance: firmFact.source_url ?? 'no url', shared: false, recent: false, ineligible: null }
  }
  if (industry && industry.trim()) {
    return { id: 'RECORD', kind: 'record', source: 'stored company record', date: null, evidence: industry.trim(), provenance: 'industry field', shared: false, recent: false, ineligible: null }
  }
  return null
}

/** Every fact for one prospect: each stored research candidate, then the standing description. */
export function factsForProspect(candidates: ObservationCandidate[], firmFact: FirmFactRecord | null, industry: string | null, today: Date): WriterFact[] {
  const facts = candidates.map((c, i) => researchFact(c, i, today))
  const standing = standingFact(firmFact, industry)
  if (standing) facts.push(standing)
  return facts
}

export const hasQualifyingResearch = (facts: WriterFact[]) => facts.some(f => f.kind === 'research' && !f.ineligible)
