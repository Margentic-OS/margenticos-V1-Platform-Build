import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { DashboardTopbar } from '@/components/dashboard/DashboardTopbar'
import { DocumentHeader } from '@/components/dashboard/strategy/DocumentHeader'
import { MessagingDocumentView } from '@/components/dashboard/strategy/MessagingDocumentView'
import { IcpDocumentView } from '@/components/dashboard/strategy/IcpDocumentView'
import { PositioningDocumentView } from '@/components/dashboard/strategy/PositioningDocumentView'
import { TovDocumentView } from '@/components/dashboard/strategy/TovDocumentView'
import { getDocumentLabel, DOCUMENT_META } from '@/lib/document-labels'
import { PrintButton } from '@/components/dashboard/strategy/PrintButton'
import type { DocumentType } from '@/types'
import type { Json } from '@/types/database'

const VALID_TYPES: DocumentType[] = ['icp', 'positioning', 'tov', 'messaging']

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
}: {
  params: Promise<{ type: string }>
}) {
  const { type } = await params

  if (!VALID_TYPES.includes(type as DocumentType)) {
    notFound()
  }

  const docType = type as DocumentType

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: org } = await supabase
    .from('organisations')
    .select('id, name, pipeline_unlocked, engagement_month')
    .single()

  if (!org) redirect('/dashboard')

  const { data: doc } = await supabase
    .from('strategy_documents')
    .select('document_type, status, version, content, plain_text, last_updated_at, generated_at, update_trigger')
    .eq('organisation_id', org.id)
    .eq('document_type', docType)
    .in('status', ['active', 'approved'])
    .order('last_updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const docLabel = getDocumentLabel(docType)
  const orgInitials = getOrgInitials(org.name)
  const statusVariant = org.pipeline_unlocked ? 'live' : 'warming'
  const statusLabel = org.pipeline_unlocked ? 'Campaigns live' : 'Warming up'

  return (
    <>
      <DashboardTopbar
        eyebrow="Strategy"
        title={docLabel}
        subtitle={doc ? `v${doc.version} — updated ${formatRelativeDate(doc.last_updated_at)}` : ''}
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

          {!doc ? (
            <NotYetGeneratedState docLabel={docLabel} docType={docType} />
          ) : (
            <>
              <div className="flex items-center justify-between mb-4 print:hidden">
                <DocumentHeader
                  version={doc.version}
                  updatedAt={doc.last_updated_at}
                  updateTrigger={doc.update_trigger}
                />
                <PrintButton />
              </div>
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
