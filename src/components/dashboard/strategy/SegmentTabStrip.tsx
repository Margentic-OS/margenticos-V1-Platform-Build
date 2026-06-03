'use client'

import Link from 'next/link'
import { useSearchParams, usePathname } from 'next/navigation'
import { buildStrategyParams } from '@/lib/dashboard/client-param'

export interface SegmentTab {
  id: string
  name: string
  is_default: boolean
}

interface SegmentTabStripProps {
  segments: SegmentTab[]
  selectedSegmentId: string
}

const MAX_LABEL_LEN = 26

function truncate(name: string): string {
  return name.length > MAX_LABEL_LEN ? `${name.slice(0, MAX_LABEL_LEN - 1)}…` : name
}

export function SegmentTabStrip({ segments, selectedSegmentId }: SegmentTabStripProps) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const clientParam = searchParams.get('client')

  if (segments.length <= 1) return null

  return (
    <div className="flex gap-0 border-b border-border-card mb-6 print:hidden">
      {segments.map(seg => {
        const href = pathname + buildStrategyParams({ clientParam, segmentId: seg.id, isDefaultSegment: seg.is_default })
        const isActive = seg.id === selectedSegmentId
        return (
          <Link
            key={seg.id}
            href={href}
            className={[
              'px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
              isActive
                ? 'border-brand-green text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {truncate(seg.name)}
          </Link>
        )
      })}
    </div>
  )
}
