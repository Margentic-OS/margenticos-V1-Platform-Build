// Every refusal from POST /api/webhooks/cal-com says WHICH refusal it was, and never prints
// the secret.
//
// WHY. "Our secret is not configured" and "the signature did not match" look identical from
// outside: the booking simply never arrives. Doug cannot read either secret back out of
// Vercel or Cal.com to compare them. So the only way to tell them apart is for the route to
// say so, in its answer and in the Sentry record that emails the operator, while describing
// the secret by presence and length only.
//
// MUTATION-PROVED on commit:
//   - reporting "secret not configured" as a mismatch turns the distinction tests red
//   - putting the secret into the record turns the never-prints test red
//   - removing the Sentry record turns the record tests red

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import type { NextRequest } from 'next/server'

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger }))

const captureMessage = vi.hoisted(() => vi.fn())
const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/nextjs', () => ({ captureMessage, captureException }))

const createServiceRoleClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service-role', () => ({ createServiceRoleClient }))
vi.mock('@/lib/notifications/send-first-meeting-email', () => ({ sendFirstMeetingEmail: vi.fn() }))
vi.mock('@/lib/notifications/send-unmatched-booking-notification', () => ({ sendUnmatchedBookingNotification: vi.fn() }))

import { POST } from '../route'

// Distinctive, so a leak anywhere is unmistakable.
const SECRET = 'zz-distinctive-secret-value-7f3a9c'
const BODY = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'uid-1' } })
const sign = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

function post(signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-cal-signature-256'] = signature
  return POST(new Request('http://localhost/api/webhooks/cal-com', { method: 'POST', body: BODY, headers }) as unknown as NextRequest)
}

function recordFor(reason: string) {
  const call = captureMessage.mock.calls.find(c => c[0] === `cal-com webhook refused: ${reason}`)
  return call?.[1]?.extra as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CALCOM_WEBHOOK_SECRET = SECRET
})

afterEach(() => {
  delete process.env.CALCOM_WEBHOOK_SECRET
})

describe('"not configured" and "did not match" are told apart', () => {
  it('no secret configured: 500, reason secret_not_configured, and the record says the secret is absent', async () => {
    delete process.env.CALCOM_WEBHOOK_SECRET
    const res = await post(sign(BODY, SECRET))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ reason: 'secret_not_configured' })
    expect(recordFor('secret_not_configured')).toMatchObject({ secret_present: false, secret_length: 0 })
  })

  it('signature did not match: 401, reason signature_mismatch, and the record says the secret IS present, with its length', async () => {
    const res = await post(sign(BODY, 'a-different-secret'))

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'signature_mismatch' })
    expect(recordFor('signature_mismatch')).toMatchObject({
      secret_present: true,
      secret_length: SECRET.length,
      secret_trimmed_length: SECRET.length,
    })
  })

  it('the two never share a reason, in the answer or in the record', async () => {
    delete process.env.CALCOM_WEBHOOK_SECRET
    const notConfigured = await (await post(sign(BODY, SECRET))).json()
    process.env.CALCOM_WEBHOOK_SECRET = SECRET
    const mismatch = await (await post(sign(BODY, 'a-different-secret'))).json()

    expect(notConfigured.reason).not.toBe(mismatch.reason)
    const recorded = captureMessage.mock.calls.map(c => c[0])
    expect(new Set(recorded).size).toBe(2)
  })
})

describe('a signature that fails says how', () => {
  it('no signature at all: signature_missing', async () => {
    const res = await post(null)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'signature_missing' })
    expect(recordFor('signature_missing')).toMatchObject({ signature_header_present: false })
  })

  it('Cal.com with no secret of its own sends "no-secret-provided": signature_malformed', async () => {
    const res = await post('no-secret-provided')
    expect(await res.json()).toMatchObject({ reason: 'signature_malformed' })
  })

  it('a secret pasted with a trailing newline shows up as two different lengths', async () => {
    process.env.CALCOM_WEBHOOK_SECRET = `${SECRET}\n`
    const res = await post(sign(BODY, SECRET))

    expect(await res.json()).toMatchObject({ reason: 'signature_mismatch' })
    expect(recordFor('signature_mismatch')).toMatchObject({
      secret_length: SECRET.length + 1,
      secret_trimmed_length: SECRET.length,
    })
  })

  it('no refusal reads or writes anything', async () => {
    await post(null)
    await post('no-secret-provided')
    await post(sign(BODY, 'a-different-secret'))
    delete process.env.CALCOM_WEBHOOK_SECRET
    await post(sign(BODY, SECRET))
    expect(createServiceRoleClient).not.toHaveBeenCalled()
  })
})

describe('the secret is never printed', () => {
  it('appears in no log line, no Sentry record and no response, across every refusal', async () => {
    const bodies: string[] = []
    for (const signature of [null, 'no-secret-provided', sign(BODY, 'a-different-secret')]) {
      bodies.push(await (await post(signature)).text())
    }
    process.env.CALCOM_WEBHOOK_SECRET = `${SECRET}\n`
    bodies.push(await (await post(sign(BODY, SECRET))).text())

    const everything = JSON.stringify({
      bodies,
      sentry: captureMessage.mock.calls,
      logs: [logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls],
    })
    // Positive control: the records were captured at all, so an empty haystack cannot pass.
    expect(captureMessage.mock.calls.length).toBe(4)
    expect(everything).toContain('signature_mismatch')
    expect(everything).not.toContain(SECRET)
  })
})
