// Uploads a batch of prospects to an Instantly campaign via POST /api/v2/leads/add.
// After upload, updates each prospect row in the DB with upload status and Instantly lead ID.
//
// Idempotency: skip_if_in_campaign=true means Instantly deduplicates at its end.
// The caller (server action) filters for prospects with outbound_upload_status='pending'
// before calling this function — do not pass already-uploaded prospects.

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { resolveInstantlyBaseUrl, summarizeResponseBody } from './constants'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'
import type {
  ProspectForUpload,
  LeadUploadResponse,
  LeadUploadResult,
} from './types'
import {
  InstantlyFlagError,
  InstantlyNetworkError,
  InstantlyRateLimitError,
  InstantlyValidationError,
  InstantlyServerError,
  InstantlyApiError,
} from './types'

export async function uploadLeads(
  organisationId: string,
  campaignId: string,
  leads: ProspectForUpload[],
): Promise<LeadUploadResult> {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  // Flag drives URL: off → mock server, on → production.
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  const requestBody = {
    campaign_id: campaignId,
    leads: leads.map(lead => ({
      email: lead.email,
      ...(lead.personalization !== undefined && { personalization: lead.personalization }),
      ...(lead.first_name !== undefined && { first_name: lead.first_name }),
      ...(lead.last_name !== undefined && { last_name: lead.last_name }),
      ...(lead.company_name !== undefined && { company_name: lead.company_name }),
      ...(lead.job_title !== undefined && { job_title: lead.job_title }),
      ...(lead.custom_variables && { ...lead.custom_variables }),
    })),
    skip_if_in_workspace: true,
    skip_if_in_campaign: true,
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/leads/add`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })
  } catch (err) {
    throw new InstantlyNetworkError(`Instantly is unreachable: ${String(err)}`)
  }

  if (response.status === 429) {
    throw new InstantlyRateLimitError('Instantly rate limit hit — retry in a moment')
  }

  if (response.status === 400 || response.status === 422) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new InstantlyValidationError(
      `Lead upload rejected (${response.status}): ${summarizeResponseBody(body, response.status)}`
    )
  }

  if (response.status >= 500) {
    const errMsg = `Outbound provider transient outage (${response.status}) — try again later`
    Sentry.captureException(new Error(errMsg), { level: 'warning' })
    throw new InstantlyServerError(errMsg)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new InstantlyApiError(
      `Unexpected outbound provider error (${response.status}): ${summarizeResponseBody(body, response.status)}`
    )
  }

  let data: LeadUploadResponse
  try {
    data = await response.json() as LeadUploadResponse
  } catch {
    throw new InstantlyApiError('Instantly response could not be parsed as JSON')
  }

  logger.info('instantly/uploadLeads: upload complete', {
    leads_uploaded: data.leads_uploaded,
    created: data.created_leads.length,
    in_blocklist: data.in_blocklist,
    duplicated: data.duplicated_leads,
    invalid_email: data.invalid_email_count,
    incomplete: data.incomplete_count,
    campaign_id: campaignId,
    organisation_id: organisationId,
  })

  // Update prospect rows — non-throwing; individual row failures are logged, not propagated.
  const supabase = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const createdByEmail = new Map(
    data.created_leads.map(l => [l.email.toLowerCase(), l])
  )
  const now = new Date().toISOString()

  await Promise.all(leads.map(async (lead) => {
    const created = createdByEmail.get(lead.email.toLowerCase())

    if (created) {
      const { error } = await supabase
        .from('prospects')
        .update({
          outbound_lead_id: created.id,
          outbound_upload_status: 'uploaded',
          outbound_upload_attempted_at: now,
          outbound_upload_error: null,
        })
        .eq('email', lead.email)
        .eq('organisation_id', organisationId)

      if (error) {
        logger.warn('instantly/uploadLeads: failed to update prospect row after upload', {
          email: lead.email,
          organisation_id: organisationId,
          error: error.message,
        })
      }
    } else {
      const reason =
        `Not created by Instantly — upload counts: ` +
        `in_blocklist=${data.in_blocklist} duplicated=${data.duplicated_leads} ` +
        `invalid_email=${data.invalid_email_count} incomplete=${data.incomplete_count}`

      const { error } = await supabase
        .from('prospects')
        .update({
          outbound_upload_status: 'failed',
          outbound_upload_attempted_at: now,
          outbound_upload_error: reason,
        })
        .eq('email', lead.email)
        .eq('organisation_id', organisationId)

      if (error) {
        logger.warn('instantly/uploadLeads: failed to mark prospect as failed', {
          email: lead.email,
          organisation_id: organisationId,
          error: error.message,
        })
      }
    }
  }))

  return {
    leads_uploaded: data.leads_uploaded,
    created_count: data.created_leads.length,
    in_blocklist: data.in_blocklist,
    duplicated: data.duplicated_leads,
    invalid_email_count: data.invalid_email_count,
    incomplete_count: data.incomplete_count,
  }
}
