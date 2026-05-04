// Safely extract the plain-text body of the prospect's reply from signal.raw_data.
// Instantly's reply payload has: raw_data.body.text (nested) or raw_data.body (flat string).
export function extractReplyBody(rawData: unknown): string | null {
  const raw = rawData as Record<string, unknown> | null
  if (!raw) return null
  const body = raw.body
  if (typeof body === 'object' && body !== null) {
    const text = (body as Record<string, unknown>).text
    return typeof text === 'string' ? text.trim() || null : null
  }
  if (typeof body === 'string') return body.trim() || null
  return null
}
