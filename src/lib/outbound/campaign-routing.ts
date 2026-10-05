// Which of a segment's campaigns a prospect is uploaded to, decided by the prospect's country.
//
// A client may run several campaigns for one segment, each serving a region with its own
// send window (campaigns.region_countries). A campaign whose region_countries is NULL is the
// CATCH-ALL: it takes every country no sibling names, and every prospect whose country is
// unknown. Every campaign that existed before regions is a catch-all, so a segment with one
// campaign routes exactly as it always did.
//
// Deterministic, no provider and no database: the caller hands in the segment's campaigns.
// It REFUSES rather than guesses whenever the configuration does not give exactly one answer,
// because an upload cannot be taken back and a lead in the wrong campaign is mailed in the
// wrong time zone with nothing to say so.

import { toIso2CountryCode } from '@/lib/sourcing/country-code'

export interface RoutableCampaign {
  id: string
  region_countries: string[] | null
}

export type CampaignRoute<C extends RoutableCampaign> =
  | { ok: true; campaign: C }
  | { ok: false; reason: string }

export function routeProspectToCampaign<C extends RoutableCampaign>(
  campaigns: readonly C[],
  rawCountry: string | null | undefined,
  segmentLabel: string,
): CampaignRoute<C> {
  if (campaigns.length === 0) {
    return { ok: false, reason: `No campaign configured for segment ${segmentLabel}. Register a campaign before uploading.` }
  }

  // The configuration is checked BEFORE the prospect, so a broken set refuses every
  // prospect alike rather than only the ones that happen to land on the overlap.
  const config = checkRegionConfig(campaigns)
  if (!config.ok) return { ok: false, reason: `Segment ${segmentLabel}: ${config.reason} Fix in campaign settings.` }

  const country = toIso2CountryCode(rawCountry)
  if (country !== null) {
    const named = campaigns.find(c => (c.region_countries ?? []).includes(country))
    if (named) return { ok: true, campaign: named }
  }

  const catchAll = campaigns.find(c => c.region_countries === null)
  if (catchAll) return { ok: true, campaign: catchAll }

  return {
    ok: false,
    reason: `Segment ${segmentLabel} has no campaign for ${country ?? 'an unknown country'} and no catch-all campaign. Add the country to a campaign's region, or register a catch-all campaign.`,
  }
}

/** At most one catch-all per segment, and no country named by two campaigns. */
export function checkRegionConfig(campaigns: readonly RoutableCampaign[]): { ok: true } | { ok: false; reason: string } {
  const catchAlls = campaigns.filter(c => c.region_countries === null)
  if (catchAlls.length > 1) {
    return { ok: false, reason: `${catchAlls.length} campaigns have no region, so routing is ambiguous.` }
  }
  const owner = new Map<string, string>()
  for (const c of campaigns) {
    for (const code of c.region_countries ?? []) {
      const prior = owner.get(code)
      if (prior !== undefined && prior !== c.id) {
        return { ok: false, reason: `${code} is named by two campaigns, so routing is ambiguous.` }
      }
      owner.set(code, c.id)
    }
  }
  return { ok: true }
}
