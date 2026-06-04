export function approvalSourceLabel(source: string | null): string {
  if (source === 'client') return 'Approved by you'
  if (source === 'operator') return 'Approved by MargenticOS'
  if (source === 'auto') return 'Auto-approved after the review window'
  return 'Approved'
}
