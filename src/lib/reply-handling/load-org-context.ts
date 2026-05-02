// src/lib/reply-handling/load-org-context.ts
//
// Loads organisation context needed by the reply draft orchestrator.
// Returns null if any required document is missing or its content is too thin
// to be useful (< 50 non-whitespace characters).

import { SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'

type SupabaseServiceClient = SupabaseClient<Database>

// Minimum meaningful content length — fewer non-whitespace chars indicates
// the document was saved as a placeholder or with corrupt content.
const MIN_CONTENT_CHARS = 50

export interface OrgContext {
  tovDocument: string
  positioningDocument: string
  organisationName: string
  senderFirstName: string
}

// strategy_documents.content is Json (JSONB), which the SDK returns as string | object.
// Either way, convert to a string and check minimum length.
function contentToString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.replace(/\s/g, '').length >= MIN_CONTENT_CHARS ? s : null
}

export async function loadOrgContext(
  organisationId: string,
  supabase: SupabaseServiceClient,
): Promise<OrgContext | null> {
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('name, founder_first_name')
    .eq('id', organisationId)
    .maybeSingle()

  if (orgError) {
    logger.error('loadOrgContext: organisations query failed', {
      organisation_id: organisationId,
      error: orgError.message,
    })
    return null
  }

  if (!org) {
    logger.warn('loadOrgContext: organisation not found', { organisation_id: organisationId })
    return null
  }

  const [tovResult, positioningResult] = await Promise.all([
    supabase
      .from('strategy_documents')
      .select('content')
      .eq('organisation_id', organisationId)
      .eq('document_type', 'tov')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('strategy_documents')
      .select('content')
      .eq('organisation_id', organisationId)
      .eq('document_type', 'positioning')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (tovResult.error) {
    logger.error('loadOrgContext: TOV query failed', {
      organisation_id: organisationId,
      error: tovResult.error.message,
    })
    return null
  }

  if (positioningResult.error) {
    logger.error('loadOrgContext: positioning query failed', {
      organisation_id: organisationId,
      error: positioningResult.error.message,
    })
    return null
  }

  const tovDocument = contentToString(tovResult.data?.content)
  const positioningDocument = contentToString(positioningResult.data?.content)

  if (!tovDocument) {
    logger.info('loadOrgContext: TOV document missing or too thin', {
      organisation_id: organisationId,
      has_row: !!tovResult.data,
    })
    return null
  }

  if (!positioningDocument) {
    logger.info('loadOrgContext: positioning document missing or too thin', {
      organisation_id: organisationId,
      has_row: !!positioningResult.data,
    })
    return null
  }

  return {
    tovDocument,
    positioningDocument,
    organisationName: org.name,
    senderFirstName: org.founder_first_name ?? '',
  }
}
