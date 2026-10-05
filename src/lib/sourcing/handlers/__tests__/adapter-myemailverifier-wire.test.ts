// D2b: the MyEmailVerifier handler reads the vendor's real wire format.
//
// The vendor returns its boolean fields as INTEGERS 0 and 1. The handler used to read only the
// booleans and the strings "true" and "false", so every integer read as false, catch-all
// included. A catch-all that came back as 1 with Status "Valid" was therefore marked
// send-eligible. Nothing caught it, because the verifier tests fed finished result objects and
// never the wire.
//
// These tests call the real handler with the real response body, and fetch is the only fake.
// Each assertion that a value is NOT send-eligible sits next to a control that proves the same
// path CAN produce a send-eligible address, so a handler that always answers false cannot pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { myemailverifierHandler } from '../adapter-myemailverifier'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function answerWith(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
  return myemailverifierHandler.execute('someone@example.com')
}

beforeEach(() => {
  vi.stubEnv('MYEMAILVERIFIER_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the live response shape', () => {
  it('reads the integer flags the vendor actually sends', async () => {
    // The body measured from validate_single on 2026-09-15.
    const result = await answerWith({
      Address: 'test@example.com',
      catch_all: 0,
      Disposable_Domain: 1,
      Role_Based: 1,
      Free_Domain: 0,
      Greylisted: 0,
      Status: 'Invalid',
      Diagnosis: 'Disposable or Toxic domain (D6)',
    })

    expect(result.catch_all).toBe(false)
    expect(result.disposable_domain).toBe(true)
    expect(result.role_based).toBe(true)
    expect(result.free_domain).toBe(false)
    expect(result.greylisted).toBe(false)
    expect(result.send_eligible).toBe(false)
  })

  it('CONTROL: a deliverable address with a clear catch-all flag IS send-eligible', async () => {
    const result = await answerWith({ Status: 'Valid', catch_all: 0 })

    expect(result.status).toBe('Valid')
    expect(result.catch_all).toBe(false)
    expect(result.send_eligible).toBe(true)
  })
})

describe('a catch-all is never send-eligible, whatever shape it arrives in', () => {
  it('a Valid address whose catch-all flag is the integer 1 is NOT send-eligible (the defect)', async () => {
    const result = await answerWith({ Status: 'Valid', catch_all: 1 })

    expect(result.catch_all).toBe(true)
    expect(result.send_eligible).toBe(false)
  })

  it('the string shape the handler was first written against still reads', async () => {
    expect((await answerWith({ Status: 'Valid', catch_all: 'true' })).send_eligible).toBe(false)
    expect((await answerWith({ Status: 'Valid', catch_all: 'false' })).send_eligible).toBe(true)
  })

  it('a catch-all flag we cannot read counts as a catch-all, so the address is not send-eligible', async () => {
    // Fail closed: an unreadable value must never make an address eligible.
    const result = await answerWith({ Status: 'Valid' })

    expect(result.catch_all).toBe(true)
    expect(result.send_eligible).toBe(false)
  })

  it('an informational flag we cannot read is treated as not set, and does not change eligibility', async () => {
    const result = await answerWith({ Status: 'Valid', catch_all: 0, Role_Based: 'maybe' })

    expect(result.role_based).toBe(false)
    expect(result.send_eligible).toBe(true)
  })
})
