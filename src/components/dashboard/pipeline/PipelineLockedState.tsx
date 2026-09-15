// ── The locked state ─────────────────────────────────────────────────────────
//
// THIS SCREEN USED TO PROMISE A RULE THAT DID NOT EXIST. It said the pipeline "unlocks
// after your first 5 meetings or two months of sending, whichever comes first" and drew a
// progress bar toward five. organisations.pipeline_unlocked was read in 30 places and
// WRITTEN IN NONE: no cron, no trigger, no control. The bar could fill to 5 of 5 and the
// screen would stay locked for ever, and the client would have been told, in writing, that
// it would not.
//
// An operator now opens it, from the settings screen, and the copy below says only what is
// true. The meeting count stays because it is real; the denominator and the two-month date
// are gone because they were the promise. ADR-008's automatic rule is deliberately NOT
// implemented here: see the Backlog.

export function PipelineLockedState({ meetingCount }: { meetingCount: number }) {
  const meetingsLine =
    meetingCount === 0
      ? 'No meetings booked yet'
      : `${meetingCount} meeting${meetingCount === 1 ? '' : 's'} booked so far`

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-7 max-w-[640px]">
        <div className="bg-brand-green rounded-[10px] p-6">
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-[rgba(245,240,232,0.40)] mb-3">
            Pipeline
          </p>
          <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
            Your pipeline view is not open yet
          </h2>
          <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
            We open it once your campaigns are booking meetings steadily, so that what you
            see here is a trend rather than a handful of early results. There is nothing for
            you to do. It will appear as soon as we switch it on.
          </p>

          <div className="flex items-center justify-between">
            <span className="text-[10px] font-normal text-[rgba(245,240,232,0.45)]">
              Meetings
            </span>
            <span className="text-[10px] font-medium text-[rgba(245,240,232,0.65)]">
              {meetingsLine}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
