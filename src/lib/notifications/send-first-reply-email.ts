// Sends FIRST_REPLY email when first qualifying human reply is classified
// Called from reply processing pipeline

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmailWithDedup } from './send-transactional-with-dedup'
import { firstReplyTemplate, firstReplyTemplateText, firstReplySubject, type FirstReplyVariant } from '@/lib/email/templates/first-reply'

export interface SendFirstReplyEmailParams {
  supabase: SupabaseClient
  organisationId: string
  prospectId: string | null
  classifiedIntent: string
}

// Map classified_intent to email variant
function getVariantFromIntent(intent: string): FirstReplyVariant {
  switch (intent) {
    case 'positive_direct_booking':
    case 'positive_passive':
      return 'positive'
    case 'information_request_generic':
    case 'information_request_commercial':
      return 'question'
    case 'objection_mild':
      return 'objection'
    default:
      return 'question'
  }
}

export async function sendFirstReplyEmail(
  params: SendFirstReplyEmailParams
): Promise<{ sent: boolean }> {
  try {
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

    // Determine email variant based on classified intent
    const variant = getVariantFromIntent(params.classifiedIntent)

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

    // Send with dedup
    const result = await sendTransactionalEmailWithDedup({
      supabase: params.supabase,
      organisationId: params.organisationId,
      notificationType: 'first_reply',
      subjectId: params.organisationId,
      to: clientUser.email,
      subject: firstReplySubject(variant),
      html: firstReplyTemplate({
        orgName: org.name,
        variant,
        prospectName,
        prospectCompany,
      }),
      text: firstReplyTemplateText({
        orgName: org.name,
        variant,
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
