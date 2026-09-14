// The confirmation-link token. The first describe block is the reason this file exists:
// with no secret set, nothing is signed and nothing is accepted.
//
// MUTATION-PROVED on commit: putting back `process.env.JWT_SECRET || '<any literal>'` turns
// the "no secret" tests red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  ConfirmationSecretMissingError,
  generateConfirmationToken,
  verifyConfirmationToken,
} from './confirmation-token'

// The literal the old code fell back to. It is in the public repository's history, so a
// token signed with it must never be accepted, whatever else is configured.
const OLD_PUBLIC_FALLBACK = 'fallback-secret-change-in-production'
const TEST_SECRET = 'test-only-confirmation-secret-0123456789abcdef'

let saved: string | undefined
beforeEach(() => { saved = process.env.JWT_SECRET })
afterEach(() => {
  if (saved === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = saved
})

function forgeWith(secret: string) {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({ meeting_id: 'meeting-1', organisation_id: 'org-1', iat: now, exp: now + 3600 }, secret, { algorithm: 'HS256' })
}

describe('with no secret set, nothing is signed and nothing is accepted', () => {
  it('refuses to sign', () => {
    delete process.env.JWT_SECRET
    expect(() => generateConfirmationToken('meeting-1', 'org-1')).toThrow(ConfirmationSecretMissingError)
  })

  it('refuses to accept anything, including a token signed with the old public fallback', () => {
    delete process.env.JWT_SECRET
    expect(() => verifyConfirmationToken(forgeWith(OLD_PUBLIC_FALLBACK))).toThrow(ConfirmationSecretMissingError)
  })

  it('treats an empty or too-short secret as no secret', () => {
    process.env.JWT_SECRET = '   '
    expect(() => generateConfirmationToken('meeting-1', 'org-1')).toThrow(ConfirmationSecretMissingError)
    process.env.JWT_SECRET = 'short'
    expect(() => verifyConfirmationToken(forgeWith('short'))).toThrow(ConfirmationSecretMissingError)
  })
})

describe('with a real secret set', () => {
  beforeEach(() => { process.env.JWT_SECRET = TEST_SECRET })

  it('signs and verifies a token for one meeting of one organisation', () => {
    const decoded = verifyConfirmationToken(generateConfirmationToken('meeting-1', 'org-1'))
    expect(decoded).toMatchObject({ meeting_id: 'meeting-1', organisation_id: 'org-1' })
  })

  it('still rejects a token signed with the old public fallback', () => {
    expect(verifyConfirmationToken(forgeWith(OLD_PUBLIC_FALLBACK))).toBeNull()
  })

  it('rejects a tampered token and a non-token', () => {
    const token = generateConfirmationToken('meeting-1', 'org-1')
    expect(verifyConfirmationToken(token.slice(0, -5) + 'xxxxx')).toBeNull()
    expect(verifyConfirmationToken('not-a-token')).toBeNull()
  })

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    const expired = jwt.sign({ meeting_id: 'meeting-1', organisation_id: 'org-1', iat: past, exp: past + 60 }, TEST_SECRET, { algorithm: 'HS256' })
    expect(verifyConfirmationToken(expired)).toBeNull()
  })

  it('uses the expiry it is given, defaulting to seven days', () => {
    const byDefault = verifyConfirmationToken(generateConfirmationToken('meeting-1', 'org-1'))!
    expect(byDefault.exp - byDefault.iat).toBe(7 * 24 * 60 * 60)
    const custom = verifyConfirmationToken(generateConfirmationToken('meeting-1', 'org-1', 30 * 24 * 60 * 60))!
    expect(custom.exp - custom.iat).toBe(30 * 24 * 60 * 60)
  })
})
