import jwt from 'jsonwebtoken'

interface ConfirmationTokenPayload {
  meeting_id: string
  organisation_id: string
  iat: number
  exp: number
}

const SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production'
const TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60 // 7 days

export function generateConfirmationToken(
  meetingId: string,
  organisationId: string
): string {
  const payload: ConfirmationTokenPayload = {
    meeting_id: meetingId,
    organisation_id: organisationId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS,
  }

  return jwt.sign(payload, SECRET, { algorithm: 'HS256' })
}

export function verifyConfirmationToken(token: string): ConfirmationTokenPayload | null {
  try {
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] })
    if (
      typeof decoded === 'object' &&
      'meeting_id' in decoded &&
      'organisation_id' in decoded
    ) {
      return decoded as ConfirmationTokenPayload
    }
    return null
  } catch {
    return null
  }
}
