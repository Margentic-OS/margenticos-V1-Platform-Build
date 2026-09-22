'use client'

import { useState, useMemo, useTransition } from 'react'
import Link from 'next/link'
import type { Database } from '@/types/database'
import { normalizeUrl } from '@/lib/url/normalize'
import { StopProspectControl } from './StopProspectControl'
import {
  parseTieringReason,
  whyNotSendable,
  DISQUALIFIER_LABELS,
  SCORE_COMPONENT_LABELS,
  NOT_SENDABLE_LABELS,
} from '@/lib/operator/prospect-status'

type Prospect = Database['public']['Tables']['prospects']['Row']

async function publishAllTiersForClient(organisationId: string) {
  const response = await fetch(`/api/operator/organisations/${organisationId}/publish-all-tiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to publish prospects')
  }

  return response.json()
}

interface Gate2TieredReviewProps {
  prospects: Prospect[]
  organisationId: string
  organisationName: string
  tiering: {
    tier_1: Prospect[]
    tier_2: Prospect[]
    tier_3: Prospect[]
  }
  /** tiering_reason -> count, for the prospects tiering removed. Counted server-side. */
  removedByReason: Record<string, number>
  removedCount: number
  /** Tiered prospects the client has not been shown yet. What publishing will act on. */
  unpublishedCount: number
  /** Variants whose fallback opening does not read as a first line. See item 16. */
  openingReport: {
    variantsChecked: number
    findings: Array<{
      variantId: string
      opening: string
      faults: Array<{ kind: string; phrase: string; detail: string }>
    }>
  }
}

// The removal-reason gloss lives in prospect-status.ts, with the rest of the
// operator-facing wording for these codes. It used to be a second copy here, and the copy
// had drifted: it said "Company over 100 people", hard-coding a threshold that belongs to
// the ICP specification and is not this component's to assert, and it explained one code
// using internal vocabulary a screen should not carry. A code with no gloss still renders,
// under its raw value, because an unglossed reason must look odd rather than disappear.

const tierConfig = {
  tier_1: {
    label: 'Tier 1: Best fit',
    textColor: 'text-[#3B6D11]',
    bgColor: 'bg-[#EBF5E6]',
    borderColor: 'border-[#BDDAB0]',
    description: 'Verified email, seniority, headcount, industry match.',
  },
  tier_2: {
    label: 'Tier 2: Good fit',
    textColor: 'text-[#5D7F23]',
    bgColor: 'bg-[#EAF3DE]',
    borderColor: 'border-[#C0DD97]',
    description: 'Verified email, seniority, one or more relaxed firmographics.',
  },
  tier_3: {
    label: 'Tier 3: Acceptable',
    textColor: 'text-[#9A9488]',
    bgColor: 'bg-[#F0ECE4]',
    borderColor: '',
    description: 'Verified email, seniority, significantly relaxed fit.',
  },
}

/** tiering_reason, rendered as what it says rather than as the string it is stored in. */
function TieringReasonCell({ reason }: { reason: string | null }) {
  const verdict = parseTieringReason(reason)

  if (verdict.kind === 'not_tiered') {
    return <span className="text-text-secondary">Not tiered yet</span>
  }

  if (verdict.kind === 'disqualified') {
    return (
      <span className="text-[#8B2020]">{DISQUALIFIER_LABELS[verdict.code] ?? verdict.code}</span>
    )
  }

  // Carried through verbatim rather than hidden. The live data holds one legacy code that
  // the classifier no longer writes, and it is exactly the row worth noticing.
  if (verdict.kind === 'unrecognised') {
    return <span className="text-[#7A4800] font-mono">{verdict.raw}</span>
  }

  return (
    <div className="text-text-secondary">
      <span className="font-medium text-text-primary">{verdict.score}</span>
      <span className="ml-1">
        (
        {verdict.components
          .map(c => `${SCORE_COMPONENT_LABELS[c.name] ?? c.name} ${c.points}`)
          .join(', ')}
        )
      </span>
    </div>
  )
}

/** Whether the send path will actually send to this address, and if not, why not. */
function SendabilityCell({ prospect }: { prospect: Prospect }) {
  const reason = whyNotSendable(prospect)

  if (reason === null) {
    return (
      <span className="inline-block px-2 py-0.5 rounded-sm text-xs font-medium bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]">
        Yes
      </span>
    )
  }

  return (
    <span className="text-xs text-[#8B2020]">{NOT_SENDABLE_LABELS[reason]}</span>
  )
}

/**
 * WHAT THIS PROSPECT'S EMAIL WILL ACTUALLY OPEN WITH.
 *
 * The quality screen is the last look before a list is published, and the one thing it could
 * not show was the line the prospect reads first. An operator could check the company, the
 * title, the tier and the address, and not the copy.
 *
 * TWO STATES, BOTH STATED PLAINLY. A researched prospect has a stored opening written for
 * them. A prospect without one is NOT broken and is not skipped: composition ships the
 * variant's own authored opening instead. That is a deliberate design (four authored
 * openings rather than one shared line) and saying "none" would read as a fault.
 *
 * ── WHY THE COLUMN HAS A MINIMUM WIDTH AND NOT A MAXIMUM ────────────────────
 *
 * The cell carried max-w-[320px], which sets a ceiling and no floor. This is the eleventh
 * column of eleven in an auto-laid-out table, so the browser gives the longest text column
 * whatever is left once the other ten have taken what they need, and a ceiling does nothing
 * to stop that. What arrived on screen was a few words per line down a ribbon, which cannot
 * be read as a sentence at all.
 *
 * Measured on the live prospects table 2026-09-22: 222 stored openings, 143 to 341
 * characters, average 245. These are paragraphs. A min-width is used as a floor
 * instead, wide enough for roughly sixty characters a line, so an average opening lands in
 * about four lines. The table already sits in an overflow-x-auto wrapper, so the cost is
 * sideways scrolling on a narrow window rather than an unreadable column on every window.
 *
 * THE FLOOR SITS ON A BLOCK INSIDE THE CELL, NOT ON THE td. min-width on a table cell under
 * auto layout is a hint the engine is free to disregard, which is how a width silently
 * stops applying. A block child's minimum is a real contribution to the column's width, and
 * the header needs nothing: a column is as wide as its widest cell, and these are.
 *
 * WIDER RATHER THAN CLICK-TO-EXPAND, deliberately. This is a bulk review screen: the
 * operator reads every row before publishing, twenty at a time and 108 in the run that
 * prompted this. An expander would charge a click per prospect for the thing they came to
 * do, and a row-at-a-time reveal cannot be scanned down the column to spot four openings
 * that say the same thing. The hover title is kept, for the rare opening that still runs
 * long.
 */
function OpeningLineCell({ prospect }: { prospect: Prospect }) {
  const opening = prospect.personalisation_trigger

  // BOTH STATES GET THE SAME FLOOR. A tier in which nothing has been researched would
  // otherwise render a narrow column, and the column would change width between tiers.
  if (!opening) {
    return (
      <div className="min-w-[380px] text-xs text-text-secondary">
        No research: gets the standard opener for its variant
      </div>
    )
  }

  return (
    <div className="min-w-[380px] text-xs text-text-primary leading-relaxed" title={opening}>
      {opening}
    </div>
  )
}

function ProspectRow({ prospect }: { prospect: Prospect }) {
  const headcountText = prospect.company_headcount
    ? `${prospect.company_headcount} ${prospect.company_headcount === 1 ? 'person' : 'people'}`
    : 'Pending enrichment'

  return (
    <tr className="hover:bg-[#FAFAF8] transition-colors">
      <td className="px-4 py-3 text-text-primary font-medium">
        {prospect.first_name} {prospect.last_name}
      </td>
      <td className="px-4 py-3 text-text-secondary font-mono text-xs max-w-[180px] truncate" title={prospect.email || undefined}>
        {prospect.email}
      </td>
      <td className="px-4 py-3 text-text-primary">{prospect.company_name || '—'}</td>
      <td className="px-4 py-3 text-text-secondary">{prospect.job_title || 'Pending enrichment'}</td>
      <td className="px-4 py-3 text-text-secondary">{headcountText}</td>
      <td className="px-4 py-3 text-text-secondary">{prospect.company_industry || 'Pending enrichment'}</td>
      <td className="px-4 py-3">
        {prospect.linkedin_url ? (
          <a
            href={normalizeUrl(prospect.linkedin_url) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline text-xs font-medium"
          >
            Profile →
          </a>
        ) : (
          <span className="text-text-secondary text-xs">Not enriched</span>
        )}
      </td>
      <td className="px-4 py-3">
        {prospect.website_url ? (
          <a
            href={normalizeUrl(prospect.website_url) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline text-xs font-medium"
          >
            Website →
          </a>
        ) : (
          <span className="text-text-secondary text-xs italic">not enriched</span>
        )}
      </td>
      {/* WHY THIS PROSPECT LANDED IN THIS TIER.
          This cell used to render tiering_reason raw, inside a 140-pixel truncate. For a
          kept prospect the stored value is
              tier_1 (score 100): industry 45, seniority 35, headcount 20
          so what an operator actually saw was "tier_1 (score 100)..." and the part that
          explains the score was cut off. The reason was on screen and unreadable. */}
      <td className="px-4 py-3 text-xs">
        <TieringReasonCell reason={prospect.tiering_reason} />
      </td>

      {/* The first line the prospect reads, which this screen could not show at all. */}
      <td className="px-4 py-3 align-top">
        <OpeningLineCell prospect={prospect} />
      </td>

      {/* CAN THIS BE EMAILED, which is the question, rather than whether a verification
          row exists. On production 2026-09-02 the platform held 132 prospects reading
          "verified" and 89 that could actually be emailed. */}
      <td className="px-4 py-3">
        <SendabilityCell prospect={prospect} />
      </td>

      {/* STOP CONTACTING. The control that did not exist: every mechanism for stopping
          somebody was already built and none of them could be reached by an operator
          deciding to use one, so it meant clicking in the vendor's own UI. */}
      <td className="px-4 py-3">
        <StopProspectControl prospectId={prospect.id} alreadyStopped={prospect.suppressed} />
      </td>
    </tr>
  )
}

function TierSection({
  tier,
  prospects,
  config,
}: {
  tier: string
  prospects: Prospect[]
  config: (typeof tierConfig)['tier_1']
}) {
  const [expanded, setExpanded] = useState(tier === 'tier_1')
  const [showAll, setShowAll] = useState(false)

  const displayed = showAll ? prospects : prospects.slice(0, 20)
  const hasMore = prospects.length > 20

  return (
    <div className="bg-white rounded-[10px] border border-border-card overflow-hidden">
      <div className="border-b border-[#E8E2D8]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-[#FAFAF8] transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-transform ${expanded ? 'rotate-90' : ''}`} />
            <h3 className={`font-medium ${config.textColor}`}>{config.label}</h3>
            <span className={`text-xs font-medium px-2 py-1 rounded-sm ${config.bgColor} ${config.textColor} ${config.borderColor ? `border ${config.borderColor}` : ''}`}>
              {prospects.length} prospects
            </span>
            {/* The second number, because the first one is not the number a campaign gets. */}
            <span className="text-xs text-text-secondary">
              {prospects.filter(p => whyNotSendable(p) === null).length} can be emailed
            </span>
          </div>
        </button>
      </div>

      {expanded && (
        <div>
          <div className="px-6 py-3 bg-[#F0ECE4] text-xs text-text-secondary border-b border-[#E8E2D8]">
            {config.description}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#F8F4EE]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Email</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Company</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Job title</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Headcount</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Industry</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">LinkedIn</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Website</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Why this tier</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Opening line</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Can be emailed</th>
                  <th className="px-4 py-3 text-left font-medium text-text-primary">Stop</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8E2D8]">
                {displayed.map((prospect) => (
                  <ProspectRow key={prospect.id} prospect={prospect} />
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-[#F8F4EE] transition-colors border-t border-[#E8E2D8]"
            >
              View all {prospects.length} prospects
            </button>
          )}

          {showAll && hasMore && (
            <button
              onClick={() => setShowAll(false)}
              className="w-full px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-[#F8F4EE] transition-colors border-t border-[#E8E2D8]"
            >
              Show top 20
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Gate2TieredReview({
  prospects: _prospects,
  organisationId,
  organisationName,
  tiering,
  removedByReason,
  removedCount,
  unpublishedCount,
  openingReport,
}: Gate2TieredReviewProps) {
  const [, startTransition] = useTransition()
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishSuccess, setPublishSuccess] = useState(false)

  const totalEnriched = tiering.tier_1.length + tiering.tier_2.length + tiering.tier_3.length

  const handlePublishAll = () => {
    setPublishError(null)
    setPublishSuccess(false)
    startTransition(async () => {
      try {
        await publishAllTiersForClient(organisationId)
        setPublishSuccess(true)
      } catch (err) {
        setPublishError(err instanceof Error ? err.message : 'Failed to publish prospects')
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="bg-white rounded-[10px] border border-border-card p-6">
        <div className="flex items-start justify-between mb-4">
          {/* BOTH NUMBERS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS. The tier total is
              everything on this screen, across every sourcing run this client has had. The
              second is what pressing the button would actually do: publishing has always
              filtered on tier_published_at IS NULL, so the rest are already with the
              client. Only one heading said so, and it was the wrong one. */}
          <h2 className="text-base font-medium text-text-primary">
            Check quality, then publish: {unpublishedCount} of {totalEnriched} not yet sent
            to the client
          </h2>
          <button
            onClick={handlePublishAll}
            disabled={publishSuccess || unpublishedCount === 0}
            className="px-4 py-2 text-sm font-medium bg-[#2d5a27] text-[#f5f0e8] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {publishSuccess
              ? 'Published for client review'
              : unpublishedCount === 0
                ? 'Everything here is already published'
                : `Publish ${unpublishedCount} for client review`}
          </button>
        </div>

        {publishError && (
          <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA]">
            <p className="text-xs text-[#8B2020]">{publishError}</p>
          </div>
        )}

        {publishSuccess && (
          <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#EBF5E6] border border-[#BDDAB0]">
            <p className="text-xs text-[#3B6D11]">Published for client review. Client will receive an email.</p>
          </div>
        )}

        {/* Both numbers, at the top of the screen. The tier total is how many prospects
            tiering kept; the second line is how many of those a campaign can actually use.
            On production the day this shipped those were 93 and 73. */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {([
            ['Tier 1', tiering.tier_1, 'text-[#3B6D11]'],
            ['Tier 2', tiering.tier_2, 'text-[#5D7F23]'],
            ['Tier 3', tiering.tier_3, 'text-[#9A9488]'],
          ] as const).map(([label, rows, colour]) => (
            <div key={label}>
              <p className={`text-xs uppercase font-normal tracking-[0.07em] ${colour} mb-1`}>
                {label}
              </p>
              <p className="text-2xl font-medium text-text-primary">{rows.length}</p>
              {rows.length > 0 && (
                <p className="text-xs text-text-secondary mt-1">
                  {rows.filter(p => whyNotSendable(p) === null).length} can be emailed
                </p>
              )}
            </div>
          ))}
        </div>

        <p className="text-xs text-text-secondary">
          Review a sample from each tier to verify fit. Tiering is based on ICP filter criteria: email verification, seniority, headcount, and industry match.
        </p>
      </div>

      {/* Removed before tiering.
          The three tier counts above are survivors. Without this block the screen
          reports a short list and gives no indication of what it is short OF, which
          is how a filter that removes most of a batch stays invisible. */}
      {removedCount > 0 && (
        <div className="bg-white rounded-[10px] border border-border-card p-6">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-base font-medium text-text-primary">
              {removedCount} removed before tiering
            </h2>
            <span className="text-xs text-text-secondary">
              Not shown in the tiers above
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {Object.entries(removedByReason)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <div key={reason} className="bg-[#FAEEDA] rounded-[8px] p-3 border border-[#F0D080]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#7A4800] mb-2">
                    {DISQUALIFIER_LABELS[reason] ?? reason}
                  </p>
                  <p className="text-2xl font-medium text-text-primary">{count}</p>
                  <p className="text-xs text-text-secondary mt-1 font-mono">{reason}</p>
                </div>
              ))}
          </div>

          <p className="text-xs text-text-secondary mt-4">
            These prospects were enriched and then removed by the tiering disqualifiers. They are
            counted here rather than listed: the count is what tells you whether the filter is
            behaving, and a long list of rejects is not what this screen is for.
          </p>
        </div>
      )}

      {/* ── AN OPENING THAT DOES NOT READ AS A FIRST LINE ────────────────────
          A prospect with no research receives the variant's own authored opening as the
          first line of their email. An author writes that paragraph knowing a greeting
          sits above it, so it can be written as a continuation of an observation that,
          without research, was never made. The email then opens mid-thought.

          THIS IS A WARNING AND NOTHING ELSE. It does not block publishing, does not block
          sending and does not alter any copy. The copy belongs to whoever approved it; the
          only thing missing was anyone being told. */}
      {openingReport.findings.length > 0 && (
        <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6">
          <h2 className="text-base font-medium text-[#7A4800] mb-1">
            {openingReport.findings.length} of {openingReport.variantsChecked} message
            variants open on a line that needs the paragraph above it
          </h2>
          <p className="text-xs text-[#7A4800] mb-4">
            Prospects with research get a written opening instead, so this only affects the
            ones on this screen with no research. Nothing is blocked.
          </p>

          <ul className="space-y-3">
            {openingReport.findings.map(finding => (
              <li key={finding.variantId} className="text-xs">
                <p className="font-medium text-text-primary">{finding.variantId}</p>
                <p className="text-text-secondary italic mt-0.5">
                  &ldquo;{finding.opening}&rdquo;
                </p>
                <ul className="mt-1 space-y-0.5">
                  {finding.faults.map((fault, i) => (
                    <li key={`${fault.kind}-${fault.phrase}-${i}`} className="text-[#7A4800]">
                      {fault.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tier sections */}
      <div className="space-y-4">
        {tiering.tier_1.length > 0 && (
          <TierSection tier="tier_1" prospects={tiering.tier_1} config={tierConfig.tier_1} />
        )}
        {tiering.tier_2.length > 0 && (
          <TierSection tier="tier_2" prospects={tiering.tier_2} config={tierConfig.tier_2} />
        )}
        {tiering.tier_3.length > 0 && (
          <TierSection tier="tier_3" prospects={tiering.tier_3} config={tierConfig.tier_3} />
        )}
      </div>

      {totalEnriched === 0 && removedCount === 0 && (
        <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-6 text-center">
          <p className="text-sm text-[#7A4800]">No enriched prospects yet. Run the enrich-and-tier action to proceed.</p>
        </div>
      )}

      {/* Every prospect in the batch was removed. Previously this rendered as
          "No enriched prospects yet", which reads as "nothing has run" and is the
          opposite of what happened. */}
      {totalEnriched === 0 && removedCount > 0 && (
        <div className="bg-[#FDEEE8] rounded-[10px] border border-[#EFBCAA] p-6">
          <p className="text-sm text-[#8B2020]">
            All {removedCount} enriched prospects were removed by the tiering disqualifiers. None
            reached a tier. The breakdown above says which gate they went out on.
          </p>
        </div>
      )}

      {/* Back button */}
      <Link
        href={`/dashboard/operator/sourcing-review?client=${organisationId}`}
        className="inline-block px-4 py-2 rounded-[6px] bg-[#F0ECE4] text-text-primary font-medium text-sm hover:bg-[#E8E2D8] transition-colors"
      >
        Back to pipeline
      </Link>
    </div>
  )
}
