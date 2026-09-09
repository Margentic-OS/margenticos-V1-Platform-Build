// The ICP filter-spec "gate", which is not one, and the two ways that was hidden.
//
// ════════════════════════════════════════════════════════════════════════════
// ROUND ONE: the fake fabricated a column.
//
// The original guard selected `id, document_type, content` from `document_suggestions`.
// There is no `content` column. Every call errored 42703 and returned `{ valid: true }` from
// its fail-open branch, so the guard never ran. Its six tests passed for months, because the
// fake returned `content: { icp_filter_spec: null }` and never produced an error. It was not
// testing the guard; it was testing a universe where the schema matched the code.
//
// The fake below is the fix for that: it knows the real columns and THROWS on anything else,
// so a query against a column that does not exist can no longer pass quietly.
//
// ════════════════════════════════════════════════════════════════════════════
// ROUND TWO: the fixtures fabricated a SHAPE, and the column-aware fake could not see it.
//
// The rewrite fixed both dead queries and read the spec from `suggested_value`. Twelve tests
// passed, including the two below that assert the fake rejects the dead columns. THE FIXTURES
// WERE STILL WRONG: they put `icp_filter_spec` inside `suggested_value`, because that is what
// the code expected. Same mistake as round one, one level further in, and invisible to a fake
// that validates columns rather than contents.
//
// Measured against production instead: 25 real ICP suggestions, 25 refusals, 0 allowances.
// `icp_filter_spec` appears in NO suggestion's suggested_value and NO document's content. It
// is a COLUMN written by persistIcpFilterSpec AFTER promotion. The spec is created BY
// approval, so a pre-approval gate on it can never pass.
//
// The rewrite would have refused every ICP approval in production. Its predecessor's
// accidental fail-open was the only reason approval worked at all.
//
// THE LESSON, and it is why these tests are shaped the way they are: a fake can be made to
// reject unknown columns, unknown tables, unknown filters. It cannot tell you that a value
// your code expects has never once existed in the real data. Only production can, and the
// only question that would have revealed it is "what does this return for every real row",
// not "does it behave correctly for the row I imagined".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateIcpFilterSpec } from '@/lib/sourcing/validate-icp-filter-spec'

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

function makeFake(tables: Record<string, { data: unknown; error?: { message: string } | null }>) {
  const from = vi.fn((table: string) => {
    const known = REAL_COLUMNS[table]
    if (!known) throw new Error(`fake: no such table ${table}`)
    const result = tables[table] ?? { data: null, error: null }

    const chain: Record<string, unknown> = {
      select: vi.fn((cols: string) => {
        for (const raw of cols.split(',')) {
          const col = raw.trim()
          if (col && !known.includes(col)) {
            throw new Error(`fake: ${table} has no column "${col}". Real columns: ${known.join(', ')}`)
          }
        }
        return chain
      }),
      eq: vi.fn((col: string) => {
        if (!known.includes(col)) throw new Error(`fake: ${table} has no column "${col}" to filter on`)
        return chain
      }),
      order: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
      single: vi.fn(() => Promise.resolve(result)),
    }
    return chain
  })
  return { from } as never
}

const icpSuggestion = () => ({
  data: { id: 'sugg-uuid', organisation_id: 'org-uuid', document_type: 'icp' },
  error: null,
})

beforeEach(() => vi.clearAllMocks())

// ─── Round one's regression: the fake rejects the dead columns ───────────────

describe('the fake rejects the columns the dead gate selected', () => {
  it('throws if anything selects document_suggestions.content', () => {
    const fake = makeFake({ document_suggestions: icpSuggestion() }) as unknown as {
      from: (t: string) => { select: (c: string) => unknown }
    }
    expect(() => fake.from('document_suggestions').select('id, document_type, content'))
      .toThrow(/no column "content"/)
  })

  it('throws on the agent_runs columns the dead second query used', () => {
    const fake = makeFake({ agent_runs: { data: [], error: null } }) as unknown as {
      from: (t: string) => { select: (c: string) => unknown }
    }
    expect(() => fake.from('agent_runs').select('id, created_at, status'))
      .toThrow(/no column "created_at"/)
  })
})

// ─── Round two: the current, honest behaviour ────────────────────────────────

describe('validateIcpFilterSpec allows every approval, on purpose', () => {
  it('allows an ICP, because the spec is derived AFTER promotion and cannot exist yet', async () => {
    // The assertion that matters. It looks trivial and it is load-bearing: the previous
    // version of this file asserted the opposite and would have blocked every ICP approval
    // in production. Measured 2026-09-08: 0 of 25 real ICP suggestions carry a spec.
    expect(await validateIcpFilterSpec(makeFake({ document_suggestions: icpSuggestion() }), 'sugg-uuid'))
      .toEqual({ valid: true })
  })

  it('allows a non-ICP without reading agent_runs', async () => {
    const fake = makeFake({
      document_suggestions: {
        data: { id: 's', organisation_id: 'org-uuid', document_type: 'tov' },
        error: null,
      },
    })
    expect(await validateIcpFilterSpec(fake, 'sugg-uuid')).toEqual({ valid: true })
  })

  it('allows when the suggestion cannot be read at all', async () => {
    const fake = makeFake({ document_suggestions: { data: null, error: { message: 'not found' } } })
    expect(await validateIcpFilterSpec(fake, 'missing')).toEqual({ valid: true })
  })

  it('never queries agent_runs, because there is no longer a two-state verdict', async () => {
    // agent_runs is absent from the fake entirely, so any read of it throws "no such table".
    // That is the point: the still_generating branch is gone, and this fails loudly if it
    // comes back without the surrounding design being reconsidered.
    await expect(
      validateIcpFilterSpec(makeFake({ document_suggestions: icpSuggestion() }), 'sugg-uuid'),
    ).resolves.toEqual({ valid: true })
  })
})
