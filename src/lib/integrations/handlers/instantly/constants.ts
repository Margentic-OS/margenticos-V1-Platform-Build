// Shared constants for the Instantly V2 integration.
// Both the reply-actions handler and the polling layer import from here
// so a base URL or version change only requires one edit.

const PROD_URL = 'https://api.instantly.ai/api/v2'
const MOCK_URL = 'https://developer.instantly.ai/_mock/api/v2'

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export const INSTANTLY_API_BASE = PROD_URL

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export const INSTANTLY_API_BASE_URL: string =
  process.env.INSTANTLY_API_BASE_URL ??
  (process.env.NODE_ENV === 'production' ? PROD_URL : MOCK_URL)

// TLDs accepted by Instantly's DFY email account ordering API.
// Source: Instantly docs (verified 2026-05-21). Extend here if Instantly adds TLDs.
export const INSTANTLY_DFY_ALLOWED_TLDS = ['.com', '.org'] as const

/**
 * The canonical resolver for all Instantly call sites.
 *
 * - INSTANTLY_API_BASE_URL env var always wins (test/override use).
 * - isActive=true  → production URL (real money, real sends).
 * - isActive=false → mock URL (no subscription or API key required).
 *
 * This means the flag drives URL selection at every call site — not NODE_ENV.
 * Vercel preview and production environments both use NODE_ENV="production",
 * so a NODE_ENV-based check always returns the production URL on Vercel even
 * when the flag is deliberately off for staged testing.
 */
export function resolveInstantlyBaseUrl(isActive: boolean): string {
  if (process.env.INSTANTLY_API_BASE_URL) return process.env.INSTANTLY_API_BASE_URL
  return isActive ? PROD_URL : MOCK_URL
}

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export function getInstantlyApiBaseUrl(): string {
  return (
    process.env.INSTANTLY_API_BASE_URL ??
    (process.env.NODE_ENV === 'production' ? PROD_URL : MOCK_URL)
  )
}
