'use client'

import type { ClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

interface ClientCampaignMetricsViewProps {
  metrics: ClientVisibleCampaignMetrics
}

function fmt(n: number): string {
  return n.toLocaleString()
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`
}

export function ClientCampaignMetricsView({ metrics }: ClientCampaignMetricsViewProps) {
  const { sentCount, repliedCount, replyRate, positiveReplyCount, meetingsBooked, hasData } = metrics

  // Note: openCount will be added once the open_count column is added to campaigns table

  if (!hasData) {
    return (
      <div className="bg-surface-default rounded-[10px] p-6 border border-border-subtle">
        <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-secondary-text mb-2">
          Campaign health
        </p>
        <h2 className="text-[16px] font-medium text-primary-text mb-3">
          Waiting for your first campaign
        </h2>
        <p className="text-[12px] text-secondary-text leading-relaxed">
          Once your first emails go out, you'll see campaign health metrics here: reply rates, meeting bookings, and engagement trends.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {/* Emails sent */}
        <div className="bg-surface-default rounded-[10px] p-5 border border-border-subtle">
          <p className="text-[10px] uppercase tracking-widest text-secondary-text mb-2">
            Emails sent
          </p>
          <p className="text-[28px] font-medium text-primary-text">
            {fmt(sentCount)}
          </p>
          <p className="text-[11px] text-secondary-text mt-1">
            Total campaign volume
          </p>
        </div>

        {/* Replies received */}
        <div className="bg-surface-default rounded-[10px] p-5 border border-border-subtle">
          <p className="text-[10px] uppercase tracking-widest text-secondary-text mb-2">
            Replies received
          </p>
          <p className="text-[28px] font-medium text-primary-text">
            {fmt(repliedCount)} {replyRate !== null && <span className="text-[16px] text-accent-blue">({fmtPct(replyRate)})</span>}
          </p>
          <p className="text-[11px] text-secondary-text mt-1">
            Prospects engaging with your message
          </p>
        </div>

        {/* Positive replies */}
        <div className="bg-surface-default rounded-[10px] p-5 border border-border-subtle">
          <p className="text-[10px] uppercase tracking-widest text-secondary-text mb-2">
            Positive replies
          </p>
          <p className="text-[28px] font-medium text-primary-text">
            {fmt(positiveReplyCount)}
          </p>
          <p className="text-[11px] text-secondary-text mt-1">
            Interested prospects
          </p>
        </div>

        {/* Meetings booked */}
        <div className="bg-surface-default rounded-[10px] p-5 border border-border-subtle">
          <p className="text-[10px] uppercase tracking-widest text-secondary-text mb-2">
            Meetings booked
          </p>
          <p className="text-[28px] font-medium text-primary-text">
            {fmt(meetingsBooked)}
          </p>
          <p className="text-[11px] text-secondary-text mt-1">
            Qualified opportunities
          </p>
        </div>
      </div>

      <div className="px-1 pt-2 pb-1">
        <p className="text-[11px] text-text-secondary leading-relaxed">
          These metrics update automatically as your campaigns run. Focus on replies and meetings—they are the true indicators of campaign momentum.
        </p>
      </div>
    </div>
  )
}
