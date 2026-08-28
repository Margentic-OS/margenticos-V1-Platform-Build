import type { Json } from '@/types/database'
import type { IcpDocument, IcpTier } from '@/types'

// ─── Render-boundary coercion ────────────────────────────────────────────────
//
// The ICP agent has NO runtime schema validator. Between the model's JSON and the row
// stored in strategy_documents there are three steps (JSON.parse, scrubAITellsDeep,
// assertNoDashes) and not one of them checks that a key exists or has a type. So any
// field reaching this component may be a string, an object, a number, or absent, and
// TypeScript cannot see it because the document is cast from `Json`.
//
// Handing React an object throws "Objects are not valid as a React child" during the
// RENDER phase, which is AFTER the component function has returned. A try/catch around
// a render helper therefore does not catch it: ApprovalCard has exactly such a try/catch
// and it is ineffective for this class. An error boundary would catch it, but this is a
// server component, so the boundary would have to be a client component and the server
// render would fail first.
//
// Coercing at the boundary is what actually holds, and it degrades better than either:
// the reader sees the value instead of a blank section or a dead page.
function renderableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    // `trigger` is the existing IcpTrigger shape. `criterion` is the agreed shape for
    // structured disqualifiers, so that change cannot crash this view when it lands.
    for (const key of ['criterion', 'trigger']) {
      if (typeof o[key] === 'string') return o[key] as string
    }
    return JSON.stringify(value)
  }
  return String(value)
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
      {children}
    </h3>
  )
}

function FieldRow({ label, value }: { label: string; value: unknown }) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null

  // Coerce BEFORE React sees it. Everything below renders strings only.
  const items = Array.isArray(value)
    ? value.map(renderableText).filter((t): t is string => t !== null && t !== '')
    : null
  const single = items === null ? renderableText(value) : null

  if (items !== null && items.length === 0) return null
  if (items === null && !single) return null

  return (
    <div>
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
        {label}
      </p>
      {items !== null ? (
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-text-muted shrink-0 mt-0.5">·</span>
              <span className="text-[13px] text-text-primary leading-relaxed">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-text-primary leading-[1.65]">{single}</p>
      )}
    </div>
  )
}

function TierBlock({ tier, tierNum }: { tier: IcpTier; tierNum: 1 | 2 | 3 }) {
  const tierLabel =
    tierNum === 1
      ? 'Tier 1 — Primary target'
      : tierNum === 2
        ? 'Tier 2 — Secondary target'
        : 'Tier 3 — Opportunistic'

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
      <SectionHeading>{tierLabel}</SectionHeading>

      {tier.description && (
        <p className="text-[13px] text-text-primary leading-relaxed mb-5">{tier.description}</p>
      )}

      <div className="grid grid-cols-2 gap-5 mb-5">
        {/* Company profile */}
        <div className="space-y-3.5">
          <p className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em]">
            Company profile
          </p>
          <FieldRow label="Revenue" value={tier.company_profile?.revenue_range} />
          <FieldRow label="Headcount" value={tier.company_profile?.headcount} />
          <FieldRow label="Stage" value={tier.company_profile?.stage} />
          <FieldRow label="Industries" value={tier.company_profile?.industries} />
          <FieldRow label="Geography" value={tier.company_profile?.geography} />
          <FieldRow label="Business model" value={tier.company_profile?.business_model} />
        </div>

        {/* Buyer profile */}
        <div className="space-y-3.5">
          <p className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em]">
            Buyer profile
          </p>
          <FieldRow label="Title" value={tier.buyer_profile?.title} />
          <FieldRow label="Seniority" value={tier.buyer_profile?.seniority} />
          <FieldRow label="Day-to-day" value={tier.buyer_profile?.day_to_day} />
          <FieldRow label="Identity" value={tier.buyer_profile?.identity} />
        </div>
      </div>

      <div className="border-t border-border-card pt-5 space-y-4">
        {tier.four_forces && (
          <div>
            <p className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.06em] mb-3">
              Four forces
            </p>
            <div className="grid grid-cols-2 gap-4">
              <FieldRow label="Push (dissatisfaction)" value={tier.four_forces.push} />
              <FieldRow label="Pull (attraction)" value={tier.four_forces.pull} />
              <FieldRow label="Anxiety (friction)" value={tier.four_forces.anxiety} />
              <FieldRow label="Habit (inertia)" value={tier.four_forces.habit} />
            </div>
          </div>
        )}

        {/* No .map here on purpose. This was `tier.triggers.map(...)`, the one
            unguarded dereference in this file while every field around it was
            guarded, so a tier without a `triggers` key took down the whole client
            strategy page. Nothing enforces that key: the ICP agent has no schema
            validator. FieldRow now handles the array, and renderableText handles
            both the plain-string and the { trigger } object shape. */}
        <FieldRow label="Triggers" value={tier.triggers} />
        <FieldRow label="Switching costs" value={tier.switching_costs} />

        {tier.disqualifiers && tier.disqualifiers.length > 0 && (
          <div>
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
              Disqualifiers
            </p>
            <ul className="space-y-1">
              {tier.disqualifiers.map(renderableText).map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-[#8B2020] shrink-0 mt-0.5">·</span>
                  <span className="text-[13px] text-[#8B2020] leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

interface IcpDocumentViewProps {
  content: Json
  plainText: string | null
}

export function IcpDocumentView({ content, plainText }: IcpDocumentViewProps) {
  const doc = content as Record<string, unknown>
  const hasStructured = doc && (doc.jtbd_statement || doc.tier_1 || doc.summary)

  if (!hasStructured) {
    return <PlainTextView text={plainText} />
  }

  const icp = doc as unknown as IcpDocument

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-5 max-w-[960px]">

      {/* Left column — tier blocks */}
      <div className="space-y-5">
        {icp.tier_1 && <TierBlock tier={icp.tier_1} tierNum={1} />}
        {icp.tier_2 && <TierBlock tier={icp.tier_2} tierNum={2} />}
        {icp.tier_3 && <TierBlock tier={icp.tier_3} tierNum={3} />}
      </div>

      {/* Right column — JTBD + summary */}
      <div className="space-y-4">
        {icp.jtbd_statement && (
          <div className="bg-[#EAF3DE] border border-[#C0DD97] rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-brand-green-success mb-2">
              Job to be done
            </p>
            <p className="text-[13px] font-medium text-brand-green leading-relaxed">
              {icp.jtbd_statement}
            </p>
          </div>
        )}
        {icp.summary && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
              Summary
            </p>
            <p className="text-[13px] text-text-primary leading-[1.65]">{icp.summary}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function PlainTextView({ text }: { text: string | null }) {
  if (!text) {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-[640px]">
        <p className="text-[12px] text-text-secondary">
          Document content is being processed. Check back shortly.
        </p>
      </div>
    )
  }
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-[640px]">
      <p className="text-[13px] text-text-primary leading-[1.7] whitespace-pre-line">{text}</p>
    </div>
  )
}
