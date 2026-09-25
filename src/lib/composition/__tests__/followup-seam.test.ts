// THE SEAM BETWEEN THE WRITER AND COMPOSITION, tested by driving the REAL composeSequence.
//
// WHY THIS FILE EXISTS. On 2026-09-25 the writer started accepting emails 2 and 3 on their
// own merits (186452c): a prospect could end up with email 2 stored and email 3 not. What
// nobody changed was composition, which required BOTH columns and sent BOTH as template if
// either was missing. Each side was correct in isolation and each side had passing tests.
// Read back from production the same day: 24 of 104 prospects held stored follow-up copy
// that could never reach a human.
//
// WHY THE EXISTING TESTS DID NOT CATCH IT, which is the more useful half. Three copies of
// the substitution rule existed and no test drove the real one:
//   followup-composition.test.ts   a local decide() restating the ladder, pair gate and all
//   export-writer-run.ts:557       a third rule that ignored email 3 entirely
//   compose-sequence.ts            the only one that decides what a prospect receives
// The restatement even carried a header claiming it tested "the real decision logic, not a
// restatement of it". A test that owns its own copy of the rule passes in both worlds, so
// it can never fail when production drifts. That is the defect this file is built not to
// have: every assertion below reads what composeSequence returned.
//
// The measurement that matters: restore the pair gate at compose-sequence.ts and the two
// one-column tests here go red. They are the mutation proof.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

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

function setupSupabaseMock(prospectRow: Record<string, unknown>): void {
  const mockFrom = vi.fn(() => makeChain({ data: prospectRow, error: null }))
  vi.mocked(createClient).mockReturnValue(
    { from: mockFrom } as unknown as ReturnType<typeof createClient>,
  )
}

const CLIENT_ID = 'client-seam-0001'
const PROSPECT_ID = '9f1c4d60-2a7b-4e88-9c30-5b1d7e2a4f16'

const TRIGGER = 'Your second location opened in March.'

/** Template follow-ups: greeting, middle, question, sign-off. The sign-off is two lines. */
const TEMPLATE_EMAIL2_MIDDLE = 'Most teams that grow this way hit the same week twice a year.'
const TEMPLATE_EMAIL3_MIDDLE = 'The work is rarely the constraint. The gap before the next one is.'

const MESSAGING: MessagingContent = {
  variants: {
    A: {
      emails: [
        {
          sequence_position: 1,
          subject_line: 'Quick question',
          subject_char_count: 14,
          body: '{{first_name}}\n\nA placeholder observation sits here.\n\nWe find the work and book it in.\n\nWorth a look?\n\nSam\nExample Co',
          word_count: 20,
        },
        {
          sequence_position: 2,
          subject_line: null,
          subject_char_count: 0,
          body: `{{first_name}},\n\n${TEMPLATE_EMAIL2_MIDDLE}\n\nDoes that match what you see?\n\nSam\nExample Co`,
          word_count: 20,
        },
        {
          sequence_position: 3,
          subject_line: null,
          subject_char_count: 0,
          body: `{{first_name}},\n\n${TEMPLATE_EMAIL3_MIDDLE}\n\nWorth fifteen minutes?\n\nSam\nExample Co`,
          word_count: 20,
        },
      ],
    },
  },
}

const DOCS: ComposeDocs = {
  messagingDoc: MESSAGING,
  messagingDocId: '550e8400-e29b-41d4-a716-446655440000',
  icpPainPoint: undefined,
  positioningValueHook: undefined,
}

const WRITTEN_2 = 'Your second location opened in March. We build the list and run the sending. Conversations reach your diary.'
const WRITTEN_3 = 'A second location changes what a quiet month costs. Worth fifteen minutes?'

function prospectRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: PROSPECT_ID,
    organisation_id: CLIENT_ID,
    segment_id: null,
    variant_id: 'A',
    personalisation_trigger: TRIGGER,
    personalisation_question: null,
    personalisation_subject: null,
    has_dateable_signal: false,
    signal_relevance: null,
    role: 'Owner',
    first_name: 'Alex',
    last_name: 'Fenwick',
    company_name: 'Northgate Works',
    followup_email2: null,
    followup_email3: null,
    followup_email1_fingerprint: null,
    ...over,
  }
}

async function compose(over: Record<string, unknown>) {
  setupSupabaseMock(prospectRow(over))
  return composeSequence({ prospect_id: PROSPECT_ID, client_id: CLIENT_ID, preloadedDocs: DOCS })
}

/**
 * The fingerprint composition will compute for THIS Email 1, taken from composition itself
 * rather than rebuilt here. Rebuilding it would mean this file owning a second copy of the
 * hashing rule, which is the mistake the whole file is written against.
 */
async function currentFingerprint(): Promise<string> {
  const probe = await compose({})
  return probe.followups.email1_fingerprint
}

const bodyAt = (c: Awaited<ReturnType<typeof compose>>, position: number) =>
  c.emails.find(e => e.sequence_position === position)!.body

describe('follow-up positions are decided independently', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.clearAllMocks()
  })

  it('POSITIVE CONTROL: the fixture really can produce a generated follow-up', async () => {
    const fp = await currentFingerprint()
    const c = await compose({
      followup_email2: WRITTEN_2,
      followup_email3: WRITTEN_3,
      followup_email1_fingerprint: fp,
    })

    expect(bodyAt(c, 2)).toContain(WRITTEN_2)
    expect(bodyAt(c, 3)).toContain(WRITTEN_3)
    expect(c.followups.positions[2].mode).toBe('generated')
    expect(c.followups.positions[3].mode).toBe('generated')
  })

  it('NEGATIVE CONTROL: with nothing stored, both ship the approved template', async () => {
    const c = await compose({})

    expect(bodyAt(c, 2)).toContain(TEMPLATE_EMAIL2_MIDDLE)
    expect(bodyAt(c, 3)).toContain(TEMPLATE_EMAIL3_MIDDLE)
    expect(c.followups.positions[2]).toEqual({ mode: 'template', fell_back_reason: 'none_stored' })
    expect(c.followups.positions[3]).toEqual({ mode: 'template', fell_back_reason: 'none_stored' })
  })

  // ─── THE SEAM. These two are the mutation proof. ────────────────────────────
  //
  // Restore `!followup_email2 || !followup_email3 ? 'none_stored'` in compose-sequence.ts
  // and both go red, because the stored email would stop shipping.

  it('email 2 stored and email 3 missing: email 2 ships written, email 3 ships template', async () => {
    const fp = await currentFingerprint()
    const c = await compose({
      followup_email2: WRITTEN_2,
      followup_email3: null,
      followup_email1_fingerprint: fp,
    })

    // The written copy reached the prospect.
    expect(bodyAt(c, 2)).toContain(WRITTEN_2)
    // And it did NOT take the template's middle with it.
    expect(bodyAt(c, 2)).not.toContain(TEMPLATE_EMAIL2_MIDDLE)
    // The position with nothing stored is untouched approved copy.
    expect(bodyAt(c, 3)).toContain(TEMPLATE_EMAIL3_MIDDLE)
    expect(bodyAt(c, 3)).not.toContain(WRITTEN_2)

    expect(c.followups.positions[2]).toEqual({ mode: 'generated', fell_back_reason: null })
    expect(c.followups.positions[3]).toEqual({ mode: 'template', fell_back_reason: 'none_stored' })
  })

  it('email 3 stored and email 2 missing: email 3 ships written, email 2 ships template', async () => {
    const fp = await currentFingerprint()
    const c = await compose({
      followup_email2: null,
      followup_email3: WRITTEN_3,
      followup_email1_fingerprint: fp,
    })

    expect(bodyAt(c, 3)).toContain(WRITTEN_3)
    expect(bodyAt(c, 3)).not.toContain(TEMPLATE_EMAIL3_MIDDLE)
    expect(bodyAt(c, 2)).toContain(TEMPLATE_EMAIL2_MIDDLE)
    expect(bodyAt(c, 2)).not.toContain(WRITTEN_3)

    expect(c.followups.positions[3]).toEqual({ mode: 'generated', fell_back_reason: null })
    expect(c.followups.positions[2]).toEqual({ mode: 'template', fell_back_reason: 'none_stored' })
  })

  // ─── The sequence-wide disqualifiers stay sequence-wide ─────────────────────

  it('a stale Email 1 still stops BOTH, because its callback is what went stale', async () => {
    const c = await compose({
      followup_email2: WRITTEN_2,
      followup_email3: WRITTEN_3,
      followup_email1_fingerprint: 'sha256-of-an-email-1-that-no-longer-exists',
    })

    expect(bodyAt(c, 2)).toContain(TEMPLATE_EMAIL2_MIDDLE)
    expect(bodyAt(c, 3)).toContain(TEMPLATE_EMAIL3_MIDDLE)
    expect(c.followups.positions[2].fell_back_reason).toBe('email1_changed')
    expect(c.followups.positions[3].fell_back_reason).toBe('email1_changed')
  })

  it('no research trigger stops both, and reports the prospect-level reason', async () => {
    const c = await compose({
      personalisation_trigger: null,
      followup_email2: WRITTEN_2,
      followup_email3: WRITTEN_3,
    })

    expect(c.followups.positions[2].fell_back_reason).toBe('not_assigned')
    expect(c.followups.positions[3].fell_back_reason).toBe('not_assigned')
  })

  /**
   * PRECEDENCE, and it is not cosmetic. A prospect with no stored copy also has no stored
   * fingerprint, and followupsMatchEmail1 fails closed on null. Check Email 1 first and
   * every never-generated prospect is reported as 'email1_changed', which reads as the
   * staleness guard firing constantly on copy that was never written.
   */
  it('an absent column reports none_stored, not email1_changed, when no fingerprint exists', async () => {
    const c = await compose({ followup_email2: WRITTEN_2, followup_email1_fingerprint: null })

    expect(c.followups.positions[3].fell_back_reason).toBe('none_stored')
    expect(c.followups.positions[2].fell_back_reason).toBe('email1_changed')
  })
})
