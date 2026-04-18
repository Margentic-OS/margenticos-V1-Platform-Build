'use client'

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="print:hidden flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M3 1h6v3H3V1ZM1 4h10a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H9v1H3v-1H1a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 5h6v2H3V9Z"
          fill="currentColor"
        />
      </svg>
      Save as PDF
    </button>
  )
}
