// Empty queue state — per design.md, never blank. Forward-looking, specific, warm.

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
      <div className="w-10 h-10 rounded-full bg-[#EBF5E6] border border-[#BDDAB0] flex items-center justify-center mb-5">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M9 1.5C4.86 1.5 1.5 4.86 1.5 9s3.36 7.5 7.5 7.5 7.5-3.36 7.5-7.5S13.14 1.5 9 1.5Zm.75 11.25h-1.5v-1.5h1.5v1.5Zm0-3h-1.5V5.25h1.5v4.5Z"
            fill="#3B6D11"
          />
        </svg>
      </div>
      <p className="text-[14px] font-medium text-text-primary mb-1.5">Queue is clear</p>
      <p className="text-[12px] text-text-secondary leading-relaxed max-w-[320px]">
        New replies will appear here as prospects respond. The queue refreshes every 30 seconds.
      </p>
    </div>
  )
}
