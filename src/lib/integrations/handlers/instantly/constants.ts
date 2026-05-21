// Shared constants for the Instantly V2 integration.
// Both the reply-actions handler and the polling layer import from here
// so a base URL or version change only requires one edit.

/** @deprecated Use INSTANTLY_API_BASE_URL instead. Retained for backward compatibility with
 *  existing handlers until they are migrated incrementally within Prompt 3B. */
export const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2'

// Configurable base URL for the Instantly V2 API. Set INSTANTLY_API_BASE_URL in your
// environment to override — e.g. to keep mock mode active while a subscription is live,
// or to point a test run at a local proxy.
//
// Development default: Instantly's public mock server (no subscription or API key required).
// Production default: Instantly's live API.
//
// Both defaults include the /api/v2 path so handlers can append endpoint paths directly,
// e.g. `${getInstantlyApiBaseUrl()}/leads/add`.
export const INSTANTLY_API_BASE_URL: string =
  process.env.INSTANTLY_API_BASE_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'https://api.instantly.ai/api/v2'
    : 'https://developer.instantly.ai/_mock/api/v2')

// TLDs accepted by Instantly's DFY email account ordering API.
// Source: Instantly docs (verified 2026-05-21). Extend here if Instantly adds TLDs.
export const INSTANTLY_DFY_ALLOWED_TLDS = ['.com', '.org'] as const

// Evaluated at call time — use this in handlers so tests can override via process.env
// without module-cache issues.
export function getInstantlyApiBaseUrl(): string {
  return (
    process.env.INSTANTLY_API_BASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? 'https://api.instantly.ai/api/v2'
      : 'https://developer.instantly.ai/_mock/api/v2')
  )
}
