'use client'

import { useState, useTransition } from 'react'
import { updateBookingUrl, updateRevenueFilterEnabled } from '@/app/dashboard/operator/settings/actions'

// ═══════════════════════════════════════════════════════════════════════════════
// THIS COMPONENT RENDERS ONLY WHAT IT IS GIVEN. IT HAS NO DEFAULTS AND NO SAMPLES.
//
// It replaced a PLACEHOLDER_SETTINGS literal on 2026-09-10. See the page for what that
// literal claimed and what the records actually said. The rule this file now keeps:
//
//   A value that is not set renders as "Not set up", never as a plausible example.
//
// An empty state naming what is missing is a smaller thing to show than a screen of
// invented values, and it is the only version an operator can act on.
// ═══════════════════════════════════════════════════════════════════════════════

/** One integrations_registry row. Platform-wide: the table has no organisation column. */
export interface IntegrationRow {
  capability: string
  tool_name: string
  is_active: boolean
  connection_status: string
}

/** The subset of organisations this page reads. */
export interface OrganisationSettings {
  id: string
  name: string
  booking_url: string | null
  auto_approve_window_hours: number
  auto_held_window_hours: number
  monthly_meetings_target: number
  currency: string
  client_review_enabled: boolean
  linkedin_channel_enabled: boolean
  sourcing_revenue_filter_enabled: boolean
  founder_first_name: string | null
  archived_at: string | null
}

export interface SettingsViewProps {
  organisation: OrganisationSettings | null
  integrations: IntegrationRow[]
  /** True when a client id was supplied. Separates "none picked" from "not found". */
  clientRequested: boolean
}

// Capability codes, not tool names. The label is ours; the tool comes from the record.
// An unmapped capability falls through to its raw code rather than being hidden, because a
// capability nobody has labelled is exactly the one worth seeing.
const CAPABILITY_LABELS: Record<string, string> = {
  can_send_email: 'Email sending',
  can_schedule_linkedin_post: 'LinkedIn post scheduling',
  can_send_linkedin_dm: 'LinkedIn DMs',
  can_enrich_contact: 'Contact enrichment',
  can_book_meeting: 'Meeting booking',
  can_validate_email: 'Email validation',
  can_source_prospects: 'Prospect sourcing',
  can_suppress_contact: 'Suppression',
  can_report_sending_health: 'Sending health',
  can_upload_leads: 'Lead upload',
  can_order_mailboxes: 'Mailbox ordering',
  can_track_meeting: 'Meeting tracking',
}

function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability
}

function Section({ title, subtitle, children }: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
      <div className="mb-4 pb-3 border-b border-border-card">
        <p className="text-[13px] font-medium text-text-primary">{title}</p>
        {subtitle && (
          <p className="text-[11px] text-text-secondary mt-1 leading-relaxed">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  )
}

/** The one way an absent value is allowed to render. */
function NotSetUp() {
  return <span className="text-[12px] text-text-muted italic">Not set up</span>
}

function ValueRow({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[12px] font-medium text-text-primary">{label}</p>
        {hint && <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">{hint}</p>}
      </div>
      <div className="text-[12px] font-medium text-text-secondary shrink-0 text-right">
        {children}
      </div>
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-border-card" />
}

// ─── The booking link, the one editable field on this page ────────────────────
//
// Editable because it is the one value here that has a real typed column, a locked
// decision requiring it to differ per client, something already reading it live
// (process-reply.ts puts it in the reply a prospect receives), and no way to set it
// outside SQL. Every other value stays read-only until it has all four.
// The revenue band as a sourcing filter, per client. EDITABLE because it has all four: the
// column, a write path (updateRevenueFilterEnabled), validation, and a test. Off by default,
// because the provider's filter drops every company it holds no revenue figure for.
function RevenueFilterToggle({ orgId, initial }: { orgId: string; initial: boolean }) {
  const [enabled, setEnabled] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleToggle() {
    const next = !enabled
    setError(null)
    startTransition(async () => {
      const result = await updateRevenueFilterEnabled(orgId, next)
      if (result.error) {
        setError(result.error)
        return
      }
      // Show what the server stored, not what was clicked.
      setEnabled(result.value ?? next)
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Revenue filter"
        onClick={handleToggle}
        disabled={pending}
        className={`px-3 py-1 rounded-[6px] text-[12px] font-medium transition-colors disabled:opacity-60 ${
          enabled
            ? 'bg-brand-green text-[#F5F0E8]'
            : 'bg-surface-content text-text-secondary border border-border-card'
        }`}
      >
        {pending ? 'Saving' : enabled ? 'On' : 'Off'}
      </button>
      {error && <p className="text-[11px] text-[#8A2B2B] leading-relaxed">{error}</p>}
    </div>
  )
}

function BookingLinkField({ orgId, initial }: { orgId: string; initial: string | null }) {
  const [saved, setSaved] = useState<string | null>(initial)
  const [draft, setDraft] = useState(initial ?? '')
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const dirty = draft.trim() !== (saved ?? '')

  function handleSave() {
    setError(null)
    setJustSaved(false)
    startTransition(async () => {
      const result = await updateBookingUrl(orgId, draft)
      if (result.error) {
        setError(result.error)
        return
      }
      // Store what the server stored, not what was typed. The action normalises through
      // the URL parser, so the field must show the value that actually landed.
      setSaved(result.value ?? null)
      setDraft(result.value ?? '')
      setJustSaved(true)
    })
  }

  return (
    <div>
      <label
        htmlFor="booking-url"
        className="block text-[11px] font-medium text-text-secondary uppercase tracking-[0.07em] mb-2"
      >
        Client booking link
      </label>
      <div className="flex gap-2">
        <input
          id="booking-url"
          type="url"
          value={draft}
          disabled={pending}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
            setJustSaved(false)
          }}
          placeholder="https://"
          className="flex-1 px-3 py-2 bg-surface-content border border-border-card rounded-[6px] text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-[#A8D4B8] transition-colors disabled:opacity-60"
        />
        <button
          onClick={handleSave}
          disabled={pending || !dirty}
          className={`px-4 py-2 rounded-[6px] text-[12px] font-medium transition-colors shrink-0 disabled:opacity-40 ${
            justSaved && !dirty
              ? 'bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]'
              : 'bg-brand-green text-[#F5F0E8] hover:bg-[#163021]'
          }`}
        >
          {pending ? 'Saving' : justSaved && !dirty ? 'Saved' : 'Save'}
        </button>
      </div>

      {error && (
        <p className="text-[11px] text-[#8A2B2B] mt-2 leading-relaxed">{error}</p>
      )}

      {!error && saved === null && (
        <p className="text-[11px] text-text-secondary mt-2 leading-relaxed">
          <NotSetUp />{' '}
          — this client has no booking link. A positive reply is held as a draft for the
          operator instead of being sent automatically, and a draft that includes the link
          cannot be sent until one is set here.
        </p>
      )}

      <p className="text-[11px] text-text-secondary mt-2 leading-relaxed">
        Stored on the client record and sent to prospects who reply positively. It must be
        the client&apos;s own booking page, connected to the diary they actually keep. Any
        booking tool works; clearing the field removes the link.
      </p>
    </div>
  )
}

export function SettingsView({ organisation, integrations, clientRequested }: SettingsViewProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-6 max-w-[720px] space-y-5">

        {/* ── No client, or a client that is not there ────────────────────── */}
        {!organisation && (
          <div className="px-4 py-3 rounded-[8px] bg-[#FEF7E6] border border-[#F0D080]">
            <p className="text-[11px] text-[#7A4800] leading-relaxed">
              {clientRequested
                ? 'That client could not be found. It may have been removed, or the link may be out of date. Pick a client in the sidebar.'
                : 'No client selected. Pick a client in the sidebar to see their settings. The integrations below apply to every client.'}
            </p>
          </div>
        )}

        {organisation?.archived_at && (
          <div className="px-4 py-3 rounded-[8px] bg-[#FEF7E6] border border-[#F0D080]">
            <p className="text-[11px] text-[#7A4800] leading-relaxed">
              This organisation is archived. Its settings are shown for reference and
              changing them affects nothing that runs.
            </p>
          </div>
        )}

        {/* ── Per-client settings ─────────────────────────────────────────── */}
        {organisation && (
          <>
            <Section
              title="Booking link"
              subtitle="The only setting on this page that can be changed here."
            >
              <BookingLinkField orgId={organisation.id} initial={organisation.booking_url} />
            </Section>

            <Section
              title="This client's settings"
              subtitle="Read from the client record. Changing any of these is a database change today."
            >
              <div className="space-y-5">
                <ValueRow
                  label="Email sign-off"
                  hint="The two lines that end every email. Generation refuses to run without both."
                >
                  {organisation.founder_first_name
                    ? `${organisation.founder_first_name} / ${organisation.name}`
                    : <NotSetUp />}
                </ValueRow>
                <Divider />
                <ValueRow
                  label="Document auto-approve window"
                  hint="How long a suggestion waits in the operator queue before it is promoted automatically."
                >
                  {organisation.auto_approve_window_hours} hours
                </ValueRow>
                <Divider />
                <ValueRow
                  label="Meeting auto-held window"
                  hint="How long after a meeting's start time it resolves to held without anyone confirming."
                >
                  {organisation.auto_held_window_hours} hours
                </ValueRow>
                <Divider />
                <ValueRow label="Monthly meetings target">
                  {organisation.monthly_meetings_target}
                </ValueRow>
                <Divider />
                <ValueRow label="Currency">{organisation.currency}</ValueRow>
                <Divider />
                <ValueRow
                  label="Client prospect review"
                  hint="When off, tiered prospects publish without the client's one-time handshake."
                >
                  {organisation.client_review_enabled ? 'On' : 'Off'}
                </ValueRow>
                <Divider />
                <ValueRow label="LinkedIn channel">
                  {organisation.linkedin_channel_enabled ? 'On' : 'Off'}
                </ValueRow>
                <Divider />
                <ValueRow
                  label="Revenue filter"
                  hint="When on, sourcing excludes companies outside the revenue band in this client's ICP, and every company the provider holds no revenue figure for. Takes effect at the next ICP approval."
                >
                  <RevenueFilterToggle
                    orgId={organisation.id}
                    initial={organisation.sourcing_revenue_filter_enabled}
                  />
                </ValueRow>
              </div>
            </Section>
          </>
        )}

        {/* ── Platform integrations ───────────────────────────────────────── */}
        <Section
          title="Platform integrations"
          subtitle="Registered once for the whole platform, not per client. Every client uses the same tools and the same accounts."
        >
          {integrations.length === 0 ? (
            <p className="text-[12px] text-text-secondary leading-relaxed">
              No integrations are registered. Nothing that depends on an external tool can
              run in this state, so this is a fault rather than an empty start.
            </p>
          ) : (
            <div className="space-y-3">
              {integrations.map((int) => (
                <div key={`${int.capability}:${int.tool_name}`} className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[12px] font-medium text-text-primary">
                      {capabilityLabel(int.capability)}
                    </p>
                    <p className="text-[11px] text-text-secondary mt-0.5">
                      {int.tool_name} — connection recorded as {int.connection_status}
                    </p>
                  </div>
                  <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-medium shrink-0 ${
                    int.is_active
                      ? 'bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]'
                      : 'bg-[#F0ECE4] text-text-secondary border border-border-card'
                  }`}>
                    {int.is_active ? 'In use' : 'Not in use'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {/*
            THE PILL READS is_active, NOT connection_status, AND THAT IS DELIBERATE.

            is_active is the field the code actually reads: every registry lookup in the
            codebase filters on it. connection_status is read in exactly one place,
            executeCapability, which has an empty handler map and zero callers — every
            live integration calls its handler directly. So connection_status describes
            nothing that currently runs, which is why it is reported verbatim as a stored
            value rather than translated into a verdict like "Connected".

            The old page did the opposite: it showed "Connected" for four tools whose rows
            all read disconnected, from a hardcoded boolean that read nothing at all.
          */}
          <p className="text-[11px] text-text-secondary mt-4 pt-3 border-t border-border-card leading-relaxed">
            &ldquo;In use&rdquo; means the platform routes this capability to that tool.
            The recorded connection status is shown as stored and is not currently
            maintained, so treat it as a note rather than a live check.
          </p>
        </Section>

        {/* ── Campaign limits ─────────────────────────────────────────────── */}
        <Section title="Campaign limits">
          <p className="text-[12px] text-text-secondary leading-relaxed">
            Sending schedule, daily limits and warmup are configured in the email sending
            tool and are not stored here. There is one sending account shared across all
            clients, so these are not per-client values today.
          </p>
        </Section>

      </div>
    </div>
  )
}
