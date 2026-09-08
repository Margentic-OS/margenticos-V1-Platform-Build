// The version a regeneration replaces must reach the model, and a note about it must
// never reach the model without it.
//
// ─── THE DEFECT THIS FILE EXISTS FOR ─────────────────────────────────────────
//
// Until 2026-09-08 every generation agent fetched the existing document only when the
// caller passed is_refresh. That flag meant "a pending suggestion is being replaced", not
// "a prior document exists". The operator's Regenerate control on the document page sends
// no suggestion_id, precisely because nothing is pending, which is exactly the case where
// an ACTIVE document DOES exist. So the one path where the current version matters most
// was the only one that never read it.
//
// MEASURED ON PRODUCTION, not inferred: suggestion 27494db3 (2026-09-08 16:01) carried
// document_id NULL and the reason "This is the initial generation — no prior TOV document
// existed", while strategy_documents held an active v2 created 2026-08-27. The header was
// accurate about the run and false about the world, because it branched on the flag rather
// than on what had been read.
//
// Worse, the note travelled while the document did not. An operator typing "keep the
// opening, soften the rest" was instructing the model to edit text it had never seen.
//
// ─── WHAT THIS TEST PROVES, AND HOW IT FAILS ─────────────────────────────────
//
// It drives the WHOLE TOV agent and captures the message sent to Anthropic, so it proves
// the document reaches the model rather than proving a function was called.
//
//   MUTATION 1  restore the `if (is_refresh)` gate around the fetch, or delete the fetch:
//               "puts the live document in the prompt" and "names the version it replaces"
//               both go red.
//   MUTATION 2  make buildRegenerationNotesBlock ignore its priorVersion argument:
//               "drops the note when there is no document to attach it to" goes red.
//   MUTATION 3  drop `.eq('status', 'active')` from the fetch: "ignores an archived
//               document" goes red, because the fake honours that filter.
//
// The fake honours every filter the agent applies and THROWS on any it does not implement.
// Per CLAUDE.md: a fake that silently ignores a filter cannot fail when the filter is
// removed, and three such holes were found in this codebase in one day.
//
// RULE ZERO: no company, industry, sector, country or buyer type appears in this file.

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  startAgentRun: async () => ({ complete: async () => {}, fail: async () => {} }),
}))

vi.mock('@/lib/agents/website-context', () => ({
  fetchWebsiteContext: async () => [],
  formatWebsiteContextForPrompt: () => '',
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = 'org-under-test'
const DOC_ID = 'doc-v2-under-test'

// The sentence that must survive the trip into the prompt. Deliberately plain prose,
// distinctive enough that finding it proves the document itself arrived.
const LIVE_DOC_SENTENCE =
  'Short sentences carry the weight here, and the closing line always restates the ask.'

// plain_text is NULL on every strategy document in production, so the fixture matches:
// the agent has to fall back to the JSON content. A fixture with plain_text set would
// pass while the real path stayed broken.
const LIVE_DOC_CONTENT = { voice_summary: LIVE_DOC_SENTENCE }

const ARCHIVED_SENTENCE = 'This wording was retired and must never be handed to the model.'

const OPERATOR_NOTE = 'Keep the opening as it is. Soften everything after it.'

interface DocRow {
  id: string
  version: string
  plain_text: string | null
  content: unknown
  document_type: string
  status: string
}

interface WrittenSuggestion {
  document_id: string | null
  suggestion_reason: string
  current_value: string | null
}

function makeSupabase(docs: DocRow[]) {
  const written: WrittenSuggestion[] = []

  function chainFor(table: string) {
    const filters: Record<string, unknown> = {}

    const resolve = () => {
      if (table === 'intake_responses') {
        if (filters.organisation_id !== ORG) return { data: [], error: null }
        return {
          data: [{
            field_key: 'voice_style',
            field_label: 'How would you describe your communication style?',
            response_value: 'Direct and plain.',
            section: 'voice',
            is_critical: false,
          }],
          error: null,
        }
      }
      if (table === 'intake_files') return { data: [], error: null }
      if (table === 'patterns') return { data: [], error: null }
      if (table === 'strategy_documents') {
        // Every filter the agent applies is honoured, so removing one goes red.
        const rows = docs
          .filter(() => filters.organisation_id === ORG)
          .filter(d => filters.document_type === undefined || d.document_type === filters.document_type)
          .filter(d => filters.status === undefined || d.status === filters.status)
        if (rows.length === 0) return { data: null, error: { message: 'no rows' } }
        return { data: rows[0], error: null }
      }
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
      in: () => { throw new Error('fake does not implement in()') },
      is: () => { throw new Error('fake does not implement is()') },
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

function activeDoc(): DocRow {
  return {
    id: DOC_ID,
    version: '2',
    plain_text: null,
    content: LIVE_DOC_CONTENT,
    document_type: 'tov',
    status: 'active',
  }
}

function archivedDoc(): DocRow {
  return {
    id: 'doc-v1-archived',
    version: '1',
    plain_text: ARCHIVED_SENTENCE,
    content: { voice_summary: ARCHIVED_SENTENCE },
    document_type: 'tov',
    status: 'archived',
  }
}

async function runWith(opts: { docs: DocRow[]; note?: string }) {
  capturedUserMessage = ''
  const { client, written } = makeSupabase(opts.docs)
  const { runTovGenerationAgent } = await import('@/agents/tov-generation-agent')
  await runTovGenerationAgent({
    organisation_id: ORG,
    // The fake stands in for a Supabase client; the agent only uses the surface above.
    supabase: client as never,
    ...(opts.note ? { regeneration_notes: { operator_note: opts.note } } : {}),
  })
  return { prompt: capturedUserMessage, suggestion: written[0] }
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-real-credential')
})

// ─── The tests ────────────────────────────────────────────────────────────────

describe('an active document reaches the agent without any caller flag', () => {
  it('the fixture is distinctive, so no assertion below can pass by accident', () => {
    expect(LIVE_DOC_SENTENCE.length).toBeGreaterThan(40)
    expect(LIVE_DOC_SENTENCE).not.toEqual(ARCHIVED_SENTENCE)
  })

  // MUTATION 1. Nothing in this call says "refresh". The document is found by looking.
  it('puts the live document in the prompt', async () => {
    const { prompt } = await runWith({ docs: [activeDoc()] })
    expect(prompt).toContain(LIVE_DOC_SENTENCE)
    expect(prompt).toContain('VERSION 2, THE VOICE GUIDE NOW LIVE')
  })

  it('names the version it replaces in the reasoning header, and links the row to it', async () => {
    const { suggestion } = await runWith({ docs: [activeDoc()] })
    expect(suggestion.suggestion_reason).toContain('This is a refresh. Version 2')
    // The exact false clause that raised this. It must not be reachable when a document exists.
    expect(suggestion.suggestion_reason).not.toContain('initial generation')
    expect(suggestion.document_id).toBe(DOC_ID)
  })

  // MUTATION 3. The status filter is real, and the fake honours it.
  it('ignores an archived document, so a retired version is never handed to the model', async () => {
    const { prompt, suggestion } = await runWith({ docs: [archivedDoc()] })
    expect(prompt).not.toContain(ARCHIVED_SENTENCE)
    expect(suggestion.suggestion_reason).toContain('initial generation')
    expect(suggestion.document_id).toBeNull()
  })

  it('still reports a true initial generation as one', async () => {
    // The case a careless fix breaks. Silencing a true statement is its own defect.
    const { suggestion } = await runWith({ docs: [] })
    expect(suggestion.suggestion_reason).toContain('No prior TOV document exists')
    expect(suggestion.document_id).toBeNull()
  })
})

describe('a note never travels without the document it is about', () => {
  it('carries the note when the document is there to attach it to', async () => {
    const { prompt } = await runWith({ docs: [activeDoc()], note: OPERATOR_NOTE })
    expect(prompt).toContain(OPERATOR_NOTE)
    expect(prompt).toContain(LIVE_DOC_SENTENCE)
    expect(prompt).toContain('NOTES ON VERSION 2, WHICH THIS RUN REPLACES')
  })

  // MUTATION 2. This is the pairing that matters: the note and the document travel
  // together or not at all.
  it('drops the note when there is no document to attach it to', async () => {
    const { prompt, suggestion } = await runWith({ docs: [], note: OPERATOR_NOTE })
    expect(prompt).not.toContain(OPERATOR_NOTE)
    expect(prompt).not.toContain('WHICH THIS RUN REPLACES')
    // Dropped out loud. A silently dropped note is the ADR-038 defect again.
    expect(suggestion.suggestion_reason).toContain('not given to the agent')
  })
})
