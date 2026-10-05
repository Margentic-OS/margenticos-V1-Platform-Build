/**
 * FIX 6, 2026-09-21. Remove NUL (U+0000) before anything reaches a jsonb column.
 *
 * Postgres text, and therefore jsonb, CANNOT REPRESENT U+0000 at all. It is not a length
 * limit or an encoding preference: the escape \u0000 is rejected outright with
 * "unsupported Unicode escape sequence", and the whole INSERT fails.
 *
 * It arrives in scraped source text, which is what raw_linkedin, raw_apollo, raw_website
 * and raw_web_search hold. Measured 2026-09-21: NINE of 28 prospects in one fresh run
 * failed their result INSERT on this, a third of the batch, and it fails at the storage
 * boundary, so every model call and every paid source had already been spent.
 *
 * APPLIED AT EVERY WRITE SITE THAT CARRIES SCRAPED TEXT. The two prospect_research_results
 * inserts in prospect-research-agent-v2.ts, and the synthesis_batch_entries snapshot in
 * prospect-research-sources-agent.ts. The snapshot was missed on 2026-09-21 and failed 4 of
 * the first ~60 batch-route prospects on 2026-10-05, each AFTER its sources were bought, and
 * each retry bought them again. If another write of scraped text appears, it needs this too.
 *
 * Its own module, not an export of the v2 agent, because seven test files mock that agent
 * wholesale and an importer would receive undefined there.
 *
 * Structure is preserved exactly: only string VALUES and KEYS change, and only by losing a
 * character Postgres could never have stored.
 */
export function stripNulls<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\u0000/g, '') as unknown as T
  if (Array.isArray(value)) return value.map(stripNulls) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/\u0000/g, '')] = stripNulls(v)
    }
    return out as unknown as T
  }
  return value
}
