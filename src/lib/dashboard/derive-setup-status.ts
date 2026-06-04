export type SetupStatusValue = 'pending' | 'in_progress' | 'complete'

type RegisteredCampaign = { shell_synced_at: string | null }

/**
 * Derives cold-email campaign setup status from real DB signals.
 * LinkedIn status is intentionally NOT derived here — it stays manual
 * because no system signal exists that reliably indicates LinkedIn is
 * configured and active.
 *
 * Decision:
 *   pending     = no campaigns registered at all
 *   in_progress = campaigns registered but shell unsynced OR no leads uploaded yet
 *   complete    = campaigns registered + at least one shell synced + leads uploaded
 *
 * "Complete" means the pipeline is wired and loaded, not that campaigns are live
 * (email warmup separately gates going live).
 */
export function deriveCampaignsStatus(
  registeredCampaigns: RegisteredCampaign[],
  uploadedCount: number
): SetupStatusValue {
  if (registeredCampaigns.length === 0) return 'pending'
  const hasSyncedShell = registeredCampaigns.some(c => c.shell_synced_at !== null)
  if (!hasSyncedShell || uploadedCount === 0) return 'in_progress'
  return 'complete'
}
