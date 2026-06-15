import { describe, it, expect } from 'vitest'
import { generateConfirmationToken, verifyConfirmationToken } from './confirmation-token'

describe('Meeting Confirmation Token', () => {
  it('generates a valid token', () => {
    const token = generateConfirmationToken('meeting-123', 'org-456')
    expect(token).toBeDefined()
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('verifies a valid token', () => {
    const meetingId = 'meeting-123'
    const orgId = 'org-456'

    const token = generateConfirmationToken(meetingId, orgId)
    const decoded = verifyConfirmationToken(token)

    expect(decoded).not.toBeNull()
    expect(decoded?.meeting_id).toBe(meetingId)
    expect(decoded?.organisation_id).toBe(orgId)
  })

  it('rejects an invalid token', () => {
    const decoded = verifyConfirmationToken('invalid-token-xyz')
    expect(decoded).toBeNull()
  })

  it('rejects a tampered token', () => {
    const token = generateConfirmationToken('meeting-123', 'org-456')
    const tampered = token.slice(0, -5) + 'xxxxx'
    const decoded = verifyConfirmationToken(tampered)
    expect(decoded).toBeNull()
  })

  it('token expires after 7 days', () => {
    // Create a token with past expiry (for testing)
    // We can't easily test this without mocking jwt.sign, so we verify the token includes exp claim
    const token = generateConfirmationToken('meeting-123', 'org-456')
    const decoded = verifyConfirmationToken(token)

    expect(decoded?.exp).toBeDefined()
    expect(decoded?.iat).toBeDefined()
    // exp should be roughly 7 days after iat
    const expirySeconds = (decoded!.exp - decoded!.iat) / 1
    expect(expirySeconds).toBeCloseTo(7 * 24 * 60 * 60, -2) // Allow ~100 second variance
  })
})
