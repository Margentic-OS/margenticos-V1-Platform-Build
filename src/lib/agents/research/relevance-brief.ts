// EXPERIMENT ARM B, 2026-10-03. NOT FOR MERGE. Branch exp-relevance-gate.
//
// Question: should research judge relevance from the client's brief instead of requiring a
// candidate to match a listed ICP trigger?
//
// In arm B the client's triggers are HINTS FOR RANKING ONLY. For each candidate fact the
// synthesis model answers from the client's brief (pains, outcomes, what the sender does, its
// scope): would this prospect value the client's outcome now, given this fact? It gives a
// one-sentence link a sceptical reader would accept. The link replaces the approved trigger
// reason as the sentence the writer argues from; every writer and follow-up rule is unchanged.
//
// Rule Zero: nothing here names a market, a service or a pain. Every word of client context
// comes from the brief in the client's messaging document, rendered field by field.
//
// THE HARD CHECKS, applied in code in this arm (they are not enforced in code on the research
// path in arm A, which is said in the report): the fact is dated within 12 months, and it is
// not a founding date, a tagline or slogan, or a role that has ended. The kind is the model's
// label; the date is measured.

import { parseFindingDate } from '@/lib/style/finding-date'
import type { ObservationCandidate } from './types'

/** The fact kinds the model labels each candidate with. The last three are excluded. */
export const FACT_KINDS = ['event', 'content', 'ongoing_state', 'founding', 'tagline', 'ended_role'] as const
export type FactKind = (typeof FACT_KINDS)[number]
export const EXCLUDED_FACT_KINDS: readonly FactKind[] = ['founding', 'tagline', 'ended_role']

/** The fact must be no older than this. Measured from the candidate's machine-readable date. */
export const RELEVANCE_MAX_FACT_AGE_DAYS = 365

export interface BriefRelevance {
  would_value_now: boolean
  link: string | null
  fact_kind: FactKind | null
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function statements(raw: unknown, keep: (o: Record<string, unknown>) => boolean = () => true): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const o = item as Record<string, unknown> | null
    return o && isText(o.statement) && keep(o) ? [o.statement.trim()] : []
  })
}

/**
 * The brief as the synthesis model reads it, or null when the messaging document has none.
 * Field by field from content.outbound_brief: pain angles (with symptom and consequence),
 * outcomes, what the sender does, what it never claims, and who it must not exclude.
 */
export function renderRelevanceBrief(messagingContent: unknown): string | null {
  if (!messagingContent || typeof messagingContent !== 'object') return null
  const brief = (messagingContent as Record<string, unknown>).outbound_brief
  if (!brief || typeof brief !== 'object') return null
  const b = brief as Record<string, unknown>
  const scope = (b.scope && typeof b.scope === 'object' ? b.scope : {}) as Record<string, unknown>

  const pains = Array.isArray(b.pain_angles)
    ? (b.pain_angles as Array<Record<string, unknown>>).flatMap(p => {
        if (!p || !isText(p.statement)) return []
        const parts = [p.statement.trim()]
        if (isText(p.symptom)) parts.push(`What it looks like: ${p.symptom.trim()}`)
        if (isText(p.consequence)) parts.push(`What it costs: ${p.consequence.trim()}`)
        return [parts.join(' ')]
      })
    : []
  const outcomes = statements(b.outcomes)
  const does = statements(scope.does, o => o.proof_only !== true)
  const never = statements(scope.never_claims)
  const mustNotExclude = statements(b.must_not_exclude)

  if (outcomes.length === 0 || does.length === 0) return null

  const list = (items: string[]) => items.map(s => `  - ${s}`).join('\n')
  return [
    'THE CLIENT\'S BRIEF. This is what the client sells and what it changes for a buyer. It is',
    'the only definition of relevant in these instructions.',
    '',
    'What the client does (the offer):',
    list(does),
    '',
    'What a buyer gets from it (the outcomes):',
    list(outcomes),
    '',
    ...(pains.length > 0 ? ['The problems it answers (the pains):', list(pains), ''] : []),
    ...(never.length > 0 ? ['What the client never claims to do:', list(never), ''] : []),
    ...(mustNotExclude.length > 0 ? ['Never assume a prospect is not one of these:', list(mustNotExclude), ''] : []),
  ].join('\n')
}

/** The model's brief_relevance block on one candidate, read strictly. Absent reads as no. */
export function parseBriefRelevance(raw: unknown): BriefRelevance {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const link = isText(o.link) ? o.link.trim() : null
  const fact_kind = FACT_KINDS.find(k => k === o.fact_kind) ?? null
  return { would_value_now: o.would_value_now === true, link, fact_kind }
}

/** Days between the candidate's date and now, or null when it carries no readable date. */
export function factAgeDays(date: string | null | undefined, now: Date): number | null {
  const d = parseFindingDate(date ?? null)
  if (!d) return null
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000)
}

/**
 * Why a candidate cannot carry a personalised opening in arm B, or null when it can.
 * Deterministic: the brief verdict and link must be present, the kind must not be excluded,
 * and the fact must be dated within RELEVANCE_MAX_FACT_AGE_DAYS.
 */
export function briefIneligibility(c: Pick<ObservationCandidate, 'date' | 'brief_relevance'>, now: Date): string | null {
  const r = c.brief_relevance
  if (!r || !r.would_value_now) return 'the brief verdict is no'
  if (!r.link) return 'no link was given'
  if (!r.fact_kind) return 'the fact kind was not labelled'
  if (EXCLUDED_FACT_KINDS.includes(r.fact_kind)) return `the fact is a ${r.fact_kind.replace('_', ' ')}`
  const age = factAgeDays(c.date, now)
  if (age == null) return 'the fact carries no date'
  if (age > RELEVANCE_MAX_FACT_AGE_DAYS) return `the fact is ${age} days old, over ${RELEVANCE_MAX_FACT_AGE_DAYS}`
  return null
}
