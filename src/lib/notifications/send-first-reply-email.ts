// Sends FIRST_REPLY email when first qualifying human reply is classified
// Called from reply processing pipeline
// Backfill guard: only fires on events for orgs created on or after feature activation date

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmailWithDedup } from './send-transactional-with-dedup'
import { firstReplyTemplate, firstReplyTemplateText, firstReplySubject } from '@/lib/email/templates/first-reply'

const FEATURE_ACTIVATION_DATE = new Date('2026-07-27').toISOString()

export interface SendFirstReplyEmailParams {
  supabase: SupabaseClient
  organisationId: string
  prospectId: string | null
  classifiedIntent: string
  signalCreatedAt: string  // ISO timestamp of when reply event occurred
}

export async function sendFirstReplyEmail(
  params: SendFirstReplyEmailParams
): Promise<{ sent: boolean }> {
  try {
    // Backfill guard: only send if reply event occurred after feature activation
    if (params.signalCreatedAt < FEATURE_ACTIVATION_DATE) {
      logger.info('sendFirstReplyEmail: reply event before feature activation, skipping', {
        organisation_id: params.organisationId,
        signal_created_at: params.signalCreatedAt,
        activation_date: FEATURE_ACTIVATION_DATE,
      })
      return { sent: false }
    }

    // Fetch organisation name
    const { data: org, error: orgError } = await params.supabase
      .from('organisations')
      .select('name')
      .eq('id', params.organisationId)
      .single()

    if (orgError || !org) {
      logger.error('sendFirstReplyEmail: failed to fetch organisation', {
        organisation_id: params.organisationId,
        error: orgError?.message,
      })
      return { sent: false }
    }

    // Fetch prospect details (if available)
    let prospectName: string | null = null
    let prospectCompany: string | null = null
    if (params.prospectId) {
      const { data: prospect } = await params.supabase
        .from('prospects')
        .select('first_name, company_name')
        .eq('id', params.prospectId)
        .single()

      if (prospect) {
        prospectName = prospect.first_name
        prospectCompany = prospect.company_name
      }
    }

    // Fetch client email
    const { data: clientUser } = await params.supabase
      .from('users')
      .select('email')
      .eq('organisation_id', params.organisationId)
      .eq('role', 'client')
      .single()

    if (!clientUser?.email) {
      logger.warn('sendFirstReplyEmail: no client email found', {
        organisation_id: params.organisationId,
      })
      return { sent: false }
    }

    // Send with dedup (keyed to org lifetime — one email per org)
    const result = await sendTransactionalEmailWithDedup({
      supabase: params.supabase,
      organisationId: params.organisationId,
      notificationType: 'first_reply',
      subjectId: params.organisationId,  // Dedup per-org, not per-prospect
      to: clientUser.email,
      subject: firstReplySubject(),
      html: firstReplyTemplate({
        prospectName,
        prospectCompany,
      }),
      text: firstReplyTemplateText({
        prospectName,
        prospectCompany,
      }),
    })

    return { sent: result.sent }
  } catch (err) {
    logger.error('sendFirstReplyEmail: error', {
      organisation_id: params.organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false }
  }
}
