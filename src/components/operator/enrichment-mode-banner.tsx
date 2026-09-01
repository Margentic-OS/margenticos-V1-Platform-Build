import type { EnrichmentMode } from '@/lib/sourcing/enrichment-mode'

/**
 * Enrichment Mode Banner
 *
 * Renders the enrichment mode resolved server-side by resolveEnrichmentMode(), which
 * reads integrations_registry.config.enrichment_live: the same row and the same flag
 * that shouldUseMockEnrichment() uses to decide whether enrichment actually calls
 * Apollo. Reading the same flag is what stops the banner drifting from behaviour.
 *
 * WHY THIS IS A PROP AND NOT A FETCH
 *
 * This used to be a client component that built its own supabase-js client with the
 * public anon key inside a useEffect. Two things were wrong with that, and each one
 * alone was enough to make the banner permanently wrong:
 *
 *   1. It filtered on `archived_at IS NULL`. integrations_registry has no archived_at
 *      column, so PostgREST returned 400 / 42703 on every single request.
 *   2. Even with the column fixed, anon cannot read the row. The only policy is
 *      operators_full_access_integrations, which requires is_operator(), so an anon
 *      read returns zero rows.
 *
 * Both failures landed in `catch { setIsLive(false) }`, which renders "Test Mode
 * Active". The error branch and the safe branch were the same branch, so a banner that
 * could not read anything was indistinguishable from a banner reporting good news.
 * Measured 2026-09-01: the flag was `true` while the banner said Test Mode.
 *
 * The mode is now resolved in the operator layout, which has already established an
 * operator session, and passed in. There are three states, and an error is one of
 * them.
 */
export function EnrichmentModeBanner({ mode }: { mode: EnrichmentMode }) {
  if (mode === 'live') {
    return (
      <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <span className="text-red-600 text-lg font-bold">⚠️</span>
          </div>
          <div className="ml-3">
            <p className="text-sm font-medium text-red-800">
              <strong>Live Enrichment Active</strong>
            </p>
            <p className="text-sm text-red-700 mt-1">
              Apollo API enrichment is LIVE. Incoming enrichment runs will consume Apollo credits (~1 per prospect).
              Test data will NOT be used.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Not live and not unknown: the flag was read successfully and is off.
  if (mode === 'test') {
    return (
      <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <span className="text-blue-600 text-lg font-bold">ℹ️</span>
          </div>
          <div className="ml-3">
            <p className="text-sm font-medium text-blue-800">
              <strong>Test Mode Active</strong>
            </p>
            <p className="text-sm text-blue-700 mt-1">
              Enrichment is in test mode. Incoming enrichment runs will use mock data (.mock.invalid emails,
              ICP-plausible headcount, canonical industries). No Apollo credits consumed.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // 'unknown'. Deliberately NOT the blue test-mode panel. The flag could not be read,
  // so enrichment may be live and spending. Saying nothing, or saying "test mode",
  // is the failure this banner already shipped once.
  return (
    <div className="bg-amber-50 border-l-4 border-amber-500 p-4 mb-4">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <span className="text-amber-600 text-lg font-bold">⚠️</span>
        </div>
        <div className="ml-3">
          <p className="text-sm font-medium text-amber-900">
            <strong>Enrichment Mode Unknown</strong>
          </p>
          <p className="text-sm text-amber-800 mt-1">
            The enrichment_live flag could not be read from the integrations registry. Enrichment may be live and
            consuming Apollo credits. Do not start an enrichment run until this is resolved. Check the server logs for
            enrichment-mode errors.
          </p>
        </div>
      </div>
    </div>
  )
}
