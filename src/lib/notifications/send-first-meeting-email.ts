// Sends FIRST_MEETING email when first meeting is booked for an organisation
// Called from meeting creation webhook/endpoint

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendTransactionalEmailWithDedup } from './send-transactional-with-dedup'
import { firstMeetingTemplate, firstMeetingTemplateText, firstMeetingSubject } from '@/lib/email/templates/first-meeting'

export interface SendFirstMeetingEmailParams {
  supabase: SupabaseClient
  organisationId: string
  meetingId: string
  prospectId?: string | null
  scheduledStartAt: string // ISO timestamp
}

export async function sendFirstMeetingEmail(
  params: SendFirstMeetingEmailParams
): Promise<{ sent: boolean }> {
  try {
    // Fetch organisation name
    const { data: org, error: orgError } = await params.supabase
      .from('organisations')
      .select('name')
      .eq('id', params.organisationId)
      .single()

    if (orgError || !org) {
      logger.error('sendFirstMeetingEmail: failed to fetch organisation', {
        organisation_id: params.organisationId,
        error: orgError?.message,
      })
      return { sent: false }
    }

    // Fetch prospect details (if available)
    let prospectName: string | null = null
    let prospectCompany: string | null = null
    let prospectTitle: string | null = null

    if (params.prospectId) {
      const { data: prospect } = await params.supabase
        .from('prospects')
        .select('first_name, company_name, job_title')
        .eq('id', params.prospectId)
        .single()

      if (prospect) {
        prospectName = prospect.first_name
        prospectCompany = prospect.company_name
        prospectTitle = prospect.job_title
      }
    }

    // Format meeting time
    const meetingDate = new Date(params.scheduledStartAt)
    const formattedTime = meetingDate.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }) + ' at ' + meetingDate.toLocaleTimeString('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })

    // Fetch client email
    const { data: clientUser } = await params.supabase
      .from('users')
      .select('email')
      .eq('organisation_id', params.organisationId)
      .eq('role', 'client')
      .single()

    if (!clientUser?.email) {
      logger.warn('sendFirstMeetingEmail: no client email found', {
        organisation_id: params.organisationId,
      })
      return { sent: false }
    }

    // Send with dedup (keyed to meeting_id, not org lifetime)
    // Rationale: if first meeting is cancelled and rebooked, the second real meeting
    // should still trigger this celebratory email. Dedup per-meeting ensures this.
    // Trade-off: user gets email for each booked meeting (even if multiple rebooks).
    // But this is correct: we celebrate real, standing meetings, not cancelled ones.
    const result = await sendTransactionalEmailWithDedup({
      supabase: params.supabase,
      organisationId: params.organisationId,
      notificationType: 'first_meeting',
      subjectId: params.meetingId,  // Dedup per-meeting, not per-org
      to: clientUser.email,
      subject: firstMeetingSubject(),
      html: firstMeetingTemplate({
        orgName: org.name,
        prospectName,
        prospectCompany,
        prospectTitle,
        meetingTime: formattedTime,
      }),
      text: firstMeetingTemplateText({
        orgName: org.name,
        prospectName,
        prospectCompany,
        prospectTitle,
        meetingTime: formattedTime,
      }),
    })

    return { sent: result.sent }
  } catch (err) {
    logger.error('sendFirstMeetingEmail: error', {
      organisation_id: params.organisationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false }
  }
}
