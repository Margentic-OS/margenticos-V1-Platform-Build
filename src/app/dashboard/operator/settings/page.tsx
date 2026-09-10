import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { WarningsRail } from '@/components/dashboard/operator/WarningsRail'
import { SettingsView } from '@/components/dashboard/operator/SettingsView'
import type { OrganisationSettings } from '@/components/dashboard/operator/SettingsView'

// Syntactic validation only, matching resolveViewingOrg. A malformed value must never
// reach a uuid-typed column query, which would throw invalid-input-syntax rather than
// returning nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Operator settings.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY VALUE ON THIS PAGE IS READ. NOTHING IS INVENTED.
 *
 * Until 2026-09-10 this page rendered a hardcoded PLACEHOLDER_SETTINGS literal: an
 * organisation name matching no record, a booking link belonging to nobody, four
 * integrations reading "Connected" with "last verified" dates, and two toggles wired to
 * useState and nothing else.
 *
 * Measured against production the same day: of 16 integrations_registry rows exactly TWO
 * carry connection_status 'connected', no row carries any date the page displayed, and
 * `integrations_registry` HAS NO last_verified COLUMN AT ALL — that field had nowhere to
 * have come from. calendly_url was NULL on both live client organisations while the page
 * showed a link.
 *
 * The amber "not yet wired to live data" banner was true, and a banner is not a licence.
 * A screen of invented values is read by whoever opens it, and the caveat is read once.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO CLIENT PARAM MEANS NO CLIENT, AND SAYS SO
 *
 * This page deliberately does NOT use resolveViewingOrg. That helper falls back to the
 * caller's own organisation_id when no ?client= is present, and for the operator that row
 * points at an archived organisation. Falling back would put one organisation's real
 * settings under another organisation's heading, which is the same defect as the
 * placeholder wearing better clothes.
 *
 * So the client is required, and its absence is a state the page renders rather than a
 * gap it fills. The sidebar carries the selected client into this route via ?client=.
 */
export default async function OperatorSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const supabase = await createClient()
  const { client: clientParam } = await searchParams

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // ── Platform integrations ───────────────────────────────────────────────────
  // Read for every request, with or without a client, because these rows are NOT
  // per-client: integrations_registry has no organisation column. Presenting them under a
  // "Per-client configuration" heading was part of what the old page got wrong.
  //
  // Ordered explicitly. The rows are displayed in this order and an unordered read would
  // let them move between requests for no reason.
  const { data: registryRows } = await supabase
    .from('integrations_registry')
    .select('capability, tool_name, is_active, connection_status')
    .order('capability')
    .order('tool_name')

  // ── The selected client ─────────────────────────────────────────────────────
  const orgId = clientParam && UUID_RE.test(clientParam) ? clientParam : null

  // The column list is ONE STRING LITERAL, deliberately. Supabase infers the row type from
  // it, and a runtime-concatenated string infers as GenericStringError instead, which
  // silently costs the typing this read depends on.
  let organisation: OrganisationSettings | null = null

  if (orgId) {
    const { data } = await supabase
      .from('organisations')
      .select('id, name, calendly_url, auto_approve_window_hours, auto_held_window_hours, monthly_meetings_target, currency, client_review_enabled, linkedin_channel_enabled, founder_first_name, archived_at')
      .eq('id', orgId)
      .maybeSingle()

    organisation = data
  }

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title="Settings"
        subtitle={organisation ? organisation.name : 'No client selected'}
        userEmail={user.email}
      />
      <WarningsRail />
      <SettingsView
        organisation={organisation}
        integrations={registryRows ?? []}
        // Distinguishes "you have not picked a client" from "you picked one that is not
        // there". A stale bookmark or a deleted organisation is a different problem from
        // an empty selection and must not render as one.
        clientRequested={orgId !== null}
      />
    </>
  )
}
