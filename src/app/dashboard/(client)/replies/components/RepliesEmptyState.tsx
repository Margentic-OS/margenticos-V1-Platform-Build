'use client'

export function RepliesEmptyState({ outreachStarted }: { outreachStarted: boolean }) {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-8 text-center">
      <p className="text-[13px] text-text-primary mb-1">
        {outreachStarted ? 'No interested replies yet' : 'No replies yet'}
      </p>
      <p className="text-[12px] text-text-secondary max-w-[420px] mx-auto leading-relaxed">
        {outreachStarted
          // Emails are already out. "Once your campaigns launch" was the same untruth the
          // overview was telling, and it would be a stranger one here: this page exists
          // because replies are being received and handled.
          ? 'Your sequence is running. When a prospect replies with interest, their reply will appear here along with anything sent back on your behalf.'
          : 'When a prospect replies with interest, their reply will appear here along with anything sent back on your behalf.'}
      </p>
    </div>
  )
}
