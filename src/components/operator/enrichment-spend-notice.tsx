import type { EnrichmentMode } from '@/lib/sourcing/enrichment-mode'

/**
 * What enrichment will actually do, shown next to the control that triggers it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND IT IS NOT THE REASON YOU MIGHT ASSUME
 *
 * The visible problem was noise: `EnrichmentModeBanner` rendered on every operator screen,
 * and `enrichment_live` is true in production, so it was a permanent red banner about the
 * normal state of the system. That is worth fixing on its own — an always-on alarm trains
 * the operator to ignore the colour.
 *
 * The problem underneath was worse and pointed the other way. Both places that warn about
 * spend at the moment of spending carried this as a HARDCODED STRING, conditional on
 * nothing:
 *
 *     "Currently in test mode. No live API calls will be made."
 *       — Gate1ApproveBatch.tsx:324, PipelineOverview.tsx:424
 *
 * Measured on production 2026-09-09: `integrations_registry.config.enrichment_live` is
 * `true` on `can_enrich_contact`. So at the exact moment an operator was about to spend
 * Apollo credits, the interface told them the opposite of the truth, in the calm colour.
 *
 * The two defects compose into the worst possible arrangement: the alarm was where it could
 * not be acted on, and the false reassurance was where the action happens. Deleting the
 * global banner alone would have left the lie in place and removed the only thing
 * contradicting it.
 *
 * SO THIS COMPONENT IS DRIVEN BY THE SAME FLAG AS BEHAVIOUR. The mode is resolved
 * server-side by `resolveEnrichmentMode`, which reads the same row and key that
 * `shouldUseMockEnrichment` reads to decide whether enrichment actually calls Apollo.
 * Reading the same flag is what stops the notice drifting from what the button does. The
 * previous strings could not drift, because they were never connected to anything.
 */
export function EnrichmentSpendNotice({
  mode,
  action,
}: {
  mode: EnrichmentMode
  /** What the operator is about to do, e.g. "Enrichment" or "Enrich and tier". */
  action: string
}) {
  if (mode === 'live') {
    return (
      <div className="bg-[#FDEEE8] rounded-[10px] border border-[#EFBCAA] p-4">
        <p className="text-sm font-medium text-[#8B2020] mb-1">
          {action} will spend real enrichment credits
        </p>
        <p className="text-xs text-[#8B2020]">
          Live enrichment is ON. Every prospect approved here consumes roughly one Apollo
          credit. This is not reversible and the credits are not refunded if the prospect is
          later rejected.
        </p>
      </div>
    )
  }

  if (mode === 'test') {
    return (
      <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-4">
        <p className="text-sm font-medium text-[#7A4800] mb-1">
          {action} normally spends enrichment credits
        </p>
        <p className="text-xs text-[#7A4800]">
          Live enrichment is currently OFF, so this run will use mock data and consume no
          credits. Turning it on is a separate step.
        </p>
      </div>
    )
  }

  // 'unknown'. The flag could not be read, so nobody can say whether this spends. The
  // global banner also fires in this state; saying it again here is deliberate, because
  // this is the one place where the answer changes what the operator should do next.
  return (
    <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-4">
      <p className="text-sm font-medium text-[#7A4800] mb-1">
        Cannot tell whether {action.toLowerCase()} will spend credits
      </p>
      <p className="text-xs text-[#7A4800]">
        The enrichment_live flag could not be read. Enrichment may be live and consuming
        Apollo credits. Do not start a run until this is resolved.
      </p>
    </div>
  )
}
