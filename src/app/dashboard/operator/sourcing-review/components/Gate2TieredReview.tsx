'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import type { Database } from '@/types/database'

type Prospect = Database['public']['Tables']['prospects']['Row']

interface Gate2TieredReviewProps {
  prospects: Prospect[]
  organisationId: string
  organisationName: string
  tiering: {
    tier_1: Prospect[]
    tier_2: Prospect[]
    tier_3: Prospect[]
  }
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
  return (
    <tr className="hover:bg-[#FAFAF8] transition-colors">
      <td className="px-4 py-3 text-text-primary font-medium">
        {prospect.first_name} {prospect.last_name}
      </td>
      <td className="px-4 py-3 text-text-secondary font-mono text-xs">{prospect.email}</td>
      <td className="px-4 py-3 text-text-primary">{prospect.company_name || '—'}</td>
      <td className="px-4 py-3 text-text-secondary">{prospect.job_title || 'Pending enrichment'}</td>
      <td className="px-4 py-3 text-text-secondary">
        {prospect.company_headcount ? `${prospect.company_headcount} people` : 'Pending enrichment'}
      </td>
      <td className="px-4 py-3 text-text-secondary">{prospect.company_industry || 'Pending enrichment'}</td>
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
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-[#FAFAF8] transition-colors border-b border-[#E8E2D8]"
      >
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <h3 className={`font-medium ${config.textColor}`}>{config.label}</h3>
          <span className={`text-xs font-medium px-2 py-1 rounded-sm ${config.bgColor} ${config.textColor} ${config.borderColor ? `border ${config.borderColor}` : ''}`}>
            {prospects.length} prospects
          </span>
        </div>
      </button>

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
}: Gate2TieredReviewProps) {
  const totalEnriched = tiering.tier_1.length + tiering.tier_2.length + tiering.tier_3.length

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="bg-white rounded-[10px] border border-border-card p-6">
        <h2 className="text-base font-medium text-text-primary mb-4">
          Quality review: {totalEnriched} enriched prospects
        </h2>

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

      {totalEnriched === 0 && (
        <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
          <p className="text-sm text-[#7A4800]">No enriched prospects yet. Run the enrich-and-tier action to proceed.</p>
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
