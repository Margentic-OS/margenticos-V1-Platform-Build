import Link from 'next/link'

export interface IntakeSection {
  key: string
  label: string
  total: number
  filled: number
  hasCriticalGap: boolean
}

interface IntakeIncompleteStateProps {
  orgName: string
  sections: IntakeSection[]
  totalCritical: number
  filledCritical: number
}

const STRATEGY_DOCS = [
  { label: 'Prospect profile', desc: 'ICP definition and tier structure' },
  { label: 'Positioning', desc: 'Value proposition and competitive edge' },
  { label: 'Voice guide', desc: 'Tone, style, and communication rules' },
  { label: 'Messaging', desc: 'Email and LinkedIn outreach frameworks' },
]

const NEXT_STEPS = [
  {
    num: '01',
    label: 'Complete intake',
    detail: 'Answer questions about your business, clients, and approach',
    isFirstStep: true,
  },
  {
    num: '02',
    label: 'Strategy documents generated',
    detail: 'ICP, positioning, voice guide, and messaging — ready within 24 hours',
    isFirstStep: false,
  },
  {
    num: '03',
    label: 'Integrations connected',
    detail: 'Email and LinkedIn channels configured for your campaigns',
    isFirstStep: false,
  },
  {
    num: '04',
    label: 'Campaigns go live',
    detail: 'Outreach begins after a 4–6 week warmup period',
    isFirstStep: false,
  },
]

function sectionProgressClass(section: IntakeSection): string {
  if (section.filled === section.total && section.total > 0) return 'bg-brand-green-success'
  return 'bg-brand-green'
}

function sectionDotClass(section: IntakeSection): string {
  if (section.filled === section.total && section.total > 0) return 'bg-brand-green-success'
  if (section.hasCriticalGap) return 'bg-brand-amber'
  return 'bg-text-muted'
}

export function IntakeIncompleteState({
  orgName: _orgName,
  sections,
  totalCritical,
  filledCritical,
}: IntakeIncompleteStateProps) {
  const hasStarted = filledCritical > 0 || sections.some(s => s.filled > 0)
  const overallPercent = totalCritical > 0
    ? Math.round((filledCritical / totalCritical) * 100)
    : 0

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-7">
        <div className="max-w-[880px] grid grid-cols-[1fr_300px] gap-5">

          {/* Left column */}
          <div className="space-y-4">

            {/* Welcome card — dark green */}
            <div className="bg-brand-green rounded-[10px] p-6">
              <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-[rgba(245,240,232,0.40)] mb-3">
                Getting started
              </p>
              <h2 className="text-[18px] font-medium text-[#F5F0E8] leading-snug mb-3">
                {hasStarted
                  ? 'Finish your intake to build your strategy'
                  : "Let's build your pipeline strategy"}
              </h2>
              <p className="text-[12px] text-[rgba(245,240,232,0.60)] leading-relaxed mb-5">
                {hasStarted
                  ? "You're partway through. Once all critical questions are answered, we'll generate your ICP, positioning, voice guide, and messaging documents within 24 hours."
                  : "Answer a few questions about your business and your ideal clients. We'll use your answers to generate four strategy documents that power every campaign we run."}
              </p>
              <Link
                href="/intake"
                className="inline-flex items-center gap-2 bg-[rgba(245,240,232,0.10)] hover:bg-[rgba(245,240,232,0.16)] text-[#F5F0E8] text-[12px] font-medium px-4 py-2 rounded-full transition-colors"
              >
                {hasStarted ? 'Continue intake' : 'Start your intake'}
                <span aria-hidden="true">→</span>
              </Link>
            </div>

            {/* What happens next */}
            <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
              <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-4">
                What happens next
              </p>
              <ol className="space-y-4">
                {NEXT_STEPS.map((step) => {
                  const done = step.isFirstStep
                    && filledCritical === totalCritical
                    && totalCritical > 0
                  return (
                    <li key={step.num} className="flex gap-3">
                      <span className={[
                        'w-[20px] h-[20px] rounded-full flex items-center justify-center shrink-0 mt-0.5',
                        done
                          ? 'bg-[#EBF5E6]'
                          : step.isFirstStep
                          ? 'bg-[#F0ECE4] ring-1 ring-brand-green'
                          : 'bg-[#F0ECE4]',
                      ].join(' ')}>
                        {done ? (
                          <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                            <path d="M1 3L3 5L7 1" stroke="#3B6D11" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <span className={[
                            'text-[8px] font-medium',
                            step.isFirstStep ? 'text-brand-green' : 'text-text-muted',
                          ].join(' ')}>
                            {step.num}
                          </span>
                        )}
                      </span>
                      <div>
                        <p className={[
                          'text-[12px] font-medium',
                          done ? 'text-text-secondary line-through' : 'text-text-primary',
                        ].join(' ')}>
                          {step.label}
                        </p>
                        <p className="text-[11px] text-text-secondary leading-snug mt-0.5">
                          {step.detail}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          </div>

          {/* Right column */}
          <div className="space-y-4">

            {/* Intake progress */}
            <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
              <div className="flex items-start justify-between mb-3">
                <p className="text-[13px] font-medium text-text-primary">Intake progress</p>
                <span className="text-[11px] text-text-secondary tabular-nums">
                  {filledCritical} of {totalCritical}
                </span>
              </div>

              {/* Overall progress bar */}
              <div className="h-1.5 bg-[#F0ECE4] rounded-full mb-5">
                <div
                  className={[
                    'h-full rounded-full transition-all duration-300',
                    overallPercent === 100 ? 'bg-brand-green-success' : 'bg-brand-green',
                  ].join(' ')}
                  style={{ width: `${overallPercent}%` }}
                />
              </div>

              {sections.length > 0 ? (
                <ul className="space-y-4">
                  {sections.map((section) => {
                    const pct = section.total > 0
                      ? Math.round((section.filled / section.total) * 100)
                      : 0
                    return (
                      <li key={section.key}>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sectionDotClass(section)}`} />
                            <span className="text-[11px] font-medium text-text-primary">
                              {section.label}
                            </span>
                          </div>
                          <span className="text-[10px] text-text-secondary tabular-nums">
                            {section.filled}/{section.total}
                          </span>
                        </div>
                        <div className="h-1 bg-[#F0ECE4] rounded-full">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${sectionProgressClass(section)}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <div className="py-2">
                  <p className="text-[12px] text-text-secondary">
                    Your intake is ready to begin.
                  </p>
                  <p className="text-[11px] text-text-muted mt-1">
                    Progress will appear here as you fill it in.
                  </p>
                </div>
              )}
            </div>

            {/* Strategy documents — locked */}
            <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
              <p className="text-[13px] font-medium text-text-primary mb-1">
                Strategy documents
              </p>
              <p className="text-[11px] text-text-secondary mb-4">
                Generated once intake is complete.
              </p>
              <ul className="space-y-3">
                {STRATEGY_DOCS.map((doc) => (
                  <li key={doc.label} className="flex items-start gap-2.5">
                    <span className="w-4 h-4 rounded-full bg-[#F0ECE4] flex items-center justify-center shrink-0 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                    </span>
                    <div>
                      <p className="text-[11px] font-medium text-text-secondary">{doc.label}</p>
                      <p className="text-[10px] text-text-muted">{doc.desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
