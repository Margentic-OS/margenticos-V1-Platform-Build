'use client'

import type { AllCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

interface CampaignMetricsPanelProps {
  metrics: AllCampaignMetrics
}

function fmt(n: number): string {
  return n.toLocaleString()
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`
}

export function CampaignMetricsPanel({ metrics }: CampaignMetricsPanelProps) {
  const { sentCount, repliedCount, replyRate, positiveReplyCount, meetingCount, bouncedCount, hasData } = metrics

  if (!hasData) {
    return (
      <div className="bg-surface-default rounded-[10px] p-5 border border-border-subtle">
        <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-secondary-text mb-2">
          Campaign metrics
        </p>
        <p className="text-[12px] text-secondary-text">
          Metrics will appear once campaigns are live.
        </p>
      </div>
    )
  }

  const bounceRate = sentCount > 0 ? (bouncedCount / sentCount) * 100 : 0

  return (
    <div className="bg-surface-default rounded-[10px] p-5 border border-border-subtle space-y-4">
      <div>
        <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-secondary-text mb-3">
          Campaign metrics
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Sent */}
        <div>
          <p className="text-[11px] text-secondary-text mb-1">Sent</p>
          <p className="text-[16px] font-medium text-primary-text">{fmt(sentCount)}</p>
        </div>

        {/* Replied */}
        <div>
          <p className="text-[11px] text-secondary-text mb-1">Replied</p>
          <p className="text-[16px] font-medium text-primary-text">
            {fmt(repliedCount)} {replyRate !== null && <span className="text-[12px] text-accent-blue">({fmtPct(replyRate)})</span>}
          </p>
        </div>

        {/* Bounced */}
        <div>
          <p className="text-[11px] text-secondary-text mb-1">Bounced</p>
          <p className="text-[16px] font-medium text-primary-text">
            {fmt(bouncedCount)} {sentCount > 0 && <span className="text-[12px] text-accent-orange">({fmtPct(bounceRate)})</span>}
          </p>
        </div>

        {/* Positive replies */}
        <div>
          <p className="text-[11px] text-secondary-text mb-1">Positive</p>
          <p className="text-[16px] font-medium text-primary-text">{fmt(positiveReplyCount)}</p>
        </div>

        {/* Meetings */}
        <div>
          <p className="text-[11px] text-secondary-text mb-1">Meetings</p>
          <p className="text-[16px] font-medium text-primary-text">{fmt(meetingCount)}</p>
        </div>
      </div>

      {bounceRate > 2 && (
        <div className="mt-3 p-2.5 bg-warning-bg rounded-[6px] border border-warning-border">
          <p className="text-[11px] text-warning-text">
            Bounce rate above 2%. Monitor deliverability if sustained.
          </p>
        </div>
      )}
    </div>
  )
}
