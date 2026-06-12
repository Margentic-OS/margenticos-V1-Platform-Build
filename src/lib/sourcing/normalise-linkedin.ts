// src/lib/sourcing/normalise-linkedin.ts
// Canonical LinkedIn URL normalisation for all sourcing code paths.
// IMPORTANT: All write paths must import and use this function:
//   - Backfill scripts (SQL via UPDATE)
//   - Test seeding (test-dedupe.ts)
//   - Sourcing orchestrator step 7 (future)
// Ensures consistent normalisation across all code that populates linkedin_url_normalised.

export function normaliseLinkedInUrl(url: string | null): string | null {
  if (!url) return null
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
}
