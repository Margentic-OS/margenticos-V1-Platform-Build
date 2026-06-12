import Link from 'next/link'

interface DocumentStatus {
  type: string
  status: string
  version: string
  lastUpdated: string
}

interface ClientProfileBlockProps {
  orgName: string
  founderName?: string
  clientEmail?: string
  website?: string
  revenueRange?: string
  documents: DocumentStatus[]
  campaignState?: {
    count: number
    status: 'pending' | 'active' | 'paused'
  }
  warmupState?: {
    started: boolean
    startedAt?: string
  }
  dispatchMode: 'mock' | 'live'
  lastLoginAt?: string
  onboardedAt: string
  intakeUrl: string
  missingFields: string[]
}

export function ClientProfileBlock({
  orgName,
  founderName,
  clientEmail,
  website,
  revenueRange,
  documents,
  campaignState,
  warmupState,
  dispatchMode,
  lastLoginAt,
  onboardedAt,
  intakeUrl,
  missingFields,
}: ClientProfileBlockProps) {
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-6 py-4 border-b border-border-card bg-surface-shell">
        <h3 className="text-[13px] font-medium text-text-primary">Client profile</h3>
      </div>

      <div className="px-6 py-6 space-y-6">
        {/* Company Info */}
        <div>
          <p className="text-[10px] uppercase tracking-[0.09em] text-text-secondary mb-3 font-medium">Company</p>
          <div className="space-y-2">
            <div className="flex justify-between items-start">
              <span className="text-[12px] text-text-secondary">Company name</span>
              <span className="text-[12px] font-medium text-text-primary">{orgName}</span>
            </div>
            {founderName && (
              <div className="flex justify-between items-start">
                <span className="text-[12px] text-text-secondary">Founder</span>
                <span className="text-[12px] font-medium text-text-primary">{founderName}</span>
              </div>
            )}
            {website && (
              <div className="flex justify-between items-start">
                <span className="text-[12px] text-text-secondary">Website</span>
                <a
                  href={website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[12px] font-medium text-brand-blue hover:underline truncate ml-2"
                >
                  {website.replace(/^https?:\/\//, '')}
                </a>
              </div>
            )}
            {revenueRange && (
              <div className="flex justify-between items-start">
                <span className="text-[12px] text-text-secondary">Revenue</span>
                <span className="text-[12px] font-medium text-text-primary">{revenueRange}</span>
              </div>
            )}
          </div>
        </div>

        {/* Contact */}
        <div>
          <p className="text-[10px] uppercase tracking-[0.09em] text-text-secondary mb-3 font-medium">Contact</p>
          <div className="space-y-2">
            {clientEmail && (
              <div className="flex justify-between items-start">
                <span className="text-[12px] text-text-secondary">Login email</span>
                <span className="text-[12px] font-medium text-text-primary">{clientEmail}</span>
              </div>
            )}
            {lastLoginAt && (
              <div className="flex justify-between items-start">
                <span className="text-[12px] text-text-secondary">Last login</span>
                <span className="text-[12px] font-medium text-text-primary">{formatDate(lastLoginAt)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Documents */}
        <div>
          <p className="text-[10px] uppercase tracking-[0.09em] text-text-secondary mb-3 font-medium">Documents</p>
          <div className="space-y-2">
            {documents.length > 0 ? (
              documents.map(doc => (
                <div key={doc.type} className="flex justify-between items-start">
                  <span className="text-[12px] text-text-secondary capitalize">{doc.type}</span>
                  <div className="text-right">
                    <div className="inline-flex items-center gap-2">
                      <span className="text-[11px] px-2 py-1 rounded-[4px] bg-surface-shell text-text-secondary">
                        v{doc.version}
                      </span>
                      <span className="text-[11px] px-2 py-1 rounded-[4px]" style={{
                        backgroundColor: doc.status === 'active' ? '#E8F5E9' : doc.status === 'draft' ? '#FFF3E0' : '#F5F5F5',
                        color: doc.status === 'active' ? '#2E7D32' : doc.status === 'draft' ? '#E65100' : '#616161',
                      }}>
                        {doc.status}
                      </span>
                    </div>
                    <p className="text-[10px] text-text-secondary mt-1">
                      {formatDate(doc.lastUpdated)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[12px] text-text-secondary italic">Pending generation</p>
            )}
          </div>
        </div>

        {/* Campaigns & Warmup */}
        {(campaignState || warmupState) && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.09em] text-text-secondary mb-3 font-medium">Sending</p>
            <div className="space-y-2">
              {campaignState && (
                <div className="flex justify-between items-start">
                  <span className="text-[12px] text-text-secondary">Campaigns</span>
                  <div className="text-right">
                    <span className="text-[12px] font-medium text-text-primary">{campaignState.count}</span>
                    <span className="text-[11px] px-2 py-1 rounded-[4px] bg-surface-shell text-text-secondary ml-2 inline-block">
                      {campaignState.status}
                    </span>
                  </div>
                </div>
              )}
              {warmupState && (
                <div className="flex justify-between items-start">
                  <span className="text-[12px] text-text-secondary">Warmup</span>
                  <span className="text-[12px] font-medium text-text-primary">
                    {warmupState.started ? 'Active' : 'Not started'}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Status */}
        <div>
          <p className="text-[10px] uppercase tracking-[0.09em] text-text-secondary mb-3 font-medium">Status</p>
          <div className="space-y-2">
            <div className="flex justify-between items-start">
              <span className="text-[12px] text-text-secondary">Dispatch mode</span>
              <span className="text-[11px] px-2.5 py-1 rounded-[4px] font-medium" style={{
                backgroundColor: dispatchMode === 'live' ? '#E3F2FD' : '#F5F5F5',
                color: dispatchMode === 'live' ? '#0D47A1' : '#424242',
              }}>
                {dispatchMode}
              </span>
            </div>
            <div className="flex justify-between items-start">
              <span className="text-[12px] text-text-secondary">Onboarded</span>
              <span className="text-[12px] font-medium text-text-primary">{formatDate(onboardedAt)}</span>
            </div>
          </div>
        </div>

        {/* Intake Link */}
        <Link
          href={intakeUrl}
          className="inline-flex items-center gap-2 text-[11px] font-medium text-brand-blue hover:underline"
        >
          View intake →
        </Link>

        {/* Missing Fields Note */}
        {missingFields.length > 0 && (
          <div className="pt-4 border-t border-border-card">
            <p className="text-[10px] text-text-secondary italic">
              Fields with no schema backing: {missingFields.join(', ')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
