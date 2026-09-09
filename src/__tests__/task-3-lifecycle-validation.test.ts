// Lifecycle validation for the ICP filter-spec approval gate.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE WAS REWRITTEN ON 2026-09-08, AND WHY THE OLD VERSION IS THE POINT
//
// The gate it tests had NEVER ONCE RUN. It selected `id, document_type, content` from
// `document_suggestions`, and there is no `content` column, so every call errored 42703 and
// returned `{ valid: true }` from its fail-open branch. A second query selected three more
// columns that do not exist on `agent_runs`. Verified live against production.
//
// These tests passed throughout, all six of them, for months.
//
// They passed because the FAKE returned a row shaped like the code's expectations rather
// than like the database:
//
//     single: vi.fn().mockResolvedValue({
//       data: { id: 'sugg-uuid', document_type: 'icp', content: { icp_filter_spec: null } },
//     })
//
// `content` is invented. No such column has ever existed. The fake also never produced an
// error, so `fetchError` was undefined in every test and set on every real call. The suite
// was not testing the gate; it was testing a parallel universe in which the schema matched
// the code, and reporting that universe as green.
//
// This is the CLAUDE.md shape "a fake that does not honour a filter cannot test that
// filter", in its purest form: the fake did not merely ignore a filter, it fabricated a
// column. Coverage, test count and CI all reported success while the guard was dead.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THE NEW FAKE DOES DIFFERENTLY
//
// It knows the REAL columns of the two tables it stands in for, and THROWS on any select of
// a column outside that set. So the original bug is no longer expressible: a test written
// against `content` fails loudly instead of passing quietly.
//
// The column lists below are transcribed from information_schema on 2026-09-08. They are a
// second copy of the schema and will drift, which is a real cost and is accepted knowingly:
// a fake that is wrong in the direction of REJECTING a valid column fails loudly and gets
// fixed in minutes, whereas the old failure mode was silent and lasted months. Drift here is
// noisy; the alternative was quiet.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateIcpFilterSpec } from '@/lib/sourcing/validate-icp-filter-spec'
import { ICP_AGENT_NAME } from '@/agents/icp-generation-agent'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// ─── The real schema, read from information_schema on 2026-09-08 ─────────────

const REAL_COLUMNS: Record<string, string[]> = {
  document_suggestions: [
    'id', 'organisation_id', 'document_id', 'document_type', 'field_path', 'current_value',
    'suggested_value', 'suggestion_reason', 'confidence_level', 'signal_count', 'ab_variant',
    'conflicting_suggestion_id', 'status', 'created_at', 'reviewed_at', 'reviewed_by',
    'sequence_position', 'rejection_reason', 'segment_id', 'revision_note', 'update_trigger',
    'generated_by_model',
  ],
  agent_runs: [
    'id', 'organisation_id', 'agent_name', 'status', 'started_at', 'completed_at',
    'duration_ms', 'output_summary', 'error_message',
  ],
}

/**
 * A Supabase stand-in that rejects columns the real table does not have.
 *
 * Every filter is RECORDED so a test can assert on it, and an unknown column THROWS rather
 * than being silently accepted. `select` is the one that matters: it is the call the dead
 * gate got wrong.
 */
function makeFake(tables: {
  document_suggestions?: { data: unknown; error?: { message: string } | null }
  agent_runs?: { data: unknown; error?: { message: string } | null }
}) {
  const filters: Record<string, Record<string, unknown>> = {}

  const from = vi.fn((table: string) => {
    const known = REAL_COLUMNS[table]
    if (!known) throw new Error(`fake: no such table ${table}`)
    filters[table] ??= {}

    const result = tables[table as keyof typeof tables] ?? { data: null, error: null }

    const chain: Record<string, unknown> = {
      select: vi.fn((cols: string) => {
        for (const raw of cols.split(',')) {
          const col = raw.trim()
          if (col && !known.includes(col)) {
            throw new Error(
              `fake: ${table} has no column "${col}". Real columns: ${known.join(', ')}`,
            )
          }
        }
        return chain
      }),
      eq: vi.fn((col: string, val: unknown) => {
        if (!known.includes(col)) throw new Error(`fake: ${table} has no column "${col}" to filter on`)
        filters[table][col] = val
        return chain
      }),
      order: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
      single: vi.fn(() => Promise.resolve(result)),
    }
    return chain
  })

  return { fake: { from } as never, filters }
}

const icpSuggestion = (spec: unknown) => ({
  data: {
    id: 'sugg-uuid',
    organisation_id: 'org-uuid',
    document_type: 'icp',
    suggested_value: JSON.stringify({ summary: 'an icp', icp_filter_spec: spec }),
  },
  error: null,
})

beforeEach(() => vi.clearAllMocks())

// ─── The regression that started all this ────────────────────────────────────

describe('the fake rejects the column the dead gate actually selected', () => {
  it('throws if anything selects document_suggestions.content', () => {
    const { fake } = makeFake({ document_suggestions: icpSuggestion({ industries: ['X'] }) })
    expect(() =>
      (fake as unknown as { from: (t: string) => { select: (c: string) => unknown } })
        .from('document_suggestions').select('id, document_type, content'),
    ).toThrow(/no column "content"/)
  })

  it('throws on the three agent_runs columns the dead second query used', () => {
    const { fake } = makeFake({ agent_runs: { data: [], error: null } })
    const t = (fake as unknown as { from: (t: string) => { select: (c: string) => unknown } })
      .from('agent_runs')
    expect(() => t.select('id, created_at, status')).toThrow(/no column "created_at"/)
  })
})

// ─── The gate ────────────────────────────────────────────────────────────────

describe('ICP filter-spec approval gate', () => {
  it('BLOCKS with needs_regeneration when the spec is missing and no agent is running', async () => {
    const { fake } = makeFake({
      document_suggestions: icpSuggestion(null),
      agent_runs: { data: [], error: null },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')

    expect(result.valid).toBe(false)
    expect(result.valid === false && result.reason).toBe('needs_regeneration')
  })

  it('BLOCKS with still_generating when an ICP run for this org is in flight', async () => {
    const { fake, filters } = makeFake({
      document_suggestions: icpSuggestion(null),
      agent_runs: {
        data: [{ id: 'run-1', agent_name: ICP_AGENT_NAME, status: 'running', started_at: new Date(Date.now() - 2 * 60_000).toISOString() }],
        error: null,
      },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')

    expect(result.valid).toBe(false)
    expect(result.valid === false && result.reason).toBe('still_generating')

    // The agent name is the thing a first draft of the validator got wrong three ways, so
    // it is asserted rather than assumed. A filter on a name nothing writes matches nothing
    // and reports "needs_regeneration" for ever.
    expect(filters.agent_runs.agent_name).toBe(ICP_AGENT_NAME)
    expect(filters.agent_runs.organisation_id).toBe('org-uuid')
  })

  it('does NOT say still_generating for a stale run, even a recent-looking one', async () => {
    const { fake } = makeFake({
      document_suggestions: icpSuggestion(null),
      agent_runs: {
        data: [{ id: 'r', agent_name: ICP_AGENT_NAME, status: 'running', started_at: new Date(Date.now() - 30 * 60_000).toISOString() }],
        error: null,
      },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')
    expect(result.valid === false && result.reason).toBe('needs_regeneration')
  })

  it('does NOT say still_generating for a COMPLETED run that produced no spec', async () => {
    // A finished run with no spec is precisely the case the operator must act on. Reading
    // only recency, and not status, would tell them to wait for something already over.
    const { fake } = makeFake({
      document_suggestions: icpSuggestion(null),
      agent_runs: {
        data: [{ id: 'r', agent_name: ICP_AGENT_NAME, status: 'completed', started_at: new Date(Date.now() - 60_000).toISOString() }],
        error: null,
      },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')
    expect(result.valid === false && result.reason).toBe('needs_regeneration')
  })

  it('ALLOWS approval when the spec is present, whatever the industry strings say', async () => {
    const { fake } = makeFake({
      document_suggestions: icpSuggestion({ industries: ['Not A Canonical Name'], seniority_levels: ['owner'] }),
    })
    expect(await validateIcpFilterSpec(fake, 'sugg-uuid')).toEqual({ valid: true })
  })

  it('BLOCKS on an EMPTY spec object, which would pass a bare null check', async () => {
    const { fake } = makeFake({
      document_suggestions: icpSuggestion({}),
      agent_runs: { data: [], error: null },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')
    expect(result.valid).toBe(false)
  })

  it('passes non-ICP document types without reading agent_runs at all', async () => {
    const { fake } = makeFake({
      document_suggestions: {
        data: { id: 's', organisation_id: 'org-uuid', document_type: 'tov', suggested_value: '{}' },
        error: null,
      },
    })
    expect(await validateIcpFilterSpec(fake, 'sugg-uuid')).toEqual({ valid: true })
  })

  it('fails OPEN when the suggestion cannot be read, because the route already 404s that', async () => {
    const { fake } = makeFake({
      document_suggestions: { data: null, error: { message: 'not found' } },
    })
    expect(await validateIcpFilterSpec(fake, 'missing')).toEqual({ valid: true })
  })

  it('falls back to needs_regeneration when agent_runs cannot be read', async () => {
    // The spec is missing either way. Only the wording of the operator's message is at
    // stake, so the actionable message wins over silence.
    const { fake } = makeFake({
      document_suggestions: icpSuggestion(null),
      agent_runs: { data: null, error: { message: 'boom' } },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')
    expect(result.valid === false && result.reason).toBe('needs_regeneration')
  })

  it('treats unparseable suggested_value as no spec rather than throwing', async () => {
    const { fake } = makeFake({
      document_suggestions: {
        data: { id: 's', organisation_id: 'org-uuid', document_type: 'icp', suggested_value: 'not json' },
        error: null,
      },
      agent_runs: { data: [], error: null },
    })
    const result = await validateIcpFilterSpec(fake, 'sugg-uuid')
    expect(result.valid).toBe(false)
  })
})
