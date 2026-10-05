// A regional campaign switches itself on when its first leads arrive, and the client's daily
// sending stays at its configured total.
//
// Operator instruction 2026-10-05. A client runs one catch-all campaign and, optionally,
// regional ones (campaigns.region_countries). A regional campaign is created paused. The first
// upload that routes leads to it activates it, and the daily limits are re-split so the client
// total stays at organisations.outbound_daily_cap:
//
//   regional campaign   its own campaigns.daily_limit_share
//   catch-all           the cap minus the shares of the LIVE regional campaigns
//
// So before UK/IE has leads the US campaign carries the whole 90; once UK/IE is live it is
// US 75, UK/IE 15. The catch-all's figure is derived, never stored, so the parts cannot drift
// from the total.
//
// ORDER IS THE SAFETY PROPERTY. Limits that go DOWN are applied before limits that go UP, and
// the activation comes last. At every instant the client's total is at or below its cap, and if
// any limit write fails nothing is activated: a paused campaign that should be live costs a
// day's sends, an over-cap total risks the mailboxes.
//
// Vendor-neutral: the provider is reached through CampaignControls (ADR-001). Deterministic, no
// model call (ADR-018). Every step, including every refusal, is handed to `log`, which the
// upload action writes to campaign_automation_log and the upload panel shows.

export interface ManagedCampaign {
  id: string
  externalId: string
  name: string | null
  regionCountries: string[] | null
  dailyLimitShare: number | null
  status: string
  sentCount: number
  autoActivatedAt: string | null
}

export interface CampaignControls {
  /** The provider's current daily limit, or null when it carries none. */
  readDailyLimit(externalId: string): Promise<number | null>
  /** Sets and READS BACK the daily limit; throws unless the read-back matches. */
  setDailyLimit(externalId: string, limit: number): Promise<void>
  /** Activates and READS BACK the status; throws unless the campaign reads as active. */
  activate(externalId: string): Promise<void>
}

export type AutomationAction = 'activated' | 'daily_limit_set' | 'refused' | 'failed'

export interface AutomationEntry {
  campaignId: string | null
  action: AutomationAction
  fromValue: string | null
  toValue: string | null
  detail: string
}

const label = (c: ManagedCampaign) => c.name ?? c.externalId

/** Paused (or draft), regional, has never sent, and was never switched on by an upload. */
export function awaitsFirstLeads(c: ManagedCampaign): boolean {
  return c.regionCountries !== null
    && (c.status === 'paused' || c.status === 'draft')
    && c.sentCount === 0
    && c.autoActivatedAt === null
}

function isLive(c: ManagedCampaign, activating: ReadonlySet<string>): boolean {
  return c.status === 'active' || c.autoActivatedAt !== null || activating.has(c.id)
}

/**
 * The daily limit each campaign should carry, given which regional campaigns are live.
 * Refuses when the configuration cannot honour the cap: a regional campaign with no share,
 * more than one catch-all, or live shares that leave the catch-all nothing.
 */
export function computeDailyLimits(
  cap: number,
  campaigns: readonly ManagedCampaign[],
  activating: ReadonlySet<string>,
): { ok: true; limits: Map<string, number> } | { ok: false; reason: string } {
  const catchAlls = campaigns.filter(c => c.regionCountries === null)
  if (catchAlls.length > 1) return { ok: false, reason: `${catchAlls.length} catch-all campaigns, so the cap cannot be split` }

  const limits = new Map<string, number>()
  let liveShares = 0
  for (const c of campaigns) {
    if (c.regionCountries === null) continue
    if (c.dailyLimitShare === null) {
      return { ok: false, reason: `regional campaign ${label(c)} has no daily_limit_share configured` }
    }
    limits.set(c.id, c.dailyLimitShare)
    if (isLive(c, activating)) liveShares += c.dailyLimitShare
  }

  if (catchAlls.length === 1) {
    const rest = cap - liveShares
    if (rest < 1) return { ok: false, reason: `live regional shares (${liveShares}) leave nothing of the ${cap} cap for ${label(catchAlls[0])}` }
    limits.set(catchAlls[0].id, rest)
  } else if (liveShares > cap) {
    return { ok: false, reason: `live regional shares (${liveShares}) exceed the ${cap} cap` }
  }
  return { ok: true, limits }
}

/**
 * Called once per upload, after the leads went out. `receivedLeads` holds the ids of the
 * campaigns this upload actually added leads to. Returns every entry it logged.
 */
export async function activateRegionalCampaigns(args: {
  cap: number | null
  campaigns: readonly ManagedCampaign[]
  receivedLeads: ReadonlySet<string>
  controls: CampaignControls
  log: (entry: AutomationEntry) => Promise<void>
  markActivated: (campaignId: string) => Promise<void>
}): Promise<AutomationEntry[]> {
  const { cap, campaigns, receivedLeads, controls } = args
  const written: AutomationEntry[] = []
  const log = async (e: AutomationEntry) => { written.push(e); await args.log(e) }

  const toActivate = campaigns.filter(c => receivedLeads.has(c.id) && awaitsFirstLeads(c))
  if (toActivate.length === 0) return written

  if (cap === null) {
    for (const c of toActivate) {
      await log({ campaignId: c.id, action: 'refused', fromValue: null, toValue: null,
        detail: `${label(c)} received its first leads but was left paused: this client has no outbound_daily_cap, so the daily limits cannot be split.` })
    }
    return written
  }

  const activating = new Set(toActivate.map(c => c.id))
  const plan = computeDailyLimits(cap, campaigns, activating)
  if (!plan.ok) {
    for (const c of toActivate) {
      await log({ campaignId: c.id, action: 'refused', fromValue: null, toValue: null,
        detail: `${label(c)} received its first leads but was left paused: ${plan.reason}.` })
    }
    return written
  }

  // Read every current limit first, so the order below can put decreases before increases.
  const changes: Array<{ c: ManagedCampaign; from: number | null; to: number }> = []
  for (const c of campaigns) {
    const to = plan.limits.get(c.id)
    if (to === undefined) continue
    let from: number | null
    try {
      from = await controls.readDailyLimit(c.externalId)
    } catch (err) {
      await log({ campaignId: c.id, action: 'failed', fromValue: null, toValue: String(to),
        detail: `Could not read ${label(c)}'s daily limit (${why(err)}). Nothing was changed and nothing was activated.` })
      return written
    }
    if (from !== to) changes.push({ c, from, to })
  }
  changes.sort((a, b) => (a.to - (a.from ?? 0)) - (b.to - (b.from ?? 0)))

  for (const { c, from, to } of changes) {
    try {
      await controls.setDailyLimit(c.externalId, to)
    } catch (err) {
      await log({ campaignId: c.id, action: 'failed', fromValue: from === null ? null : String(from), toValue: String(to),
        detail: `Could not set ${label(c)}'s daily limit to ${to} (${why(err)}). Nothing was activated, so the client stays at or under its ${cap} a day.` })
      return written
    }
    await log({ campaignId: c.id, action: 'daily_limit_set', fromValue: from === null ? null : String(from), toValue: String(to),
      detail: `${label(c)} daily limit ${from ?? 'unset'} to ${to}, keeping the client's total at ${cap} a day.` })
  }

  for (const c of toActivate) {
    try {
      await controls.activate(c.externalId)
    } catch (err) {
      await log({ campaignId: c.id, action: 'failed', fromValue: c.status, toValue: 'active',
        detail: `Could not activate ${label(c)} (${why(err)}). Its leads wait in the paused campaign; the limits above already leave room for it.` })
      continue
    }
    await args.markActivated(c.id)
    await log({ campaignId: c.id, action: 'activated', fromValue: c.status, toValue: 'active',
      detail: `${label(c)} activated automatically: this upload gave it its first leads.` })
  }
  return written
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
