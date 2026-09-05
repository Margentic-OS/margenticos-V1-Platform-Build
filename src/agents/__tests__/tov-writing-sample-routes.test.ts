// Writing samples reach the voice guide agent by TWO routes, and both count.
//
//   uploaded — intake_files rows, file_purpose 'voice_sample', extraction complete
//   pasted   — the intake answer under TYPED_VOICE_SAMPLES_FIELD_KEY
//
// THE DEFECT THIS FILE EXISTS FOR. Until 2026-09-05 the count came from uploaded files
// only. Pasted writing still reached the model, because it rode through the retired branch
// of mergeIntakeWithQuestions into the generic intake dump, so the prompt CARRIED the
// writing while simultaneously stating there was none and instructing low confidence. The
// operator note said "No writing samples uploaded" and the model was told to warn the
// client that their guide was a starting framework rather than an extracted voice. Two
// live organisations were in that state, one with several hundred words.
//
// THE CASE THAT MATTERS MOST IS THE EMPTY ONE. An organisation that genuinely provided
// nothing still needs that warning. Silencing a true warning is a worse defect than the
// false one this replaced, and it is the failure a careless fix produces, so 'neither
// route' is tested as hard as the others.
//
// WHY THIS DRIVES THE WHOLE AGENT rather than calling extractVoiceInputs directly. The
// difference between "files only" and "nothing at all" is decided by the FILTERS on the
// intake_files query. A test that bypassed the query could not tell those two apart, and
// they are the two cases most worth telling apart. So the fake below honours every filter
// the agent applies and THROWS on any it does not implement, per CLAUDE.md: a fake that
// silently ignores a filter cannot fail when the filter is removed.
//
// RULE ZERO: no company, industry, sector, country or buyer type appears in this file.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TYPED_VOICE_SAMPLES_FIELD_KEY } from '@/lib/intake/questions'

// ─── Captured model input ─────────────────────────────────────────────────────

let capturedUserMessage = ''

const MODEL_OUTPUT = JSON.stringify({
  voice_summary: 'A placeholder guide body.',
  confidence_level: 'high',
})

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (args: { messages: { content: string }[] }) => {
        capturedUserMessage = args.messages[0].content
        return { content: [{ type: 'text', text: MODEL_OUTPUT }] }
      },
    }
  },
}))

vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: async () => ({
    complete: async () => {},
    fail: async () => {},
  }),
}))

vi.mock('@/lib/agents/website-context', () => ({
  fetchWebsiteContext: async () => [],
  formatWebsiteContextForPrompt: () => '',
}))

// ─── The fake ─────────────────────────────────────────────────────────────────

interface UploadedFileRow {
  original_filename: string
  extracted_text: string
  file_purpose: string
  extraction_status: string
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

interface FakeState {
  intake: IntakeRow[]
  files: UploadedFileRow[]
  organisation_id: string
}

/** What the suggestion row ended up holding. */
interface WrittenSuggestion {
  suggestion_reason: string
  confidence_level: string
}

function makeSupabase(state: FakeState) {
  const written: WrittenSuggestion[] = []

  // Every filter the agent applies is honoured. Anything else throws rather than
  // resolving to the unfiltered set, because a swallowed filter is invisible in a
  // passing test and this whole file turns on two filters being real.
  function chainFor(table: string) {
    const filters: Record<string, unknown> = {}

    const resolve = () => {
      if (table === 'intake_responses') {
        if (filters.organisation_id !== state.organisation_id) return { data: [], error: null }
        return { data: state.intake, error: null }
      }
      if (table === 'intake_files') {
        if (filters.organisation_id !== state.organisation_id) return { data: [], error: null }
        const rows = state.files
          .filter(f => filters.file_purpose === undefined || f.file_purpose === filters.file_purpose)
          .filter(f =>
            filters.extraction_status === undefined ||
            f.extraction_status === filters.extraction_status,
          )
        return { data: rows, error: null }
      }
      if (table === 'patterns') return { data: [], error: null }
      if (table === 'strategy_documents') return { data: null, error: { message: 'none' } }
      throw new Error(`fake: no read behaviour defined for table "${table}"`)
    }

    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value
        return chain
      },
      in: () => {
        throw new Error('fake does not implement in()')
      },
      is: () => {
        throw new Error('fake does not implement is()')
      },
      single: async () => resolve(),
      maybeSingle: async () => resolve(),
      then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onFulfilled),
    }
    return chain
  }

  const client = {
    from: (table: string) => {
      if (table === 'document_suggestions') {
        return {
          insert: (row: WrittenSuggestion) => ({
            select: () => ({
              single: async () => {
                written.push(row)
                return { data: { id: 'suggestion-1' }, error: null }
              },
            }),
          }),
        }
      }
      return chainFor(table)
    },
  }

  return { client, written }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = 'org-under-test'

// Deliberately plain prose. It carries no industry, sector, company or buyer type,
// and it must not, because the prompt scans read this repository.
const PASTED_TEXT =
  'We keep our updates short. We say what changed and what it means. ' +
  'No filler, no throat clearing, straight to the point every time.'

const FILE_TEXT =
  'Short paragraphs win. State the change, state the effect, stop writing. ' +
  'That is the whole method and it has never needed more than that.'

function intakeRows(typed: string | null): IntakeRow[] {
  const rows: IntakeRow[] = [
    {
      field_key: 'voice_style',
      field_label: 'How would you describe your communication style in your own words?',
      response_value: 'Direct and plain.',
      section: 'voice',
      is_critical: false,
    },
  ]
  if (typed !== null) {
    rows.push({
      field_key: TYPED_VOICE_SAMPLES_FIELD_KEY,
      field_label: 'Voice samples (typed)',
      response_value: typed,
      section: 'voice',
      is_critical: false,
    })
  }
  return rows
}

function uploadedFile(text: string): UploadedFileRow {
  return {
    original_filename: 'sample-one.txt',
    extracted_text: text,
    file_purpose: 'voice_sample',
    extraction_status: 'complete',
  }
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length
}

async function runWith(opts: { typed: string | null; files: UploadedFileRow[] }) {
  capturedUserMessage = ''
  const { client, written } = makeSupabase({
    intake: intakeRows(opts.typed),
    files: opts.files,
    organisation_id: ORG,
  })
  const { runTovGenerationAgent } = await import('@/agents/tov-generation-agent')
  await runTovGenerationAgent({
    organisation_id: ORG,
    // The fake stands in for a Supabase client; the agent only uses the surface above.
    supabase: client as never,
  })
  return { prompt: capturedUserMessage, suggestion: written[0] }
}

// The absence wording, in the two places it is emitted.
const PROMPT_ABSENCE = 'NO SAMPLES PROVIDED'
const NOTE_ABSENCE = 'No writing samples provided'

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-real-credential')
})

describe('writing samples arrive by two routes and both are counted', () => {
  it('the fixtures are non-trivial, so no assertion below can pass vacuously', () => {
    expect(wordsIn(PASTED_TEXT)).toBeGreaterThan(20)
    expect(wordsIn(FILE_TEXT)).toBeGreaterThan(20)
  })

  // CASE 1 — pasted only. The state two live organisations were in.
  it('counts pasted text, and claims no absence when only paste was used', async () => {
    const { prompt, suggestion } = await runWith({ typed: PASTED_TEXT, files: [] })

    expect(prompt).toContain(`${wordsIn(PASTED_TEXT)} words across 1 source(s)`)
    expect(prompt).toContain(PASTED_TEXT)
    expect(prompt).not.toContain(PROMPT_ABSENCE)
    expect(suggestion.suggestion_reason).not.toContain(NOTE_ABSENCE)
    expect(suggestion.suggestion_reason).toContain('1 source(s)')
  })

  // CASE 2 — uploaded only. The path that already worked; it must still read the same.
  // This is the case a fake that ignored .eq() could not distinguish from CASE 4.
  it('counts uploaded files exactly as before', async () => {
    const { prompt, suggestion } = await runWith({ typed: null, files: [uploadedFile(FILE_TEXT)] })

    expect(prompt).toContain(`${wordsIn(FILE_TEXT)} words across 1 source(s)`)
    expect(prompt).toContain(FILE_TEXT)
    expect(prompt).not.toContain(PROMPT_ABSENCE)
    expect(suggestion.suggestion_reason).not.toContain(NOTE_ABSENCE)
  })

  // CASE 3 — both. The counts add, and neither source is dropped.
  it('sums both routes and carries both into the prompt', async () => {
    const { prompt } = await runWith({
      typed: PASTED_TEXT,
      files: [uploadedFile(FILE_TEXT)],
    })

    expect(prompt).toContain(
      `${wordsIn(PASTED_TEXT) + wordsIn(FILE_TEXT)} words across 2 source(s)`,
    )
    expect(prompt).toContain(PASTED_TEXT)
    expect(prompt).toContain(FILE_TEXT)
  })

  // CASE 4 — neither. THE ONE THAT MATTERS MOST. A true warning must survive the fix.
  it('still warns, and still lowers confidence, when neither route supplied anything', async () => {
    const { prompt, suggestion } = await runWith({ typed: null, files: [] })

    expect(prompt).toContain(PROMPT_ABSENCE)
    expect(prompt).toContain('[Nothing provided]')
    expect(suggestion.suggestion_reason).toContain(NOTE_ABSENCE)
    expect(suggestion.confidence_level).toBe('low')
  })

  // CASE 4b — an empty paste is not a paste. A stored row holding whitespace must not
  // count as a source, or the warning is silenced by a client who typed nothing.
  it('treats a whitespace-only paste as nothing provided', async () => {
    const { prompt, suggestion } = await runWith({ typed: '   \n  ', files: [] })

    expect(prompt).toContain(PROMPT_ABSENCE)
    expect(suggestion.confidence_level).toBe('low')
  })

  // CASE 5 — no duplication. Pasted text is promoted into the samples block, so it must
  // NOT also appear in the generic intake dump. Before the fix it appeared only there.
  it('carries the pasted text exactly once', async () => {
    const { prompt } = await runWith({ typed: PASTED_TEXT, files: [] })

    const occurrences = prompt.split(PASTED_TEXT).length - 1
    expect(occurrences).toBe(1)
  })
})

describe('the intake_files filters are real', () => {
  // Directly the CLAUDE.md shape: if the fake swallowed these, CASE 2 and CASE 4 would be
  // the same test. These assert the fake itself can tell them apart.
  it('ignores a file whose purpose is not a voice sample', async () => {
    const { prompt } = await runWith({
      typed: null,
      files: [{ ...uploadedFile(FILE_TEXT), file_purpose: 'other' }],
    })

    expect(prompt).toContain(PROMPT_ABSENCE)
    expect(prompt).not.toContain(FILE_TEXT)
  })

  it('ignores a file whose extraction did not complete', async () => {
    const { prompt } = await runWith({
      typed: null,
      files: [{ ...uploadedFile(FILE_TEXT), extraction_status: 'failed' }],
    })

    expect(prompt).toContain(PROMPT_ABSENCE)
    expect(prompt).not.toContain(FILE_TEXT)
  })
})
