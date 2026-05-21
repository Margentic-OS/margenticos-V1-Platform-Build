import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import { SetupStatusPanel } from './SetupStatusPanel'
import { CampaignRegistrationPanel } from './CampaignRegistrationPanel'
import { LeadUploadPanel } from './LeadUploadPanel'
import { MailboxOrderPanel } from './MailboxOrderPanel'
import type { SetupStatusShape } from './SetupStatusPanel'
import type { SetupStatusValue } from './actions'

function parseSetupStatus(raw: unknown): SetupStatusShape {
  const obj = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const valid = (v: unknown): v is SetupStatusValue =>
    v === 'pending' || v === 'in_progress' || v === 'complete'
  return {
    campaigns: valid(obj.campaigns) ? obj.campaigns : 'pending',
    linkedin: valid(obj.linkedin) ? obj.linkedin : 'pending',
  }
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role — checked on every request, not just at login ─────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') notFound()

  // ── 3. Fetch org — notFound() for both non-operator and missing org (no info leak) ──
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, setup_status')
    .eq('id', id)
    .maybeSingle()

  if (!org) notFound()

  const setupStatus = parseSetupStatus(org.setup_status)

  // Fetch feature flag and pending lead count in parallel — non-blocking on failure.
  const [flagResult, pendingCountResult] = await Promise.all([
    supabase
      .from('integrations_registry')
      .select('is_active')
      .eq('capability', 'instantly_api_active')
      .eq('tool_name', 'instantly')
      .maybeSingle(),
    supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .eq('outbound_upload_status', 'pending')
      .not('campaign_id', 'is', null)
      .not('personalisation_trigger', 'is', null)
      .not('email', 'is', null),
  ])

  const instantlyApiActive = flagResult.data?.is_active ?? false
  const pendingCount = pendingCountResult.count ?? 0

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title={org.name}
        userEmail={user.email}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <a
            href="/dashboard/operator"
            className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary transition-colors mb-6"
          >
            ← All clients
          </a>

          <div className="space-y-4">
            <SetupStatusPanel orgId={org.id} initialStatus={setupStatus} />

            <CampaignRegistrationPanel orgId={org.id} />

            <LeadUploadPanel
              orgId={org.id}
              instantlyApiActive={instantlyApiActive}
              pendingCount={pendingCount}
            />

            <MailboxOrderPanel
              orgId={org.id}
              instantlyApiActive={instantlyApiActive}
            />
          </div>
        </div>
      </div>
    </>
  )
}
