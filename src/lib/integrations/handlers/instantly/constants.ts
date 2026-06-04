// Shared constants for the Instantly V2 integration.
// Both the reply-actions handler and the polling layer import from here
// so a base URL or version change only requires one edit.

const PROD_URL = 'https://api.instantly.ai/api/v2'

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export const INSTANTLY_API_BASE = PROD_URL

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export const INSTANTLY_API_BASE_URL: string =
  process.env.INSTANTLY_API_BASE_URL ?? PROD_URL

// TLDs accepted by Instantly's DFY email account ordering API.
// Source: Instantly docs (verified 2026-05-21). Extend here if Instantly adds TLDs.
export const INSTANTLY_DFY_ALLOWED_TLDS = ['.com', '.org'] as const

/**
 * Returns the base URL for real Instantly API calls.
 *
 * - INSTANTLY_API_BASE_URL env var always wins (external test server override).
 * - isActive=false: in-process mock dispatch runs before any fetch, so the URL returned
 *   here is irrelevant in that path — but callers still resolve it for code clarity.
 *
 * URL selection is NOT based on NODE_ENV. Vercel sets NODE_ENV="production" on
 * preview deployments, so NODE_ENV-based checks always resolve production URLs on Vercel
 * even when the flag is deliberately off.
 */
export function resolveInstantlyBaseUrl(isActive: boolean): string {
  if (process.env.INSTANTLY_API_BASE_URL) return process.env.INSTANTLY_API_BASE_URL
  void isActive  // isActive=false → mock dispatch, URL unused; isActive=true → PROD_URL below
  return PROD_URL
}

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export function getInstantlyApiBaseUrl(): string {
  return process.env.INSTANTLY_API_BASE_URL ?? PROD_URL
}

/**
 * Returns true when calls should be dispatched to in-process mock functions
 * rather than fetching the real Instantly API.
 *
 * - isActive=false AND no INSTANTLY_API_BASE_URL override → mock dispatch
 * - isActive=false AND INSTANTLY_API_BASE_URL set → real fetch to external test server
 * - isActive=true → real fetch regardless
 */
export function shouldUseMockDispatch(isActive: boolean): boolean {
  return !isActive && !process.env.INSTANTLY_API_BASE_URL
}

/**
 * Summarizes an HTTP response body for error messages.
 * Detects HTML error pages and returns a compact summary instead of dumping raw markup.
 */
export function summarizeResponseBody(body: string, status: number): string {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('<')) {
    const brief = body.replace(/\s+/g, ' ').trim().slice(0, 100)
    return `${status} — received HTML instead of JSON: "${brief}"`
  }
  return body.slice(0, 400)
}
