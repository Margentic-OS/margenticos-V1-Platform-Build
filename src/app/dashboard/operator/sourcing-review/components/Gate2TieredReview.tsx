'use client'

import { useState, useMemo, useTransition } from 'react'
import Link from 'next/link'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { normalizeUrl } from '@/lib/url/normalize'

type Prospect = Database['public']['Tables']['prospects']['Row']

async function publishAllTiersForClient(organisationId: string) {
  const response = await fetch(`/api/operator/organisations/${organisationId}/publish-all-tiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to publish prospects')
  }

  return response.json()
}

interface Gate2TieredReviewProps {
  prospects: Prospect[]
  organisationId: string
  organisationName: string
  tiering: {
    tier_1: Prospect[]
    tier_2: Prospect[]
    tier_3: Prospect[]
  }
  /** tiering_reason -> count, for the prospects tiering removed. Counted server-side. */
  removedByReason: Record<string, number>
  removedCount: number
}

// Plain-English gloss for each removal reason the classifier writes. A reason with
// no entry here still renders, under its raw code: an unglossed reason must show up
// as an odd-looking row rather than vanish, because a reason this map has not caught
// up with is exactly the one worth seeing.
const REMOVAL_REASON_LABELS: Record<string, string> = {
  email_unverified: 'Email not verified',
  no_title: 'No job title',
  not_decision_maker: 'Not a decision-maker',
  company_too_large: 'Company over 100 people',
  industry_excluded: 'Industry excluded by the ICP',
  industry_not_consulting: 'Industry off-specification',
}

const tierConfig = {
  tier_1: {
    label: 'Tier 1: Best fit',
    textColor: 'text-[#3B6D11]',
    bgColor: 'bg-[#EBF5E6]',
    borderColor: 'border-[#BDDAB0]',
    description: 'Verified email, seniority, headcount, industry match.',
  },
  tier_2: {
    label: 'Tier 2: Good fit',
    textColor: 'text-[#5D7F23]',
    bgColor: 'bg-[#EAF3DE]',
    borderColor: 'border-[#C0DD97]',
    description: 'Verified email, seniority, one or more relaxed firmographics.',
  },
  tier_3: {
    label: 'Tier 3: Acceptable',
    textColor: 'text-[#9A9488]',
    bgColor: 'bg-[#F0ECE4]',
    borderColor: '',
    description: 'Verified email, seniority, significantly relaxed fit.',
  },
}

function ProspectRow({ prospect }: { prospect: Prospect }) {
  const headcountText = prospect.company_headcount
    ? `${prospect.company_headcount} ${prospect.company_headcount === 1 ? 'person' : 'people'}`
    : 'Pending enrichment'

  return (
    <tr className="hover:bg-[#FAFAF8] transition-colors">
      <td className="px-4 py-3 text-text-primary font-medium">
        {prospect.first_name} {prospect.last_name}
      </td>
      <td className="px-4 py-3 text-text-secondary font-mono text-xs max-w-[180px] truncate" title={prospect.email || undefined}>
        {prospect.email}
      </td>
      <td className="px-4 py-3 text-text-primary">{prospect.company_name || '—'}</td>
      <td className="px-4 py-3 text-text-secondary">{prospect.job_title || 'Pending enrichment'}</td>
      <td className="px-4 py-3 text-text-secondary">{headcountText}</td>
      <td className="px-4 py-3 text-text-secondary">{prospect.company_industry || 'Pending enrichment'}</td>
      <td className="px-4 py-3">
        {prospect.linkedin_url ? (
          <a
            href={normalizeUrl(prospect.linkedin_url) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline text-xs font-medium"
          >
            Profile →
          </a>
        ) : (
          <span className="text-text-secondary text-xs">Not enriched</span>
        )}
      </td>
      <td className="px-4 py-3">
        {prospect.website_url ? (
          <a
            href={normalizeUrl(prospect.website_url) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline text-xs font-medium"
          >
            Website →
          </a>
        ) : (
          <span className="text-text-secondary text-xs italic">not enriched</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs max-w-[140px] truncate" title={prospect.tiering_reason || undefined}>
        {prospect.tiering_reason ? (
          <span className="text-text-secondary">{prospect.tiering_reason}</span>
        ) : (
          <span className="text-text-secondary text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {prospect.email_status === 'verified' ? (
          <span className="inline-block px-2 py-0.5 rounded-sm text-xs font-medium bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]">
            Verified
          </span>
        ) : (
          <span className="text-text-secondary text-xs">{prospect.email_status || 'unknown'}</span>
        )}
      </td>
    </tr>
  )
}

function TierSection({
  tier,
  prospects,
  config,
}: {
  tier: string
  prospects: Prospect[]
  config: (typeof tierConfig)['tier_1']
}) {
  const [expanded, setExpanded] = useState(tier === 'tier_1')
  const [showAll, setShowAll] = useState(false)

  const displayed = showAll ? prospects : prospects.slice(0, 20)
  const hasMore = prospects.length > 20

  return (
    <div className="bg-white rounded-[10px] border border-border-card overflow-hidden">
      <div className="border-b border-[#E8E2D8]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-[#FAFAF8] transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-transform ${expanded ? 'rotate-90' : ''}`} />
            <h3 className={`font-medium ${config.textColor}`}>{config.label}</h3>
            <span className={`text-xs font-medium px-2 py-1 rounded-sm ${config.bgColor} ${config.textColor} ${config.borderColor ? `border ${config.borderColor}` : ''}`}>
              {prospects.length} prospects
            </span>
          </div>
        </button>
      </div>

      {expanded && (
        <div>
          <div className="px-6 py-3 bg-[#F0ECE4] text-xs text-text-secondary border-b border-[#E8E2D8]">
            {config.description}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#F8F4EE]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Email</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Company</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Job title</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Headcount</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Industry</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">LinkedIn</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Website</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Tier reason</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Email status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8E2D8]">
                {displayed.map((prospect) => (
                  <ProspectRow key={prospect.id} prospect={prospect} />
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-[#F8F4EE] transition-colors border-t border-[#E8E2D8]"
            >
              View all {prospects.length} prospects
            </button>
          )}

          {showAll && hasMore && (
            <button
              onClick={() => setShowAll(false)}
              className="w-full px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-[#F8F4EE] transition-colors border-t border-[#E8E2D8]"
            >
              Show top 20
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Gate2TieredReview({
  prospects: _prospects,
  organisationId,
  organisationName,
  tiering,
  removedByReason,
  removedCount,
}: Gate2TieredReviewProps) {
  const [, startTransition] = useTransition()
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishSuccess, setPublishSuccess] = useState(false)

  const totalEnriched = tiering.tier_1.length + tiering.tier_2.length + tiering.tier_3.length

  const handlePublishAll = () => {
    setPublishError(null)
    setPublishSuccess(false)
    startTransition(async () => {
      try {
        await publishAllTiersForClient(organisationId)
        setPublishSuccess(true)
      } catch (err) {
        setPublishError(err instanceof Error ? err.message : 'Failed to publish prospects')
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="bg-white rounded-[10px] border border-border-card p-6">
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-base font-medium text-text-primary">
            Quality review: {totalEnriched} enriched prospects
          </h2>
          <button
            onClick={handlePublishAll}
            disabled={publishSuccess || totalEnriched === 0}
            className="px-4 py-2 text-sm font-medium bg-[#2d5a27] text-[#f5f0e8] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {publishSuccess ? 'Published for client review' : 'Publish for client review'}
          </button>
        </div>

        {publishError && (
          <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA]">
            <p className="text-xs text-[#8B2020]">{publishError}</p>
          </div>
        )}

        {publishSuccess && (
          <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#EBF5E6] border border-[#BDDAB0]">
            <p className="text-xs text-[#3B6D11]">Published for client review. Client will receive an email.</p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div>
            <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#3B6D11] mb-1">
              Tier 1
            </p>
            <p className="text-2xl font-medium text-text-primary">{tiering.tier_1.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#5D7F23] mb-1">
              Tier 2
            </p>
            <p className="text-2xl font-medium text-text-primary">{tiering.tier_2.length}</p>
          </div>
          <div>
            <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#9A9488] mb-1">
              Tier 3
            </p>
            <p className="text-2xl font-medium text-text-primary">{tiering.tier_3.length}</p>
          </div>
        </div>

        <p className="text-xs text-text-secondary">
          Review a sample from each tier to verify fit. Tiering is based on ICP filter criteria: email verification, seniority, headcount, and industry match.
        </p>
      </div>

      {/* Removed before tiering.
          The three tier counts above are survivors. Without this block the screen
          reports a short list and gives no indication of what it is short OF, which
          is how a filter that removes most of a batch stays invisible. */}
      {removedCount > 0 && (
        <div className="bg-white rounded-[10px] border border-border-card p-6">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-base font-medium text-text-primary">
              {removedCount} removed before tiering
            </h2>
            <span className="text-xs text-text-secondary">
              Not shown in the tiers above
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {Object.entries(removedByReason)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <div key={reason} className="bg-[#FAEEDA] rounded-[8px] p-3 border border-[#F0D080]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#7A4800] mb-2">
                    {REMOVAL_REASON_LABELS[reason] ?? reason}
                  </p>
                  <p className="text-2xl font-medium text-text-primary">{count}</p>
                  <p className="text-xs text-text-secondary mt-1 font-mono">{reason}</p>
                </div>
              ))}
          </div>

          <p className="text-xs text-text-secondary mt-4">
            These prospects were enriched and then removed by the tiering disqualifiers. They are
            counted here rather than listed: the count is what tells you whether the filter is
            behaving, and a long list of rejects is not what this screen is for.
          </p>
        </div>
      )}

      {/* Tier sections */}
      <div className="space-y-4">
        {tiering.tier_1.length > 0 && (
          <TierSection tier="tier_1" prospects={tiering.tier_1} config={tierConfig.tier_1} />
        )}
        {tiering.tier_2.length > 0 && (
          <TierSection tier="tier_2" prospects={tiering.tier_2} config={tierConfig.tier_2} />
        )}
        {tiering.tier_3.length > 0 && (
          <TierSection tier="tier_3" prospects={tiering.tier_3} config={tierConfig.tier_3} />
        )}
      </div>

      {totalEnriched === 0 && removedCount === 0 && (
        <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
          <p className="text-sm text-[#7A4800]">No enriched prospects yet. Run the enrich-and-tier action to proceed.</p>
        </div>
      )}

      {/* Every prospect in the batch was removed. Previously this rendered as
          "No enriched prospects yet", which reads as "nothing has run" and is the
          opposite of what happened. */}
      {totalEnriched === 0 && removedCount > 0 && (
        <div className="bg-[#FDEEE8] rounded-[10px] border border-[#EFBCAA] p-6">
          <p className="text-sm text-[#8B2020]">
            All {removedCount} enriched prospects were removed by the tiering disqualifiers. None
            reached a tier. The breakdown above says which gate they went out on.
          </p>
        </div>
      )}

      {/* Back button */}
      <Link
        href={`/dashboard/operator/sourcing-review?client=${organisationId}`}
        className="inline-block px-4 py-2 rounded-[6px] bg-[#F0ECE4] text-text-primary font-medium text-sm hover:bg-[#E8E2D8] transition-colors"
      >
        Back to pipeline
      </Link>
    </div>
  )
}
