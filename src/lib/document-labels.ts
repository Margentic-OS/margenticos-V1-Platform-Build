// Single source of truth for document type labels in client-facing UI.
// Never show the raw database value ('icp', 'tov') to clients — always use these.

import type { DocumentType } from '@/types'

export const DOCUMENT_META: Record<DocumentType, { label: string; desc: string }> = {
  icp: {
    label: 'Prospect profile',
    desc: 'Who your ideal clients are and why they buy',
  },
  positioning: {
    label: 'Positioning',
    desc: 'Your competitive edge and core value proposition',
  },
  tov: {
    label: 'Voice guide',
    desc: 'Tone, style, and communication rules',
  },
  messaging: {
    label: 'Messaging',
    desc: 'Email and LinkedIn outreach frameworks',
  },
}

export const DOCUMENT_ORDER: DocumentType[] = ['icp', 'positioning', 'tov', 'messaging']

export function getDocumentLabel(type: DocumentType | string): string {
  return DOCUMENT_META[type as DocumentType]?.label ?? type
}
