// LinkedIn source handler for prospect research agent v2.
// Uses Apify REST API — no LinkedIn account, no cookies, no ban risk.
// Runs two actors in parallel:
//   harvestapi~linkedin-profile-scraper  — full profile data   ($4/1000)
//   harvestapi~linkedin-profile-posts    — posts last 60 days  ($2/1000)
//
// Returns available: false (not an error) when APIFY_API_KEY is not set.
// Returns available: false with error when the API call fails.
//
// Prerequisites: Doug must sign up at apify.com, generate an API token,
// and set APIFY_API_KEY in .env.local and Vercel env vars.

import { logger } from '@/lib/logger'
import type { ProspectContext, LinkedInSourceResult } from '../types'

const APIFY_PROFILE_ACTOR = 'harvestapi~linkedin-profile-scraper'
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

function formatProfileData(profile: Record<string, unknown>): string {
  const lines: string[] = []

  if (profile.fullName)    lines.push(`Name: ${profile.fullName}`)
  if (profile.headline)    lines.push(`Headline: ${profile.headline}`)
  if (profile.about)       lines.push(`About: ${[...String(profile.about)].slice(0, 500).join('')}`)
  if (profile.location)    lines.push(`Location: ${profile.location}`)
  if (profile.connections) lines.push(`Connections: ${profile.connections}`)

  // Current position
  const positions = profile.positions as Array<Record<string, unknown>> | undefined
  if (positions?.length) {
    const current = positions.find(p => p.endDate == null)
    if (current) {
      lines.push(`Current role: ${current.title ?? ''} at ${current.companyName ?? ''}`)
      if (current.startDate) lines.push(`  Started: ${current.startDate}`)
    }
    const prev = positions.filter(p => p.endDate != null).slice(0, 2)
    if (prev.length) {
      lines.push('Previous roles:')
      prev.forEach(p => lines.push(`  - ${p.title ?? ''} at ${p.companyName ?? ''}`))
    }
  }

  return lines.filter(Boolean).join('\n')
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
    const [profileItems, postsItems] = await Promise.allSettled([
      runApifyActor(APIFY_PROFILE_ACTOR, input, apiKey),
      runApifyActor(APIFY_POSTS_ACTOR, input, apiKey),
    ])

    const profileData = profileItems.status === 'fulfilled' && profileItems.value.length > 0
      ? profileItems.value[0]
      : null

    const postsData = postsItems.status === 'fulfilled'
      ? postsItems.value
      : []

    if (!profileData && !postsData.length) {
      const profileErr = profileItems.status === 'rejected' ? String(profileItems.reason) : 'no data'
      const postsErr   = postsItems.status === 'rejected'   ? String(postsItems.reason)   : 'no data'
      return {
        available: false,
        profile_data: null,
        recent_posts: null,
        formatted: null,
        error: `Profile: ${profileErr}. Posts: ${postsErr}`,
      }
    }

    const parts: string[] = []
    if (profileData) parts.push(formatProfileData(profileData))
    if (postsData.length) parts.push(formatPostsData(postsData))

    const formatted = parts.filter(Boolean).join('\n\n') || null
    if (!formatted) {
      return { available: false, profile_data: profileData, recent_posts: postsData, formatted: null, error: 'Apify returned empty data' }
    }

    logger.debug('research/linkedin: Apify succeeded', {
      profile: !!profileData,
      posts: postsData.length,
    })

    return {
      available: true,
      profile_data: profileData,
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
