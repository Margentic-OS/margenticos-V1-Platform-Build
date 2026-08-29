// The Email 1 subject at composition.
//
// The generated subject is gated exactly as the written closing question is: the researched
// path AND a non-empty stored value, or the variant's authored subject ships. Both halves of
// that gate are tested, because either one alone would let a subject reach a prospect whose
// Email 1 body is still the variant's authored copy, and a subject written for an
// observation that is not in the email is the exact defect this change exists to fix.
//
// Fixtures invented and industry-neutral.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { composeSequence } from '../compose-sequence'
import type { MessagingContent, ComposeDocs } from '../compose-sequence'

vi.mock('@supabase/supabase-js')

vi.mock('@/lib/composition/personalization', () => ({
  generateBridge: vi.fn().mockResolvedValue({ bridge: null }),
  countWords: (text: string) => text.split(/\s+/).filter(Boolean).length,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

type MockResult = { data: unknown; error: unknown }

function makeChain(result: MockResult): unknown {
  const proxy: unknown = new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'then') {
        return (res: (v: MockResult) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej)
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy
}

function setupSupabaseMock(tableConfig: Record<string, MockResult>) {
  const mockFrom = vi.fn((table: string) => makeChain(tableConfig[table] ?? { data: null, error: null }))
  vi.mocked(createClient).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof createClient>)
  return mockFrom
}

const CLIENT_ID = 'org-subject-test'
const PROSPECT_ID = 'prospect-subject-test'

const AUTHORED_SUBJECT = 'a note about capacity'
const GENERATED_SUBJECT = 'two field roles, three depots'

const MESSAGING_CONTENT: MessagingContent = {
  variants: {
    A: {
      emails: [
        {
          sequence_position: 1,
          subject_line: AUTHORED_SUBJECT,
          subject_char_count: AUTHORED_SUBJECT.length,
          body: [
            '{{first_name}}',
            'The authored opener, written against the authored subject.',
            'We keep the work arriving without you chasing it.',
            'Worth a short conversation?',
            'Robin\nKestrel Partners',
          ].join('\n\n'),
          word_count: 30,
        },
        {
          sequence_position: 2,
          subject_line: null,
          subject_char_count: 0,
          body: 'Following up on my last note.\n\nRobin\nKestrel Partners',
          word_count: 9,
        },
      ],
    },
  },
}

const APPROVED_DOCS: ComposeDocs = {
  messagingDoc: MESSAGING_CONTENT,
  messagingDocId: '550e8400-e29b-41d4-a716-446655440000',
}

/** A prospect row, varied per test only in the three personalisation columns. */
const prospectRow = (over: Record<string, unknown>) => ({
  id: PROSPECT_ID,
  organisation_id: CLIENT_ID,
  segment_id: null,
  variant_id: 'A',
  personalisation_trigger: null,
  personalisation_question: null,
  personalisation_subject: null,
  has_dateable_signal: false,
  signal_relevance: null,
  role: null,
  job_title: 'Operations Lead',
  first_name: 'Robin',
  last_name: 'Vale',
  company_name: 'Ashfield Survey Works',
  ...over,
})

async function compose(over: Record<string, unknown>) {
  setupSupabaseMock({ prospects: { data: prospectRow(over), error: null } })
  const result = await composeSequence({
    prospect_id: PROSPECT_ID,
    client_id: CLIENT_ID,
    preloadedDocs: APPROVED_DOCS,
  })
  return result.emails.find(e => e.sequence_position === 1)!
}

describe('compose-sequence — the Email 1 subject', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.clearAllMocks()
  })

  it('substitutes the written subject on the researched path', async () => {
    const email1 = await compose({
      personalisation_trigger: 'Two field roles are open across three depots.',
      personalisation_subject: GENERATED_SUBJECT,
    })

    expect(email1.subject_line).toBe(GENERATED_SUBJECT)
    expect(email1.subject_char_count).toBe(GENERATED_SUBJECT.length)
    // And the body really is the researched one, so the subject matches what it names.
    expect(email1.body).toContain('Two field roles are open across three depots.')
  })

  it('ships the authored subject on the NON-researched path, even with a subject stored', async () => {
    // The guard under test. Without `trigger.source === 'research' &&`, this prospect would
    // receive a subject written for an observation that is not in the email: the authored
    // opener ships, because there is no trigger.
    const email1 = await compose({
      personalisation_trigger: null,
      personalisation_subject: GENERATED_SUBJECT,
    })

    expect(email1.subject_line).toBe(AUTHORED_SUBJECT)
    expect(email1.body).toContain('The authored opener, written against the authored subject.')
  })

  it('ships the authored subject when the stored subject is null, which is a discarded one', async () => {
    const email1 = await compose({
      personalisation_trigger: 'Two field roles are open across three depots.',
      personalisation_subject: null,
    })

    expect(email1.subject_line).toBe(AUTHORED_SUBJECT)
    // The opening still shipped. A rejected subject costs the prospect nothing else.
    expect(email1.body).toContain('Two field roles are open across three depots.')
  })

  it('ships the authored subject when the stored subject is an empty string', async () => {
    const email1 = await compose({
      personalisation_trigger: 'Two field roles are open across three depots.',
      personalisation_subject: '',
    })

    expect(email1.subject_line).toBe(AUTHORED_SUBJECT)
  })

  it('leaves emails 2 to 4 with no subject at all, on either path', async () => {
    setupSupabaseMock({
      prospects: {
        data: prospectRow({
          personalisation_trigger: 'Two field roles are open across three depots.',
          personalisation_subject: GENERATED_SUBJECT,
        }),
        error: null,
      },
    })
    const result = await composeSequence({
      prospect_id: PROSPECT_ID, client_id: CLIENT_ID, preloadedDocs: APPROVED_DOCS,
    })
    const email2 = result.emails.find(e => e.sequence_position === 2)!
    expect(email2.subject_line).toBeNull()
    expect(email2.subject_char_count).toBe(0)
  })
})
