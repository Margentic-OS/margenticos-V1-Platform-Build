// Signed tokens for the one-click meeting confirmation link.
//
// ═════════════════════════════════════════════════════════════════════════════
// NO FALLBACK SECRET, AND THAT IS THE POINT OF THIS FILE.
//
// This module used to read `process.env.JWT_SECRET || 'fallback-secret-change-in-production'`.
// JWT_SECRET was set in no environment, so every token would have been signed with that
// literal, and the literal sits in a PUBLIC repository. Anyone could have minted a token
// confirming any meeting as held, which makes it billable.
//
// Now there is no fallback. Without a real secret of at least 32 characters, nothing is
// signed and nothing is accepted: both functions throw ConfirmationSecretMissingError. A
// missing secret is a configuration fault and is reported as one, never as "invalid token",
// so the operator can tell "not set up" from "someone sent a bad link".
//
// The secret is read when it is used, not when this module loads, so a value set after
// start-up is honoured and a value removed is noticed on the next call.
// ═════════════════════════════════════════════════════════════════════════════

import jwt from 'jsonwebtoken'

export interface ConfirmationTokenPayload {
  meeting_id: string
  organisation_id: string
  iat: number
  exp: number
}

const MIN_SECRET_LENGTH = 32
const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60 // 7 days

export class ConfirmationSecretMissingError extends Error {
  constructor() {
    super(
      `JWT_SECRET is not set, or is shorter than ${MIN_SECRET_LENGTH} characters. ` +
        'Meeting confirmation links cannot be signed or checked until it is.',
    )
    this.name = 'ConfirmationSecretMissingError'
  }
}

function requireSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new ConfirmationSecretMissingError()
  }
  return secret
}

/**
 * Signs a confirmation token for one meeting of one organisation.
 * Throws ConfirmationSecretMissingError when no usable secret is configured.
 */
export function generateConfirmationToken(
  meetingId: string,
  organisationId: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
): string {
  const secret = requireSecret()
  const now = Math.floor(Date.now() / 1000)
  const payload: ConfirmationTokenPayload = {
    meeting_id: meetingId,
    organisation_id: organisationId,
    iat: now,
    exp: now + Math.max(60, Math.floor(expiresInSeconds)),
  }
  return jwt.sign(payload, secret, { algorithm: 'HS256' })
}

/**
 * The token's claims when it is genuine and unexpired; null when it is not.
 * Throws ConfirmationSecretMissingError when no usable secret is configured, because
 * "we cannot check this" is not the same answer as "this is not genuine".
 */
export function verifyConfirmationToken(token: string): ConfirmationTokenPayload | null {
  const secret = requireSecret()
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] })
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).meeting_id === 'string' &&
      typeof (decoded as Record<string, unknown>).organisation_id === 'string'
    ) {
      return decoded as ConfirmationTokenPayload
    }
    return null
  } catch {
    return null
  }
}
