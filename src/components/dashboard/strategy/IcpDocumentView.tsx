import type { Json } from '@/types/database'
import type { IcpDocument, IcpTier } from '@/types'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
      {children}
    </h3>
  )
}

function FieldRow({ label, value }: { label: string; value: string | string[] | undefined }) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null
  return (
    <div>
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
        {label}
      </p>
      {Array.isArray(value) ? (
        <ul className="space-y-1">
          {value.map((item, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-text-muted shrink-0 mt-0.5">·</span>
              <span className="text-[13px] text-text-primary leading-relaxed">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-text-primary leading-[1.65]">{value}</p>
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

        <FieldRow label="Triggers" value={tier.triggers} />
        <FieldRow label="Switching costs" value={tier.switching_costs} />

        {tier.disqualifiers && tier.disqualifiers.length > 0 && (
          <div>
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
              Disqualifiers
            </p>
            <ul className="space-y-1">
              {tier.disqualifiers.map((item, i) => (
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
