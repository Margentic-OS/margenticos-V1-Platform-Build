export function ExtractionCardSkeleton() {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-[22px] animate-pulse">
      <div className="flex items-start justify-between mb-4">
        <div className="flex flex-col gap-1.5">
          <div className="h-2.5 w-24 bg-[#E8E2D8] rounded" />
          <div className="h-2 w-16 bg-[#E8E2D8] rounded" />
        </div>
        <div className="h-2 w-12 bg-[#E8E2D8] rounded" />
      </div>
      <div className="flex flex-col gap-4 mb-5">
        <div>
          <div className="h-2 w-28 bg-[#E8E2D8] rounded mb-2" />
          <div className="h-10 w-full bg-[#F0EBE3] rounded-[6px]" />
        </div>
        <div>
          <div className="h-2 w-28 bg-[#E8E2D8] rounded mb-2" />
          <div className="h-16 w-full bg-[#F0EBE3] rounded-[6px]" />
        </div>
      </div>
      <div className="flex justify-between">
        <div className="h-7 w-16 bg-[#E8E2D8] rounded-[6px]" />
        <div className="h-7 w-36 bg-[#E8E2D8] rounded-[6px]" />
      </div>
    </div>
  )
}
