// LinkedIn source handler for prospect research agent v2.
// Uses Apify REST API — no LinkedIn account, no cookies, no ban risk.
// Runs ONE actor:
//   harvestapi~linkedin-profile-posts    — posts last 60 days  ($2/1000)
//
// ═════════════════════════════════════════════════════════════════════════════
// THE PROFILE ACTOR WAS DROPPED ON 2026-08-25. DO NOT REINSTATE IT WITHOUT DATA.
//
// harvestapi~linkedin-profile-scraper cost $4/1000, twice the posts actor, and produced
// nothing. Measured across the 105 fresh research runs on file:
//
//   147 of 147 LinkedIn candidates cite POSTS
//     0 of 147 cite a headline
//     1 of 147 cites a profile field, and it was never selected
//
// So the more expensive of the two actors contributed one candidate in 147 and zero
// shipped openings.
//
// WHAT IS GENUINELY LOST: headline, about, location, connections. The role history it also
// carried (current role, start date, previous roles) is DUPLICATED by Apollo, which is
// already bought at enrichment time, costs nothing extra here, and converts far better:
// 104 of 117 Apollo candidates cite employment_history and Apollo candidates clear all six
// tests at 48.7% against LinkedIn's 12.2%.
//
// THE REAL WIN IS CONCURRENCY, NOT THE $0.004. Apify's plan allows 25 concurrent actor
// runs. At two actors per prospect that capped research at 10 prospects in flight
// (job_queue config, research.maxInFlight). At one actor the same ceiling admits 20. See
// the note on maxInFlight in src/lib/queue/config.ts, which must move with this file.
// ═════════════════════════════════════════════════════════════════════════════
//
// Returns available: false (not an error) when APIFY_API_KEY is not set.
// Returns available: false with error when the API call fails.
//
// Prerequisites: Doug must sign up at apify.com, generate an API token,
// and set APIFY_API_KEY in .env.local and Vercel env vars.

import { logger } from '@/lib/logger'
import type { ProspectContext, LinkedInSourceResult } from '../types'

const APIFY_POSTS_ACTOR   = 'harvestapi~linkedin-profile-posts'
const APIFY_TIMEOUT_SEC   = 90
const APIFY_FETCH_TIMEOUT = 100_000 // ms — slightly longer than actor timeout

async function runApifyActor(
  actorId: string,
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Array<Record<string, unknown>>> {
  const url =
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items` +
    `?token=${apiKey}&timeout=${APIFY_TIMEOUT_SEC}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(APIFY_FETCH_TIMEOUT),
  })

  if (!response.ok) {
    throw new Error(`Apify actor ${actorId} returned ${response.status}`)
  }

  return await response.json() as Array<Record<string, unknown>>
}

function formatPostsData(posts: Array<Record<string, unknown>>): string {
  if (!posts.length) return ''

  const recent = posts.slice(0, 5)
  const lines = ['Recent LinkedIn posts (last 60 days):']
  for (const post of recent) {
    const text = post.text ?? post.content ?? post.commentary
    if (!text) continue
    const date = post.postedAt ?? post.date ?? ''
    const reactions = post.reactions ?? post.totalReactionCount ?? ''
    const dateStr = date ? ` (${date})` : ''
    const reactStr = reactions ? ` — ${reactions} reactions` : ''
    lines.push(`  Post${dateStr}${reactStr}: ${[...String(text)].slice(0, 300).join('')}`)
  }

  return lines.join('\n')
}

export async function fetchLinkedInSource(prospect: ProspectContext): Promise<LinkedInSourceResult> {
  const apiKey = process.env.APIFY_API_KEY
  if (!apiKey) {
    return {
      available: false,
      profile_data: null,
      recent_posts: null,
      formatted: null,
      error: 'APIFY_API_KEY not set',
    }
  }

  if (!prospect.linkedin_url) {
    return {
      available: false,
      profile_data: null,
      recent_posts: null,
      formatted: null,
      error: 'No LinkedIn URL for this prospect',
    }
  }

  // Normalise the LinkedIn URL.
  const linkedinUrl = prospect.linkedin_url.startsWith('http')
    ? prospect.linkedin_url
    : `https://www.linkedin.com/in/${prospect.linkedin_url}`

  const input = { profileUrls: [linkedinUrl] }

  try {
    // ONE actor. Promise.allSettled is gone with it: a single rejection is just a throw,
    // caught below, and settling one promise only obscured that.
    const postsData = await runApifyActor(APIFY_POSTS_ACTOR, input, apiKey)

    if (!postsData.length) {
      return {
        available: false,
        profile_data: null,
        recent_posts: null,
        formatted: null,
        error: 'Apify posts actor returned no posts',
      }
    }

    const formatted = formatPostsData(postsData) || null
    if (!formatted) {
      return { available: false, profile_data: null, recent_posts: postsData, formatted: null, error: 'Apify returned empty data' }
    }

    logger.debug('research/linkedin: Apify succeeded', {
      posts: postsData.length,
    })

    return {
      available: true,
      // Always null since the profile actor was dropped. The field is kept so stored
      // raw_linkedin rows written before 2026-08-25 keep the same shape as new ones.
      profile_data: null,
      recent_posts: postsData,
      formatted,
    }
  } catch (err) {
    logger.warn('research/linkedin: Apify call failed', { error: String(err) })
    return {
      available: false,
      profile_data: null,
      recent_posts: null,
      formatted: null,
      error: String(err),
    }
  }
}
