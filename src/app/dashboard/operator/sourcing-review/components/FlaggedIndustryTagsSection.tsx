'use client'

import { useState, useMemo, useTransition } from 'react'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

type Prospect = Database['public']['Tables']['prospects']['Row']

interface FlaggedIndustryTagsSectionProps {
  prospects: Prospect[]
  canonicalIndustries: string[]
}

const CANONICAL_INDUSTRIES = [
  'Business Coaching',
  'Change Management Consulting',
  'Compliance Consulting',
  'Data Analytics Consulting',
  'Executive Coaching',
  'Financial Advisory Services',
  'Human Resources Consulting',
  'Information Technology Consulting',
  'Management Consulting',
  'Marketing Consulting',
  'Operations Consulting',
  'Organizational Development',
  'Procurement Consulting',
  'Risk Management Consulting',
  'Sales Consulting',
  'Strategy Consulting',
  'Supply Chain Consulting',
]

async function mapIndustryTag(
  apolloTag: string,
  canonicalIndustry: string,
): Promise<{ success: boolean; reTieredCount?: number; error?: string }> {
  try {
    const response = await fetch('/api/operator/industry-tag-mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apollo_tag: apolloTag,
        canonical_industry: canonicalIndustry,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      return { success: false, error: error.error || 'Failed to map tag' }
    }

    const result = await response.json()
    return {
      success: true,
      reTieredCount: result.prospects_retiered,
    }
  } catch (error) {
    logger.error('Error mapping industry tag', { error })
    return { success: false, error: 'Network error' }
  }
}

async function approveProspectForClient(
  prospectId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch('/api/operator/prospects/override-tier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prospect_id: prospectId,
        tier: 'tier_1',
        reason: 'Approved by operator - mis-tagged prospect',
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      return { success: false, error: error.error || 'Failed to approve prospect' }
    }

    return { success: true }
  } catch (error) {
    logger.error('Error approving prospect', { error })
    return { success: false, error: 'Network error' }
  }
}

function TagGroup({
  apolloTag,
  prospects,
  canonicalIndustries,
}: {
  apolloTag: string
  prospects: Prospect[]
  canonicalIndustries: string[]
}) {
  const [, startTransition] = useTransition()
  const [selectedIndustry, setSelectedIndustry] = useState<string>('')
  const [mapping, setMapping] = useState<{ loading: boolean; error: string | null; success: boolean }>({
    loading: false,
    error: null,
    success: false,
  })

  const handleMap = () => {
    if (!selectedIndustry) {
      setMapping({ loading: false, error: 'Please select a canonical industry', success: false })
      return
    }

    setMapping({ loading: true, error: null, success: false })
    startTransition(async () => {
      const result = await mapIndustryTag(apolloTag, selectedIndustry)
      if (result.success) {
        setMapping({ loading: false, error: null, success: true })
        // Reset after 3 seconds
        setTimeout(() => {
          setMapping({ loading: false, error: null, success: false })
          setSelectedIndustry('')
        }, 3000)
      } else {
        setMapping({ loading: false, error: result.error || 'Failed to map tag', success: false })
      }
    })
  }

  return (
    <div className="bg-white rounded-[10px] border border-border-card p-4">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h4 className="font-medium text-text-primary mb-1">Source tag: {apolloTag}</h4>
          <p className="text-xs text-text-secondary">{prospects.length} prospect{prospects.length !== 1 ? 's' : ''} with this tag</p>
        </div>
      </div>

      <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[6px] p-3 mb-4">
        <p className="text-xs text-[#7A4800] mb-3">
          Unmapped tags never reach clients. Map this tag only if it belongs to a canonical consulting industry.
        </p>

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label htmlFor={`industry-${apolloTag}`} className="block text-xs font-medium text-text-primary mb-2">
              Map to canonical industry
            </label>
            <select
              id={`industry-${apolloTag}`}
              value={selectedIndustry}
              onChange={(e) => setSelectedIndustry(e.target.value)}
              disabled={mapping.loading}
              className="w-full px-3 py-2 text-xs border border-border-input rounded-[6px] focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="">Select an industry...</option>
              {canonicalIndustries.map((industry) => (
                <option key={industry} value={industry}>
                  {industry}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleMap}
            disabled={mapping.loading || !selectedIndustry}
            className="px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-[6px] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mapping.loading ? 'Mapping...' : 'Map tag'}
          </button>
        </div>

        {mapping.error && (
          <div className="mt-2 px-2 py-1 rounded-[4px] bg-[#FDEEE8] border border-[#EFBCAA]">
            <p className="text-xs text-[#8B2020]">{mapping.error}</p>
          </div>
        )}

        {mapping.success && (
          <div className="mt-2 px-2 py-1 rounded-[4px] bg-[#EBF5E6] border border-[#BDDAB0]">
            <p className="text-xs text-[#3B6D11]">Tag mapped successfully. Re-tiered {mapping.error || 'prospects'}.</p>
          </div>
        )}
      </div>

      {/* Prospect list */}
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-text-secondary hover:text-text-primary mb-2">
          Show {prospects.length} prospect{prospects.length !== 1 ? 's' : ''} with this tag
        </summary>
        <div className="mt-3 space-y-2">
          {prospects.slice(0, 10).map((prospect) => (
            <ProspectApproveRow key={prospect.id} prospect={prospect} />
          ))}
          {prospects.length > 10 && (
            <p className="text-xs text-text-secondary italic px-3 py-2">
              ... and {prospects.length - 10} more
            </p>
          )}
        </div>
      </details>
    </div>
  )
}

function ProspectApproveRow({ prospect }: { prospect: Prospect }) {
  const [, startTransition] = useTransition()
  const [approving, setApproving] = useState(false)
  const [approved, setApproved] = useState(false)

  const handleApprove = () => {
    setApproving(true)
    startTransition(async () => {
      const result = await approveProspectForClient(prospect.id)
      if (result.success) {
        setApproved(true)
      } else {
        setApproving(false)
      }
    })
  }

  if (approved) {
    return (
      <div className="px-3 py-2 bg-[#EBF5E6] rounded-[6px] text-xs border border-[#BDDAB0]">
        <p className="font-medium text-[#3B6D11]">✓ Approved for client list</p>
        <p className="text-[#3B6D11]">{prospect.first_name} {prospect.last_name}</p>
      </div>
    )
  }

  return (
    <div className="px-3 py-2 bg-[#F8F4EE] rounded-[6px] text-xs border border-[#E8E2D8] flex items-start justify-between gap-2">
      <div className="flex-1">
        <p className="font-medium text-text-primary">
          {prospect.first_name} {prospect.last_name}
        </p>
        <p className="text-text-secondary">{prospect.email}</p>
        <p className="text-text-secondary">{prospect.company_name || 'Unknown company'}</p>
      </div>
      <button
        onClick={handleApprove}
        disabled={approving}
        className="px-2 py-1 text-xs font-medium bg-blue-600 text-white rounded-[4px] hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap mt-1 flex-shrink-0"
      >
        {approving ? 'Approving...' : 'Approve'}
      </button>
    </div>
  )
}

export function FlaggedIndustryTagsSection({ prospects }: FlaggedIndustryTagsSectionProps) {
  // Group flagged prospects by the sourcing tool's own industry tag.
  //
  // THE PROP AND VARIABLE NAMES STILL CARRY THE VENDOR NAME; THE VISIBLE COPY NO LONGER
  // DOES. The rendered strings were changed because a tool name must not reach a label.
  // The identifiers were left because renaming them is a wider change through the handler
  // that produces them, and doing it inside a UI pass would bury it. Noted here rather
  // than left to be discovered.
  const groupedByTag = useMemo(() => {
    const groups: Record<string, Prospect[]> = {}

    for (const prospect of prospects) {
      if (prospect.company_industry) {
        if (!groups[prospect.company_industry]) {
          groups[prospect.company_industry] = []
        }
        groups[prospect.company_industry].push(prospect)
      }
    }

    return groups
  }, [prospects])

  const tagsByCount = Object.entries(groupedByTag).sort(([, a], [, b]) => b.length - a.length)

  if (tagsByCount.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6">
        <h3 className="font-medium text-[#7A4800] mb-2">Industry tags needing mapping</h3>
        <p className="text-xs text-[#7A4800]">
          {Object.values(groupedByTag).reduce((sum, group) => sum + group.length, 0)} prospects from {tagsByCount.length}{' '}
          unmapped source tag{tagsByCount.length !== 1 ? 's' : ''}. Map each tag to teach the system about new industries.
        </p>
      </div>

      <div className="space-y-3">
        {tagsByCount.map(([tag, tagProspects]) => (
          <TagGroup
            key={tag}
            apolloTag={tag}
            prospects={tagProspects}
            canonicalIndustries={CANONICAL_INDUSTRIES}
          />
        ))}
      </div>
    </div>
  )
}
