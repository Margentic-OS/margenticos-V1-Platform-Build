// Shared constants for the Instantly V2 integration.
// Both the reply-actions handler and the polling layer import from here
// so a base URL or version change only requires one edit.

const PROD_URL = 'https://api.instantly.ai/api/v2'

/**
 * Resolves the base URL for the in-app Instantly mock server.
 *
 * Uses VERCEL_URL (deployment-specific) over NEXT_PUBLIC_APP_URL (usually the
 * production custom domain) so preview environments hit the right instance.
 * Third-party mock at developer.instantly.ai/_mock/api/v2 is dead as of 2026-06-04.
 */
function getMockBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/mock/instantly`
  if (process.env.NEXT_PUBLIC_APP_URL) return `${process.env.NEXT_PUBLIC_APP_URL}/api/mock/instantly`
  return 'http://localhost:3000/api/mock/instantly'
}

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export const INSTANTLY_API_BASE = PROD_URL

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export const INSTANTLY_API_BASE_URL: string =
  process.env.INSTANTLY_API_BASE_URL ?? PROD_URL

// TLDs accepted by Instantly's DFY email account ordering API.
// Source: Instantly docs (verified 2026-05-21). Extend here if Instantly adds TLDs.
export const INSTANTLY_DFY_ALLOWED_TLDS = ['.com', '.org'] as const

/**
 * The canonical resolver for all Instantly call sites.
 *
 * - INSTANTLY_API_BASE_URL env var always wins (test/override use).
 * - isActive=true  → production URL (real money, real sends).
 * - isActive=false → in-app mock URL (no subscription required).
 *
 * This means the flag drives URL selection at every call site — not NODE_ENV.
 * Vercel preview and production environments both use NODE_ENV="production",
 * so a NODE_ENV-based check always returns the production URL on Vercel even
 * when the flag is deliberately off for staged testing.
 */
export function resolveInstantlyBaseUrl(isActive: boolean): string {
  if (process.env.INSTANTLY_API_BASE_URL) return process.env.INSTANTLY_API_BASE_URL
  return isActive ? PROD_URL : getMockBaseUrl()
}

/** @deprecated Use resolveInstantlyBaseUrl(isActive) instead. */
export function getInstantlyApiBaseUrl(): string {
  return process.env.INSTANTLY_API_BASE_URL ?? PROD_URL
}

/**
 * Summarizes an HTTP response body for error messages.
 * If the body is HTML (e.g. an error page), returns a compact summary instead of
 * dumping raw markup into the UI. Otherwise truncates at 400 chars.
 */
export function summarizeResponseBody(body: string, status: number): string {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('<')) {
    const brief = body.replace(/\s+/g, ' ').trim().slice(0, 100)
    return `${status} — received HTML instead of JSON: "${brief}"`
  }
  return body.slice(0, 400)
}
