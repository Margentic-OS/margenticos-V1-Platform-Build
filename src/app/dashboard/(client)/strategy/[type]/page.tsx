import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import * as Sentry from '@sentry/nextjs'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { DocumentHeader } from '@/components/dashboard/strategy/DocumentHeader'
import { MessagingDocumentView } from '@/components/dashboard/strategy/MessagingDocumentView'
import { IcpDocumentView } from '@/components/dashboard/strategy/IcpDocumentView'
import { PositioningDocumentView } from '@/components/dashboard/strategy/PositioningDocumentView'
import { TovDocumentView } from '@/components/dashboard/strategy/TovDocumentView'
import { SegmentTabStrip } from '@/components/dashboard/strategy/SegmentTabStrip'
import type { SegmentTab } from '@/components/dashboard/strategy/SegmentTabStrip'
import { getDocumentLabel, DOCUMENT_META } from '@/lib/document-labels'
import { PrintButton } from '@/components/dashboard/strategy/PrintButton'
import { RegenerateButton } from '@/components/dashboard/strategy/RegenerateButton'
import { DocApprovalControls } from '@/components/dashboard/strategy/DocApprovalControls'
import type { DocumentType } from '@/types'
import type { Json } from '@/types/database'

const VALID_TYPES: DocumentType[] = ['icp', 'positioning', 'tov', 'messaging']

// ICP and messaging are segment-scoped; positioning and tov are org-level.
const SEGMENT_SCOPED_TYPES: DocumentType[] = ['icp', 'messaging']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getOrgInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const days = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return '1 week ago'
  return `${Math.floor(days / 7)} weeks ago`
}

export default async function StrategyDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>
  searchParams: Promise<{ client?: string; segment?: string }>
}) {
  const { type } = await params

  if (!VALID_TYPES.includes(type as DocumentType)) {
    notFound()
  }

  const docType = type as DocumentType
  const isSegmentScoped = SEGMENT_SCOPED_TYPES.includes(docType)

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { client: clientParam, segment: segmentParam } = await searchParams
  const { organisationId, role } = await resolveViewingOrg(supabase, user, clientParam)
  const isOperatorViewing = role === 'operator'

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked, engagement_month')
    .eq('id', organisationId ?? '')
    .single()

  if (!org) redirect('/dashboard')

  // --- Segment resolution (ICP and Messaging only) ---
  let segments: SegmentTab[] = []
  let selectedSegmentId: string | null = null

  if (isSegmentScoped) {
    const { data: segRows } = await supabase
      .from('segments')
      .select('id, name, is_default')
      .eq('organisation_id', org.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true })

    segments = segRows ?? []

    const primarySegment = segments.find(s => s.is_default) ?? segments[0] ?? null

    // Validate the ?segment= param: must be a UUID belonging to the VIEWING org.
    // Foreign or malformed ids fall back to the org's primary segment.
    const candidateId = segmentParam && UUID_RE.test(segmentParam) ? segmentParam : null
    const candidateValid = candidateId ? segments.some(s => s.id === candidateId) : false

    selectedSegmentId = candidateValid ? candidateId! : (primarySegment?.id ?? null)
  }

  // --- Document fetch ---
  let docQuery = supabase
    .from('strategy_documents')
    .select('id, document_type, status, version, content, plain_text, last_updated_at, generated_at, update_trigger, client_approval_status, approval_source, approved_at, change_summary, revision_note')
    .eq('organisation_id', org.id)
    .eq('document_type', docType)
    .in('status', ['active', 'approved'])
    .order('last_updated_at', { ascending: false })
    .limit(1)

  if (isSegmentScoped) {
    // Filter by the resolved segment. If no segment exists yet, filter by null
    // so we return nothing rather than the wrong segment's doc.
    if (selectedSegmentId) {
      docQuery = docQuery.eq('segment_id', selectedSegmentId)
    } else {
      docQuery = docQuery.is('segment_id', null)
    }
  } else {
    // Positioning and TOV are org-level docs (segment_id IS NULL).
    docQuery = docQuery.is('segment_id', null)
  }

  const { data: doc, error: docError } = await docQuery.maybeSingle()

  if (docError) {
    Sentry.captureException(docError, { extra: { orgId: org.id, docType, selectedSegmentId } })
  }

  // Check whether a client revision is already staged and awaiting operator review.
  // Only messaging revisions are staged; all other document types go live immediately.
  let hasPendingRevision = false
  if (docType === 'messaging' && doc) {
    let suggQuery = supabase
      .from('document_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .eq('document_type', 'messaging')
      .eq('status', 'pending')
      .eq('update_trigger', 'client_revision')

    if (selectedSegmentId) {
      suggQuery = suggQuery.eq('segment_id', selectedSegmentId)
    } else {
      suggQuery = suggQuery.is('segment_id', null)
    }

    const { count } = await suggQuery
    hasPendingRevision = (count ?? 0) > 0
  }

  const docLabel = getDocumentLabel(docType)
  const orgInitials = getOrgInitials(org.name)
  const statusVariant = org.pipeline_unlocked ? 'live' : 'warming'
  const statusLabel = org.pipeline_unlocked ? 'Campaigns live' : 'Warming up'

  return (
    <>
      <DashboardTopbar
        eyebrow="Strategy"
        title={docLabel}
        subtitle={doc ? `v${doc.version} — updated ${formatRelativeDate(doc.last_updated_at)}` : 'Not yet generated'}
        statusLabel={statusLabel}
        statusVariant={statusVariant}
        orgInitials={orgInitials}
      />

      <div className="flex-1 overflow-y-auto print:overflow-visible bg-surface-content">
        <div className="px-7 py-7">
          {/* Print-only header with MargenticOS branding */}
          {doc && (
            <div className="hidden print:block mb-6 pb-4 border-b border-gray-200">
              <p className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">MargenticOS</p>
              <h1 className="text-[20px] font-medium text-gray-900">{docLabel}</h1>
              <p className="text-[11px] text-gray-500 mt-1">
                v{doc.version} · Generated{' '}
                {new Date(doc.generated_at ?? doc.last_updated_at).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </p>
            </div>
          )}

          {/* Segment tab strip — renders only for ICP/Messaging with 2+ segments */}
          {isSegmentScoped && selectedSegmentId && segments.length >= 2 && (
            <Suspense fallback={null}>
              <SegmentTabStrip
                segments={segments}
                selectedSegmentId={selectedSegmentId}
              />
            </Suspense>
          )}

          {docError ? (
            <DocFetchErrorState docLabel={docLabel} />
          ) : !doc ? (
            <NotYetGeneratedState docLabel={docLabel} docType={docType} />
          ) : (
            <>
              <div className="flex items-center justify-between mb-4 print:hidden">
                <DocumentHeader
                  version={doc.version}
                  updatedAt={doc.last_updated_at}
                  updateTrigger={doc.update_trigger}
                />
                <div className="flex items-center gap-4">
                  {isOperatorViewing && (
                    <RegenerateButton clientId={org.id} docType={docType} />
                  )}
                  <PrintButton />
                </div>
              </div>
              <DocApprovalControls
                docId={doc.id}
                clientApprovalStatus={doc.client_approval_status}
                approvalSource={doc.approval_source}
                changeSummary={doc.change_summary}
                revisionNote={doc.revision_note}
                isOperator={isOperatorViewing}
                hasPendingRevision={hasPendingRevision}
              />
              <DocumentContent
                docType={docType}
                content={doc.content}
                plainText={doc.plain_text}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}

function DocFetchErrorState({ docLabel }: { docLabel: string }) {
  return (
    <div className="bg-surface-card border border-[#EFBCAA] rounded-[10px] p-8 text-center">
      <div className="w-10 h-10 rounded-full bg-[#FDEEE8] flex items-center justify-center mx-auto mb-4">
        <span className="w-3 h-3 rounded-full bg-[#EFBCAA]" />
      </div>
      <p className="text-[14px] font-medium text-text-primary mb-2">
        Couldn&apos;t load your {docLabel}
      </p>
      <p className="text-[12px] text-text-secondary max-w-xs mx-auto leading-relaxed">
        Something went wrong fetching this document. Refresh to try again.
      </p>
    </div>
  )
}

function NotYetGeneratedState({ docLabel, docType }: { docLabel: string; docType: DocumentType }) {
  const desc = DOCUMENT_META[docType]?.desc ?? ''
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-8 text-center">
      <div className="w-10 h-10 rounded-full bg-[#F0ECE4] flex items-center justify-center mx-auto mb-4">
        <span className="w-3 h-3 rounded-full bg-text-muted" />
      </div>
      <p className="text-[14px] font-medium text-text-primary mb-2">{docLabel} not yet ready</p>
      <p className="text-[12px] text-text-secondary max-w-xs mx-auto leading-relaxed">
        {desc ? `${desc}. ` : ''}This document will appear here once your strategy is approved.
      </p>
    </div>
  )
}

function DocumentContent({
  docType,
  content,
  plainText,
}: {
  docType: DocumentType
  content: Json
  plainText: string | null
}) {
  if (docType === 'messaging') {
    return <MessagingDocumentView content={content} />
  }
  if (docType === 'icp') {
    return <IcpDocumentView content={content} plainText={plainText} />
  }
  if (docType === 'positioning') {
    return <PositioningDocumentView content={content} plainText={plainText} />
  }
  if (docType === 'tov') {
    return <TovDocumentView content={content} plainText={plainText} />
  }
  return null
}
