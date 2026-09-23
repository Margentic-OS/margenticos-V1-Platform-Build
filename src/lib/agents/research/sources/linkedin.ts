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
import { raiseForStatus, throwIfFatalSource } from './source-http'
import { SOURCE_RAN_FOUND_NOTHING } from '../source-skip'
import type { ProspectContext, LinkedInSourceResult } from '../types'

const APIFY_POSTS_ACTOR   = 'harvestapi~linkedin-profile-posts'
const APIFY_TIMEOUT_SEC   = 90
const APIFY_FETCH_TIMEOUT = 100_000 // ms — slightly longer than actor timeout

/**
 * How many posts the actor returns, and therefore HOW MANY WE PAY FOR.
 *
 * ═══ THE 2026-09-21 COST MEASUREMENT ═════════════════════════════════════════
 * This was unset, so the actor returned up to 50 posts per prospect. formatPostsData
 * read the first five and discarded the rest. Measured from 158 runs that day: mean
 * $0.0795 a prospect, median $0.098, and 77 of the 158 cost exactly $0.10005, which is
 * one actor start plus fifty charged post events. About 90% of the spend bought posts
 * nothing ever read.
 *
 * It is set to the number the formatter actually reads. If POSTS_SHOWN ever changes,
 * this changes with it, which is why the formatter reads this constant rather than its
 * own literal: two numbers that must agree, kept as one.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export const MAX_POSTS = 5

/**
 * The recency window, in days, enforced by the PROVIDER rather than asserted by us.
 *
 * The output used to be labelled "Recent LinkedIn posts (last 60 days)" as a hardcoded
 * string while no date filter was ever sent. Measured on 2026-09-21: of 1,140 posts
 * pulled, 936 (82%) were older than 90 days, and 35% of the posts actually shown to the
 * model were older than 90 days under that label. The model was told a recency the data
 * did not have, which is how so many candidates came back asserting "recent" with no date.
 *
 * 180 days since 2026-09-23, raised from 90. At 90 the filter was correct and too tight:
 * every prospect who had not posted in three months returned zero posts, and on the
 * 2026-09-23 run that emptied LinkedIn for several of them. A trigger list built on events
 * does not need the event to be three months old to be worth naming, and a six-month window
 * still excludes the years of stale material the unfiltered actor used to return.
 */
export const POSTED_WITHIN_DAYS = 180

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

  // READ THE BODY. This line used to be `throw new Error(...returned ${response.status})`,
  // which is why the 50 HTTP 402s on 2026-09-21 left no record of what Apify actually
  // said: the response was discarded here, and Apify keeps no run record for a call it
  // refused to start, so the reason was unrecoverable two days later.
  await raiseForStatus(`Apify actor ${actorId}`, response)

  return await response.json() as Array<Record<string, unknown>>
}

/**
 * The date a post was published, as a plain YYYY-MM-DD string.
 *
 * ═══ WHY THIS FUNCTION EXISTS ════════════════════════════════════════════════
 * `postedAt` is an OBJECT: { date, timestamp, postedAgoText }. The old formatter
 * interpolated it straight into a template literal, so every line the model read said
 *
 *     Post ([object Object]): <text>
 *
 * Every one of the 1,140 posts measured on 2026-09-21 carried a real ISO date. The
 * information was there the whole time and the formatter destroyed it on the way past,
 * which is why so many research candidates came back with `date: null` and had to assert
 * recency from a label instead.
 *
 * Returns null rather than a placeholder: a post whose date cannot be read must not be
 * given a plausible-looking one.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function postedDate(post: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    (post.postedAt as Record<string, unknown> | undefined)?.date,
    (post.postedAt as Record<string, unknown> | undefined)?.timestamp,
    post.postedDate,
    post.date,
    post.postedAt,
  ]
  for (const c of candidates) {
    if (c == null) continue
    // A timestamp arrives as a number of milliseconds; anything else is tried as a date
    // string. `new Date(object)` yields Invalid Date rather than throwing, so the
    // isNaN check below is what rejects the shape that caused the original defect.
    const d = typeof c === 'number' ? new Date(c) : new Date(String(c))
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  return null
}

/**
 * The structured fields a post can carry that the PROSE does not repeat.
 *
 * ═══ WHY THESE, MEASURED 2026-09-23 ══════════════════════════════════════════
 * The formatter read post.text/content/commentary and nothing else, so everything LinkedIn
 * supplies as structure was dropped on the way to the model. Measured across the 20:
 *
 *   one prospect, 13 Aug   prose "We're hiring!"   job.title named the role, and only job.title did
 *   Erin Spencer,  23 Jul   prose "...actively interviewing for cand..."
 *                                                   job.title "Human Resources Consultant"
 *
 * Both are hiring posts, both went to template, and the one detail that makes a hiring post
 * usable never reached the model. The candidate synthesis wrote for Jason says it outright:
 * "a hiring announcement on August 13 WITH NO ROLE SPECIFIED IN THE AVAILABLE EXCERPT". The
 * model was accurate about what it could see.
 *
 * A RESHARE IS NOT THEIR POST, and the flag is the only thing that can tell you. Without it
 * an opening can credit a prospect with something somebody else wrote, which is worse than
 * saying nothing: it is confidently wrong about their own life, in the first line.
 */
function structuredFacts(post: Record<string, unknown>): string[] {
  const out: string[] = []
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

  const job = post.job as Record<string, unknown> | undefined
  const jobTitle = job ? str(job.title) : null
  if (jobTitle) {
    const where = job ? str(job.location) : null
    out.push(`role advertised: ${jobTitle}${where ? ` (${where})` : ''}`)
  }

  const article = post.article as Record<string, unknown> | undefined
  const articleTitle = article ? str(article.title) : null
  if (articleTitle) out.push(`article: ${articleTitle}`)

  const doc = post.document as Record<string, unknown> | undefined
  const docTitle = doc ? str(doc.title) : null
  if (docTitle) out.push(`document: ${docTitle}`)

  const newsletter = str(post.newsletterTitle)
  if (newsletter) out.push(`newsletter: ${newsletter}`)

  return out
}

/** True when this post is a reshare of somebody else's, not the prospect's own. */
export function isReshare(post: Record<string, unknown>): boolean {
  if (post.repost === true || post.repostId != null || post.repostedAt != null) return true
  const by = post.repostedBy
  return !!by && typeof by === 'object'
}

function formatPostsData(posts: Array<Record<string, unknown>>): string {
  if (!posts.length) return ''

  const recent = posts.slice(0, MAX_POSTS)
  // THE LABEL NAMES THE FILTER THAT WAS ACTUALLY SENT. It is built from the same constant
  // passed to the actor, so the two cannot drift: a label describing a window nobody
  // requested is what the old "(last 60 days)" string was.
  const lines = [`Recent LinkedIn posts (provider filtered to the last ${POSTED_WITHIN_DAYS} days):`]
  for (const post of recent) {
    const text = post.text ?? post.content ?? post.commentary
    const facts = structuredFacts(post)
    // A POST WITH NO PROSE IS STILL A POST when it carries structure. The old guard was
    // `if (!text) continue`, which dropped a job share whose whole content is the job.
    if (!text && facts.length === 0) continue
    const date = postedDate(post)
    const reactions = post.reactions ?? post.totalReactionCount ?? ''
    // An undated post says so rather than being silently presented as dated.
    const dateStr = date ? ` (${date})` : ' (date not given)'
    const reactStr = reactions ? ` — ${reactions} reactions` : ''
    // MARKED, NOT DROPPED. A reshare is evidence of what they chose to amplify, which is a
    // real fact about them; it is just not something they said. The model is told which.
    const kindStr = isReshare(post) ? ' [RESHARE of someone else\'s post, not their own]' : ''
    const body = text ? [...String(text)].slice(0, 300).join('') : '(no text)'
    lines.push(`  Post${dateStr}${reactStr}${kindStr}: ${body}`)
    for (const f of facts) lines.push(`      ${f}`)
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

  // maxPosts caps what we are CHARGED for; postedLimit is the provider-side recency
  // filter. Both were absent, which is the whole of the cost and recency finding.
  // `profileUrls` is kept: the actor's published schema names `targetUrls`, but every one
  // of the 158 successful runs on 2026-09-21 sent `profileUrls` and returned posts, so it
  // is accepted. Changing it is a separate, testable question and not this commit's.
  const postedLimitDate = new Date(Date.now() - POSTED_WITHIN_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const input = {
    profileUrls: [linkedinUrl],
    maxPosts: MAX_POSTS,
    postedLimitDate,
  }

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
        // CARRIES THE MARKER, because this is not a failure: the actor ran and the
        // person has not posted inside the window. The window is named so the reason is
        // legible without reading this file.
        error: `Apify posts actor ${SOURCE_RAN_FOUND_NOTHING}: no posts in the last ${POSTED_WITHIN_DAYS} days`,
      }
    }

    const formatted = formatPostsData(postsData) || null
    if (!formatted) {
      return { available: false, profile_data: null, recent_posts: postsData, formatted: null, error: `Apify ${SOURCE_RAN_FOUND_NOTHING}: posts returned with no readable text` }
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
    // A BILLING OR AUTH FAILURE IS NOT THIS PROSPECT'S PROBLEM. 401, 402 and 403 mean the
    // account cannot call Apify at all, so the next 50 prospects will fail identically.
    // Rethrown as FatalApiError, which aborts the run. Everything else degrades as before.
    //
    // This catch swallowing a 402 is precisely the 2026-09-21 incident: 50 prospects were
    // researched without LinkedIn, the run reported success, and the copy that shipped was
    // built on employment history because that was all that was left.
    throwIfFatalSource(err, 'research/linkedin')

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
