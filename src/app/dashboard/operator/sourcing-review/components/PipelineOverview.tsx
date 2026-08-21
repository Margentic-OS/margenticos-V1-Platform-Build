'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { EnrichAndTierButton } from './EnrichAndTierButton'
import { SourceProspectsButton } from './SourceProspectsButton'
import { ResearchProspectsButton } from './ResearchProspectsButton'

interface PipelineMetrics {
  organisation_id: string
  organisation_name: string
  pending_review_count: number
  approved_unenriched_count: number
  tier_1_count: number
  tier_2_count: number
  tier_3_count: number
  enriched_untiered_count: number
  unresearched_count: number
}

interface PipelineOverviewProps {
  metrics: PipelineMetrics[]
  selectedClientId?: string | null
  /**
   * Ceiling the sourcing entry point enforces. Passed in rather than imported: this is a
   * client component, and importing from sourcing-entry would pull the orchestrator, the
   * Apollo handler and the service-role client into the browser bundle.
   */
  sourcingMaxBatchSize: number
}

export function PipelineOverview({ metrics, selectedClientId, sourcingMaxBatchSize }: PipelineOverviewProps) {
  const searchParams = useSearchParams()
  const currentClient = searchParams.get('client')

  if (metrics.length === 0) {
    return (
      <div className="bg-white rounded-[10px] border border-border-card p-6 text-center">
        <p className="text-text-secondary text-sm">No prospects sourced yet. Once a sourcing run completes, prospects awaiting your approval will appear here.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {metrics.map((org) => {
        const isSelected = currentClient === org.organisation_id || selectedClientId === org.organisation_id
        const enrichedCount = org.tier_1_count + org.tier_2_count + org.tier_3_count

        return (
          <div
            key={org.organisation_id}
            className={`rounded-[10px] border p-6 transition-colors ${
              isSelected
                ? 'border-brand-green-primary bg-white'
                : 'border-border-card bg-white hover:bg-[#FAFAF8]'
            }`}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-medium text-text-primary">
                {org.organisation_name}
              </h3>
              {isSelected && (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]">
                  Selected
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {/* Pending review stage */}
              <div className="bg-[#FAEEDA] rounded-[8px] p-3 border border-[#F0D080]">
                <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#7A4800] mb-2">
                  Awaiting approval
                </p>
                <p className="text-2xl font-medium text-text-primary">
                  {org.pending_review_count}
                </p>
              </div>

              {/* Enriching stage */}
              {org.approved_unenriched_count > 0 && (
                <div className="bg-[#FEF7E6] rounded-[8px] p-3 border border-[#F0D080]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#7A4800] mb-2">
                    Enriching
                  </p>
                  <p className="text-2xl font-medium text-text-primary">
                    {org.approved_unenriched_count}
                  </p>
                </div>
              )}

              {/* Tier 1 */}
              {enrichedCount > 0 && (
                <div className="bg-[#EBF5E6] rounded-[8px] p-3 border border-[#BDDAB0]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#3B6D11] mb-2">
                    Tier 1
                  </p>
                  <p className="text-2xl font-medium text-text-primary">
                    {org.tier_1_count}
                  </p>
                </div>
              )}

              {/* Tier 2 */}
              {enrichedCount > 0 && (
                <div className="bg-[#EAF3DE] rounded-[8px] p-3 border border-[#C0DD97]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#5D7F23] mb-2">
                    Tier 2
                  </p>
                  <p className="text-2xl font-medium text-text-primary">
                    {org.tier_2_count}
                  </p>
                </div>
              )}

              {/* Tier 3 */}
              {enrichedCount > 0 && (
                <div className="bg-[#F0ECE4] rounded-[8px] p-3">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#9A9488] mb-2">
                    Tier 3
                  </p>
                  <p className="text-2xl font-medium text-text-primary">
                    {org.tier_3_count}
                  </p>
                </div>
              )}
            </div>

            {/* Run the pipeline: source, then research. Both run inside one request and
                refuse a batch too large to finish, so neither needs a queue yet. */}
            <div className="space-y-3 mb-6 pb-6 border-b border-border-card">
              <SourceProspectsButton
                organisationId={org.organisation_id}
                maxBatchSize={sourcingMaxBatchSize}
              />
              <ResearchProspectsButton
                organisationId={org.organisation_id}
                unresearchedCount={org.unresearched_count}
              />
            </div>

            {/* Action buttons */}
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {org.pending_review_count > 0 && (
                  <Link
                    href={`/dashboard/operator/sourcing-review/approve?client=${org.organisation_id}`}
                    className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors"
                  >
                    Review pending
                  </Link>
                )}

                {org.approved_unenriched_count > 0 && (
                  <>
                    <EnrichAndTierButton organisationId={org.organisation_id} />
                  </>
                )}

                {enrichedCount > 0 && (
                  <Link
                    href={`/dashboard/operator/sourcing-review/review?client=${org.organisation_id}`}
                    className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors"
                  >
                    Review quality
                  </Link>
                )}

                {org.pending_review_count === 0 && org.approved_unenriched_count === 0 && enrichedCount === 0 && (
                  <span className="text-xs text-text-secondary">No prospects to review.</span>
                )}
              </div>

              {/* Spend & dormant warning */}
              {org.approved_unenriched_count > 0 && (
                <div className="text-xs text-[#7A4800] bg-[#FEF7E6] px-3 py-2 rounded-[6px] border border-[#F0D080]">
                  <p className="font-medium mb-0.5">Enrich and tier will consume Apollo credits</p>
                  <p>Currently in test mode. No live API calls will be made yet.</p>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
