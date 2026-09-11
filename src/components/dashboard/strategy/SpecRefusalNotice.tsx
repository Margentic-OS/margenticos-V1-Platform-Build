import type { OperatorSpecStatus } from '@/lib/sourcing/spec-refusal'

// Shown to an OPERATOR on the ICP when this version cannot be used for sourcing.
//
// WHY IT EXISTS. A revision, an approval, a revert and the auto-approve sweep all promote a new
// ICP and THEN build its search specification in the background, after the reply has gone. When
// that build refused, the page reported the change as a success, the document looked finished,
// and the only record of the refusal was a Sentry event. Measured 2026-09-08 on one live client:
// three versions in a row went live with no specification, each reported as a success, and the
// operator found out by reading logs.
//
// TWO STATES, and the second matters as much as the first:
//   refused     the build ran and said no. Names the cause and quotes it.
//   not built   there is no specification and no refusal. Straight after a change that is the
//               build still running; if it lasts, the build never ran. Either way it is not a
//               pass, and showing nothing would make it look like one.
//
// OPERATOR ONLY, for the same reason as StaleDocumentNotice: the detail is written for the person
// who can fix it.

interface Props {
  status: OperatorSpecStatus
}

export function SpecRefusalNotice({ status }: Props) {
  if (status.kind === 'usable') return null

  if (status.kind === 'not_built') {
    return (
      <div
        role="status"
        className="mb-4 bg-[#F5F2ED] border border-[#E8E3DC] rounded-[8px] px-4 py-3 print:hidden"
      >
        <p className="text-[11px] font-medium text-text-secondary mb-1">
          Search specification not built yet
        </p>
        <p className="text-[12px] text-text-primary leading-relaxed">
          This version is live, but the search specification sourcing needs has not been built.
          It is built in the background after every change and usually takes under a minute, so
          refresh to check. If this is still here after a few minutes, the build did not run.
        </p>
      </div>
    )
  }

  return (
    <div
      role="alert"
      className="mb-4 bg-[#FDF0EC] border border-[#F0C4B4] rounded-[8px] px-4 py-3 print:hidden"
    >
      <p className="text-[11px] font-medium text-[#8A2E12] mb-1">
        Sourcing cannot use this version
      </p>
      <p className="text-[12px] text-text-primary leading-relaxed">{status.label}</p>
      {status.detail && (
        <p className="mt-2 text-[11px] text-text-secondary leading-relaxed break-words">
          {status.detail}
        </p>
      )}
      <p className="mt-2 text-[11px] text-text-secondary leading-relaxed">
        The document itself is live. Fix it with a revision, or restore an earlier version from
        the history below, and the specification is rebuilt.
      </p>
    </div>
  )
}
