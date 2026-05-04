// Skeleton placeholder matching the DraftCard layout — used during initial load only.
// Per design.md: skeleton screens, never spinners in the main content area.

export function DraftCardSkeleton() {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-[22px] animate-pulse">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="flex flex-col gap-2">
          <div className="h-3.5 w-36 bg-[#F0ECE4] rounded-[4px]" />
          <div className="h-3 w-24 bg-[#F0ECE4] rounded-[4px]" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-5 w-24 bg-[#F0ECE4] rounded-full" />
          <div className="h-5 w-28 bg-[#F0ECE4] rounded-full" />
        </div>
      </div>

      {/* Reply section */}
      <div className="mb-4">
        <div className="h-3 w-24 bg-[#F0ECE4] rounded-[4px] mb-2" />
        <div className="h-16 w-full bg-[#F0ECE4] rounded-[6px]" />
      </div>

      {/* Draft section */}
      <div className="mb-5">
        <div className="h-3 w-20 bg-[#F0ECE4] rounded-[4px] mb-2" />
        <div className="h-24 w-full bg-[#F0ECE4] rounded-[6px]" />
      </div>

      {/* Action row */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-20 bg-[#F0ECE4] rounded-[6px]" />
        <div className="h-8 w-32 bg-[#F0ECE4] rounded-[6px]" />
      </div>
    </div>
  )
}
