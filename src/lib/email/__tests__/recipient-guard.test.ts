// Guards on WHO an email can reach.
//
// Two separate faults, both one wrong environment variable away from a client
// receiving our internal error text:
//
//   TEST_EMAIL_RECIPIENT   redirects EVERY email to one address, and until 2026-09-07
//                          was read unconditionally in production.
//   RESEND_OPERATOR_EMAIL  routes six operator templates, agent-failure among them,
//                          and nothing checked the address it named.
//
// MUTATION PROOF for both is stated on each block: delete the guard in send.ts and the
// named test goes red. A guard with no failing test is a guard nobody can rely on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/email/client', () => ({
  resendClient: { emails: { send: vi.fn() } },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// The audience guard reads client addresses from the database. Stubbed at the module
// boundary so these tests never need a connection.
const clientAddresses = vi.hoisted(() => ({ current: [] as string[], failed: false }))

vi.mock('@/lib/email/recipient-audience', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recipient-audience')>()
  return {
    ...actual,
    // Only supplies the default reader. An explicitly injected reader still wins, so the
    // direct-call tests below exercise the real function with their own stub.
    assertOperatorRecipient: (
      to: string,
      reader?: import('../recipient-audience').ClientAddressReader,
    ) =>
      actual.assertOperatorRecipient(
        to,
        reader ??
          (async () => ({
            addresses: clientAddresses.current,
            failed: clientAddresses.failed,
          })),
      ),
  }
})

import { sendTransactionalEmail } from '../send'
import { assertOperatorRecipient } from '../recipient-audience'
import { resendClient } from '@/lib/email/client'

const OPERATOR = 'doug@margenticos.com'
const CLIENT = 'founder@apexconsulting.com'

function sendCalls() {
  return vi.mocked(resendClient).emails.send as unknown as { mock: { calls: unknown[][] } }
}

describe('email recipient guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_FROM_EMAIL = 'noreply@example.com'
    clientAddresses.current = [CLIENT]
    clientAddresses.failed = false
    // send.ts destructures { data, error }, so the resolved shape has to carry both.
    ;(vi.mocked(resendClient).emails.send as never as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ data: { id: 'msg-1' }, error: null })
  })

  afterEach(() => {
    delete process.env.RESEND_FROM_EMAIL
    vi.unstubAllEnvs()
  })

  // vi.stubEnv rather than assigning process.env.NODE_ENV: Node makes that property
  // non-configurable, so Object.defineProperty on it throws.
  function setNodeEnv(value: string) {
    vi.stubEnv('NODE_ENV', value)
  }

  // ── TEST_EMAIL_RECIPIENT ────────────────────────────────────────────────────
  // MUTATION PROOF: remove the `process.env.NODE_ENV === 'production'` refusal block
  // from send.ts and the first two tests here go red.

  it('REFUSES to send when TEST_EMAIL_RECIPIENT is set in production', async () => {
    setNodeEnv('production')
    vi.stubEnv('TEST_EMAIL_RECIPIENT', CLIENT)

    const result = await sendTransactionalEmail({
      to: OPERATOR,
      subject: 'Agent failed',
      html: '<p>stack trace</p>',
    })

    expect(result.success).toBe(false)
    expect(result).toHaveProperty('error')
    if (!result.success) {
      expect(result.error).toContain('TEST_EMAIL_RECIPIENT')
      expect(result.error).toContain('production')
    }
  })

  it('does not fall back to the real recipient: nothing is sent at all', async () => {
    // The distinction that matters. A silent fallback would deliver correctly and hide
    // a production environment carrying a staging override primed to redirect everything.
    setNodeEnv('production')
    vi.stubEnv('TEST_EMAIL_RECIPIENT', CLIENT)

    await sendTransactionalEmail({ to: OPERATOR, subject: 'Agent failed', html: '<p>x</p>' })

    expect(sendCalls().mock.calls).toHaveLength(0)
  })

  it('still honours the override outside production, which is what it is for', async () => {
    setNodeEnv('development')
    vi.stubEnv('TEST_EMAIL_RECIPIENT', 'dev-inbox@example.com')

    const result = await sendTransactionalEmail({
      to: OPERATOR,
      subject: 'Agent failed',
      html: '<p>x</p>',
    })

    expect(result.success).toBe(true)
    const [payload] = sendCalls().mock.calls[0] as [{ to: string }]
    expect(payload.to).toBe('dev-inbox@example.com')
  })

  it('sends normally in production when the override is absent', async () => {
    setNodeEnv('production')

    const result = await sendTransactionalEmail({
      to: OPERATOR,
      subject: 'Agent failed',
      html: '<p>x</p>',
    })

    expect(result.success).toBe(true)
    const [payload] = sendCalls().mock.calls[0] as [{ to: string }]
    expect(payload.to).toBe(OPERATOR)
  })

  // ── Operator audience ───────────────────────────────────────────────────────
  // MUTATION PROOF: remove the `params.audience === 'operator'` block from send.ts and
  // the next two tests go red.

  it('REFUSES an operator email addressed to a client user', async () => {
    setNodeEnv('production')

    const result = await sendTransactionalEmail({
      to: CLIENT,
      audience: 'operator',
      subject: 'Agent failed',
      html: '<p>internal stack trace</p>',
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('CLIENT')
    expect(sendCalls().mock.calls).toHaveLength(0)
  })

  it('blocks a client address reached THROUGH the override, not just the intended one', async () => {
    // The guard checks the address actually used. Checking params.to instead would leave
    // the override path unguarded, which is how the two faults combine.
    setNodeEnv('development')
    vi.stubEnv('TEST_EMAIL_RECIPIENT', CLIENT)

    const result = await sendTransactionalEmail({
      to: OPERATOR,
      audience: 'operator',
      subject: 'Agent failed',
      html: '<p>x</p>',
    })

    expect(result.success).toBe(false)
    expect(sendCalls().mock.calls).toHaveLength(0)
  })

  it('allows an operator email to a non-client address', async () => {
    setNodeEnv('production')

    const result = await sendTransactionalEmail({
      to: OPERATOR,
      audience: 'operator',
      subject: 'Agent failed',
      html: '<p>x</p>',
    })

    expect(result.success).toBe(true)
    expect(sendCalls().mock.calls).toHaveLength(1)
  })

  it('leaves client-facing mail to a client address alone', async () => {
    setNodeEnv('production')

    const result = await sendTransactionalEmail({
      to: CLIENT,
      subject: 'Your documents are ready',
      html: '<p>x</p>',
    })

    expect(result.success).toBe(true)
  })

  it('matches the client address case-insensitively', async () => {
    setNodeEnv('production')

    const result = await sendTransactionalEmail({
      to: CLIENT.toUpperCase(),
      audience: 'operator',
      subject: 'Agent failed',
      html: '<p>x</p>',
    })

    expect(result.success).toBe(false)
  })
})

describe('assertOperatorRecipient', () => {
  it('fails CLOSED when the client list cannot be read', async () => {
    // An unverified operator recipient is not sent to. Stated as a test because the
    // opposite choice looks more available and is the wrong one.
    const verdict = await assertOperatorRecipient(OPERATOR, async () => ({
      addresses: [],
      failed: true,
    }))

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('fails closed')
  })

  it('refuses an empty recipient', async () => {
    const verdict = await assertOperatorRecipient('   ', async () => ({
      addresses: [],
      failed: false,
    }))

    expect(verdict.ok).toBe(false)
  })

  it('passes an address that is not a client', async () => {
    const verdict = await assertOperatorRecipient(OPERATOR, async () => ({
      addresses: [CLIENT],
      failed: false,
    }))

    expect(verdict.ok).toBe(true)
  })
})
