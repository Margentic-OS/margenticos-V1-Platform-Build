interface PipelineApprovalBannerProps {
  pendingCount: number
}

export function PipelineApprovalBanner({ pendingCount }: PipelineApprovalBannerProps) {
  if (pendingCount === 0) return null

  const label =
    pendingCount === 1
      ? '1 suggestion waiting for your review'
      : `${pendingCount} suggestions waiting for your review`

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-[8px] bg-[#FEF7E6] border border-[#F0D080]">
      <div className="flex items-center gap-2.5">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
        <p className="text-[12px] text-[#7A4800]">{label}</p>
      </div>
      <a
        href="/dashboard/approvals"
        className="text-[11px] font-medium text-[#7A4800] bg-[rgba(122,72,0,0.07)] border border-[#F0D080] px-3 py-1 rounded-[6px] hover:bg-[rgba(122,72,0,0.12)] transition-colors shrink-0"
      >
        Review now
      </a>
    </div>
  )
}
