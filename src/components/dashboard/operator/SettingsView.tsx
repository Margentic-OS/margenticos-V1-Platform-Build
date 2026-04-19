'use client'

import { useState } from 'react'

export interface IntegrationStatus {
  capability: string
  toolName: string
  connected: boolean
  lastVerified: string | null
}

export interface ClientSettings {
  orgId: string
  orgName: string
  linkedinPostAutoApprove: boolean
  holdingMessageEnabled: boolean
  bookingUrl: string | null
  integrations: IntegrationStatus[]
}

// TODO: Replace with a real query that fetches settings per client org from
// integrations_registry (capabilities + connection status) and a client_settings
// or organisations table (per-client approval toggles, booking URL).
const PLACEHOLDER_SETTINGS: ClientSettings = {
  orgId: 'placeholder',
  orgName: 'Apex Consulting',
  linkedinPostAutoApprove: true,
  holdingMessageEnabled: false,
  bookingUrl: 'https://calendly.com/apex-consulting/30min',
  integrations: [
    { capability: 'can_send_email', toolName: 'Instantly', connected: true, lastVerified: '2026-04-18' },
    { capability: 'can_schedule_linkedin_post', toolName: 'Taplio', connected: true, lastVerified: '2026-04-18' },
    { capability: 'can_send_linkedin_dm', toolName: 'Lemlist', connected: false, lastVerified: null },
    { capability: 'can_enrich_contact', toolName: 'Apollo', connected: true, lastVerified: '2026-04-17' },
    { capability: 'can_book_meeting', toolName: 'Calendly', connected: true, lastVerified: '2026-04-18' },
  ],
}

function capabilityLabel(capability: string): string {
  const map: Record<string, string> = {
    can_send_email: 'Email sending',
    can_schedule_linkedin_post: 'LinkedIn post scheduling',
    can_send_linkedin_dm: 'LinkedIn DMs',
    can_enrich_contact: 'Contact enrichment',
    can_book_meeting: 'Meeting booking',
    can_validate_email: 'Email validation',
  }
  return map[capability] ?? capability
}

interface SectionProps {
  title: string
  children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
      <p className="text-[13px] font-medium text-text-primary mb-4 pb-3 border-b border-border-card">
        {title}
      </p>
      {children}
    </div>
  )
}

interface ToggleProps {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}

function Toggle({ label, description, checked, onChange }: ToggleProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[12px] font-medium text-text-primary">{label}</p>
        <p className="text-[11px] text-text-secondary mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative inline-flex w-9 h-5 shrink-0 rounded-full border-2 transition-colors ${
          checked
            ? 'bg-brand-green border-brand-green'
            : 'bg-[#E8E2D8] border-[#E8E2D8]'
        }`}
      >
        <span
          className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

export function SettingsView() {
  const settings = PLACEHOLDER_SETTINGS
  const [linkedinAutoApprove, setLinkedinAutoApprove] = useState(settings.linkedinPostAutoApprove)
  const [holdingMessage, setHoldingMessage] = useState(settings.holdingMessageEnabled)
  const [bookingUrl, setBookingUrl] = useState(settings.bookingUrl ?? '')
  const [bookingSaved, setBookingSaved] = useState(false)

  function saveBookingUrl() {
    // TODO: Call PATCH /api/operator/settings/booking-url with { org_id, booking_url }
    // The API should update integrations_registry.config for the can_book_meeting capability.
    setBookingSaved(true)
    setTimeout(() => setBookingSaved(false), 2500)
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-6 max-w-[720px] space-y-5">

        {/* Client selector at top — TODO: wire to real client list */}
        <div className="flex items-center gap-3">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
            Configuring
          </p>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-card border border-border-card rounded-[6px]">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-green-success shrink-0" />
            <span className="text-[12px] font-medium text-text-primary">
              {settings.orgName}
            </span>
          </div>
        </div>

        {/* Integrations */}
        <Section title="Integrations">
          <div className="space-y-3">
            {settings.integrations.map((int) => (
              <div key={int.capability} className="flex items-center justify-between">
                <div>
                  <p className="text-[12px] font-medium text-text-primary">
                    {capabilityLabel(int.capability)}
                  </p>
                  <p className="text-[11px] text-text-secondary mt-0.5">
                    {int.toolName}
                    {int.lastVerified ? ` — last verified ${int.lastVerified}` : ''}
                  </p>
                </div>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-medium ${
                  int.connected
                    ? 'bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]'
                    : 'bg-[#F0ECE4] text-text-secondary border border-border-card'
                }`}>
                  {int.connected ? 'Connected' : 'Not connected'}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* Approval thresholds */}
        <Section title="Approval thresholds">
          <div className="space-y-5">
            <Toggle
              label="LinkedIn post auto-approve"
              description="When on, posts are auto-approved after 24 hours if not reviewed."
              checked={linkedinAutoApprove}
              onChange={setLinkedinAutoApprove}
            />
            <div className="h-px bg-border-card" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[12px] font-medium text-text-primary">Cold email auto-approve window</p>
                <p className="text-[11px] text-text-secondary mt-0.5">
                  Sequences auto-approve after 3 days if not reviewed. Fixed for all clients.
                </p>
              </div>
              <span className="text-[12px] font-medium text-text-secondary shrink-0">3 days</span>
            </div>
            <div className="h-px bg-border-card" />
            <Toggle
              label="Holding message for information requests"
              description="When on, the system sends a holding message if a prospect asks a question and no reply is sent within 72 hours. Off by default."
              checked={holdingMessage}
              onChange={setHoldingMessage}
            />
          </div>
        </Section>

        {/* Campaign limits */}
        <Section title="Campaign limits">
          <p className="text-[12px] text-text-secondary leading-relaxed">
            Sending limits, warmup schedules, and sequence caps are configured directly in Instantly. Contact Doug to adjust any limits for this client.
          </p>
        </Section>

        {/* Booking URL */}
        <Section title="Booking link">
          <div>
            <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-[0.07em] mb-2">
              Client booking link
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={bookingUrl}
                onChange={(e) => {
                  setBookingUrl(e.target.value)
                  setBookingSaved(false)
                }}
                placeholder="https://calendly.com/your-client/30min"
                className="flex-1 px-3 py-2 bg-surface-content border border-border-card rounded-[6px] text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-[#A8D4B8] transition-colors"
              />
              <button
                onClick={saveBookingUrl}
                className={`px-4 py-2 rounded-[6px] text-[12px] font-medium transition-colors shrink-0 ${
                  bookingSaved
                    ? 'bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]'
                    : 'bg-brand-green text-[#F5F0E8] hover:bg-[#163021]'
                }`}
              >
                {bookingSaved ? 'Saved' : 'Save'}
              </button>
            </div>
            <p className="text-[11px] text-text-secondary mt-2">
              Stored in the integrations registry for the meeting booking capability.
            </p>
          </div>
        </Section>

      </div>
    </div>
  )
}
