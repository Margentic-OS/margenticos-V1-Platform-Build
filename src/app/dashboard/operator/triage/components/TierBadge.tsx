// Small badge identifying Tier 2 (AI draft) vs Tier 3 (starting-point, needs rewrite).
// Visual distinction is a hard spec requirement — never style these identically.

interface TierBadgeProps {
  tier: 2 | 3
}

export function TierBadge({ tier }: TierBadgeProps) {
  if (tier === 2) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#EBF5E6] border border-[#BDDAB0]">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-green-success shrink-0" />
        <span className="text-[10px] font-medium text-[#2B5A1E] leading-none">Tier 2 — AI draft</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FEF7E6] border border-[#F0D080]">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
      <span className="text-[10px] font-medium text-[#7A4800] leading-none">Tier 3 — needs rewrite</span>
    </span>
  )
}
