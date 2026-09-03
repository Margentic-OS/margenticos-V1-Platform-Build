import { RegenerateButton } from './RegenerateButton'

// Shown to an OPERATOR when this document was written before the latest version of a
// document it is built from.
//
// OPERATOR ONLY, on purpose. "May need regenerating" is a statement about our confidence
// in our own work, and a client reading it about copy that is currently going out to
// their prospects learns only that we are unsure. The operator's job is to look, decide,
// and either regenerate or leave it. This is that prompt.
//
// It never says the document is wrong. The flag is set by a dependency, not by anything
// that read the content, so it cannot know whether the upstream change was relevant.

interface Props {
  reason: string
  clientId: string
  docType: string
}

export function StaleDocumentNotice({ reason, clientId, docType }: Props) {
  return (
    <div className="mb-4 bg-[#F5F2ED] border border-[#E8E3DC] rounded-[8px] px-4 py-3 print:hidden">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-text-secondary mb-1">
            Built from an older version of another document
          </p>
          <p className="text-[12px] text-text-primary leading-relaxed">{reason}</p>
        </div>
        <div className="shrink-0">
          <RegenerateButton clientId={clientId} docType={docType} />
        </div>
      </div>
    </div>
  )
}
