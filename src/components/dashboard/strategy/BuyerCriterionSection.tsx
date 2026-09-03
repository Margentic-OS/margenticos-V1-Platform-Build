import type {
  ClientBuyerCriterion,
  OperatorBuyerCriterion,
} from '@/lib/dashboard/buyer-criterion-view'

// Nested INSIDE the Prospect profile document, not on the Overview.
//
// A client with more than one prospect profile gets one criterion per profile, because
// the criterion is derived from that profile's documents. Rendering it here means that
// structure is already right and the multi-profile schema, which is additive, needs no
// retrofit on this component: it renders whichever document it is handed.
//
// RULE ZERO. Every string below is fixed copy. Nothing in this file names an industry, a
// sector, a country, a company or a job title, and none of it varies by client. The only
// client-specific text on screen is the statement and evidence, which come from that
// client's own approved document.

export function BuyerCriterionSection({
  criterion,
}: {
  criterion: ClientBuyerCriterion
}) {
  return (
    <section className="bg-surface-card border border-border-card rounded-[10px] p-5">
      <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
        Who we contact
      </h3>

      <p className="text-[13px] text-text-primary leading-[1.65]">
        {criterion.statement}
      </p>

      {criterion.evidence.length > 0 && (
        <div className="mt-5 pt-4 border-t border-border-card">
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
            What this is based on
          </p>
          <ul className="space-y-2">
            {criterion.evidence.map((item, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="w-1 h-1 rounded-full bg-brand-green-accent shrink-0 mt-[7px]" />
                <span className="text-[12px] text-text-secondary leading-[1.6]">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-text-muted mt-4 leading-relaxed">
        This is drawn from the documents above. It updates when they do.
      </p>
    </section>
  )
}

/**
 * Operator-only. Shows the matching terms and whether the client can see any of this.
 *
 * The terms are deliberately absent from the client view: a list of title words invites
 * the reader to treat it as an editable filter, which is the behaviour the statement
 * exists to replace. They are shown here because the operator is the person who has to
 * notice a missing spelling variant, which no automatic check catches.
 */
export function BuyerCriterionOperatorPanel({
  criterion,
}: {
  criterion: OperatorBuyerCriterion
}) {
  const gating = criterion.status === 'derived'

  return (
    <section className="bg-[#F7F5F0] border border-dashed border-border-card rounded-[10px] p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-[13px] font-medium text-text-primary">
          Buyer criterion — operator view
        </h3>
        <span className="text-[9px] font-medium text-text-secondary bg-[#F0ECE4] px-2 py-0.5 rounded-[4px] shrink-0">
          Not shown to the client
        </span>
      </div>

      <dl className="space-y-2 mb-4">
        <div className="flex gap-2">
          <dt className="text-[11px] text-text-secondary w-[130px] shrink-0">Status</dt>
          <dd className="text-[11px] text-text-primary">
            {criterion.status}
            {!gating && ' — not applied, enrichment runs unfiltered'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-[11px] text-text-secondary w-[130px] shrink-0">Client can see it</dt>
          <dd className="text-[11px] text-text-primary">
            {criterion.visibleToClient ? 'Yes' : 'No, the parent document is not approved or it is not in force'}
          </dd>
        </div>
        {criterion.sanityNote && (
          <div className="flex gap-2">
            <dt className="text-[11px] text-text-secondary w-[130px] shrink-0">Measured</dt>
            <dd className="text-[11px] text-text-primary">{criterion.sanityNote}</dd>
          </div>
        )}
        {criterion.unsettledReason && (
          <div className="flex gap-2">
            <dt className="text-[11px] text-text-secondary w-[130px] shrink-0">Unsettled</dt>
            <dd className="text-[11px] text-text-primary">{criterion.unsettledReason}</dd>
          </div>
        )}
      </dl>

      {criterion.accept.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Matches</p>
          <div className="flex flex-wrap gap-1.5">
            {criterion.accept.map(entry => (
              <span
                key={`${entry.rank}:${entry.fragment}`}
                className="text-[11px] text-text-primary bg-white border border-border-card rounded-[4px] px-2 py-0.5"
              >
                {entry.fragment}
                <span className="text-text-muted"> · {entry.rank}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {criterion.reject.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Excludes</p>
          <div className="flex flex-wrap gap-1.5">
            {criterion.reject.map(fragment => (
              <span
                key={fragment}
                className="text-[11px] text-text-secondary bg-white border border-border-card rounded-[4px] px-2 py-0.5"
              >
                {fragment}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
