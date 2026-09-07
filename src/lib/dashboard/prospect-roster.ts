// Grouping for the client prospect roster.
//
// The roster is a PERMANENT RECORD of who is being contacted, not a review queue.
// See Decisions Log: "The prospect list persists as a permanent record, and shows only
// people being contacted" (2026-09-07), which supersedes the 2026-08-11 decision that
// hid the tab once the client had approved.
//
// WHY THE TWO STATES USE DIFFERENT RULES, because it looks like an inconsistency and is
// not. Before approval the list asks "who should we contact", so it excludes anyone not
// currently sendable: there is no point asking a client to spend attention removing
// someone we were never going to email. After approval it asks "who ARE we contacting",
// so it keys on the upload date instead.
//
// That difference is load-bearing. Measured on the live organisation 2026-09-07, two
// prospects in the 2026-08-21 batch are country_excluded_de but were uploaded and mailed
// BEFORE that exclusion existed. Keying the post-approval view on upload date rather than
// on current sendability keeps them visible, which is correct for a record of who was
// contacted. A current-sendability filter would erase the evidence that we mailed them.
//
// NOTHING DISAPPEARS. Prospects approved but never uploaded get their own group rather
// than being filtered out. 12 of the 15 in that group on the live organisation are
// 'Catch All' verifications, and the SAME status reads eligible=true on 25 uploaded
// prospects: the verdict is frozen at verification time, so those 12 are plausibly
// artefacts of timing rather than genuinely unreachable people. Hiding someone on the
// strength of a verdict known to be inconsistent is not a filter, it is a guess. When one
// becomes reachable it moves into that batch's group on its own, which is the whole
// reason the grouping key is the upload date.

export interface RosterProspect {
  id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  job_title: string | null
  linkedin_url: string | null
  website_url: string | null
  client_review_status: string | null
  outbound_upload_attempted_at: string | null
  email_send_eligible: boolean | null
}

export interface RosterGroup {
  /** Stable identifier for tab selection. Never shown to the client. */
  key: string
  /** Tab label. Plain language, never client-specific or industry-specific. */
  label: string
  /** One line under the tab explaining what the group is. */
  subtitle: string
  /**
   * A group is a TASK while it still holds prospects awaiting the client's decision.
   * Task groups carry Remove and Approve; every other group is a read-only record.
   */
  isTask: boolean
  prospects: RosterProspect[]
}

export const NOT_YET_IN_CAMPAIGN_KEY = 'not-yet-in-campaign'

function isPending(p: RosterProspect): boolean {
  return p.client_review_status === 'pending_review'
}

/**
 * The UTC calendar day a prospect entered the campaign, or null if it has not.
 *
 * UTC deliberately, so a batch does not split across two tabs for a client reading in a
 * different timezone than the one that ran the upload.
 */
function uploadDayKey(p: RosterProspect): string | null {
  if (!p.outbound_upload_attempted_at) return null
  const parsed = new Date(p.outbound_upload_attempted_at)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/**
 * "2026-09-07" -> "7 Sep 2026".
 *
 * SPELLED OUT RATHER THAN toLocaleDateString, deliberately. The Intl short month name is
 * ICU-version dependent: the same call renders "Sep" on one Node build and "Sept" on
 * another, so a date label would drift between environments and between a developer's
 * machine and production. A fixed table is the whole of the requirement here.
 */
export function formatDayLabel(isoDate: string): string {
  const parsed = new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate)
  if (Number.isNaN(parsed.getTime())) return isoDate
  return `${parsed.getUTCDate()} ${MONTH_LABELS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`
}

/**
 * Build the roster groups a client sees.
 *
 * Two exclusions, and only two:
 *   1. Anyone the client rejected. Showing them back would contradict the client's own
 *      removal, and it is the one thing that SHOULD leave the list.
 *   2. Anyone still awaiting a decision who is not currently sendable, so the client is
 *      never asked to consider someone we cannot email today.
 *
 * Everything else appears, in the batch it entered the campaign with, or in the
 * "Not yet in the campaign" group if it has not entered one.
 */
export function buildRosterGroups(prospects: RosterProspect[]): RosterGroup[] {
  const visible = prospects.filter(p => {
    if (p.client_review_status === 'rejected') return false
    if (isPending(p) && p.email_send_eligible !== true) return false
    return true
  })

  const byDay = new Map<string, RosterProspect[]>()
  const notYet: RosterProspect[] = []

  for (const prospect of visible) {
    const dayKey = uploadDayKey(prospect)
    if (dayKey === null) {
      notYet.push(prospect)
      continue
    }
    const existing = byDay.get(dayKey)
    if (existing) existing.push(prospect)
    else byDay.set(dayKey, [prospect])
  }

  // Newest batch first: a record is read from the most recent activity backwards.
  const datedGroups: RosterGroup[] = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dayKey, groupProspects]) => ({
      key: `batch:${dayKey}`,
      label: formatDayLabel(dayKey),
      subtitle: `Added to your campaign on ${formatDayLabel(dayKey)}.`,
      isTask: groupProspects.some(isPending),
      prospects: groupProspects,
    }))

  if (notYet.length === 0) return datedGroups

  const notYetIsTask = notYet.some(isPending)

  return [
    ...datedGroups,
    {
      key: NOT_YET_IN_CAMPAIGN_KEY,
      label: 'Not yet in the campaign',
      subtitle: notYetIsTask
        ? 'Waiting for your review. Remove anyone you would rather we did not contact.'
        : 'Approved and waiting to be added to a batch.',
      isTask: notYetIsTask,
      prospects: notYet,
    },
  ]
}

/**
 * Which tab opens first: the one with work in it, otherwise the newest batch.
 *
 * Group order stays stable regardless, so a client returning to the page does not find
 * the tabs rearranged; only the initial selection moves.
 */
export function defaultGroupKey(groups: RosterGroup[]): string | null {
  if (groups.length === 0) return null
  return (groups.find(g => g.isTask) ?? groups[0]).key
}

/** Prospects still awaiting a decision, across every group. Drives the Approve control. */
export function countPending(groups: RosterGroup[]): number {
  return groups.reduce(
    (total, group) => total + group.prospects.filter(isPending).length,
    0,
  )
}

/** Everyone on the roster, across every group. */
export function countRoster(groups: RosterGroup[]): number {
  return groups.reduce((total, group) => total + group.prospects.length, 0)
}
