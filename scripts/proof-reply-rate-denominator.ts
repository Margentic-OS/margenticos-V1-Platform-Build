// Renders the real Benchmarks reply card from the real database, beside a direct query.
//
//   dotenv -e .env.local -- npx tsx scripts/proof-reply-rate-denominator.ts
//
// The point is that neither half is a reading of the source. The left column is SQL
// against production; the right column is the component's own rendered output, produced
// by the same code path the page uses, from metrics fetched by the same chokepoint.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createClient } from '@supabase/supabase-js'
import { BenchmarksView } from '../src/components/dashboard/benchmarks/BenchmarksView'
import { getClientVisibleCampaignMetrics } from '../src/lib/metrics/get-client-visible-campaign-metrics'

const ORG_NAME = 'MargenticOS'

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: org } = await supabase
    .from('organisations').select('id, name').eq('name', ORG_NAME).single()
  if (!org) throw new Error(`no organisation named ${ORG_NAME}`)

  // ── The direct query ───────────────────────────────────────────────────────
  const { data: rows } = await supabase
    .from('campaigns')
    .select('contacted_count, sent_count, replied_count')
    .eq('organisation_id', org.id)

  const contacted = (rows ?? []).reduce((s, c) => s + (c.contacted_count ?? 0), 0)
  const sent      = (rows ?? []).reduce((s, c) => s + (c.sent_count ?? 0), 0)
  const replied   = (rows ?? []).reduce((s, c) => s + (c.replied_count ?? 0), 0)

  console.log(`\nDIRECT QUERY  (campaigns, organisation ${org.name})\n`)
  console.log(`  people contacted   ${contacted}`)
  console.log(`  emails sent        ${sent}`)
  console.log(`  replies            ${replied}`)
  console.log(`  replies / people   ${((replied / contacted) * 100).toFixed(1)}%   <- what the card must say`)
  console.log(`  replies / emails   ${((replied / sent) * 100).toFixed(1)}%   <- what it said before`)

  // ── The rendered card ──────────────────────────────────────────────────────
  const metrics = await getClientVisibleCampaignMetrics(org.id)
  const html = renderToStaticMarkup(React.createElement(BenchmarksView, { metrics }))
  const text = textOf(html)

  // The reply card is the first one. Slice from its label to the next card's label.
  const start = text.indexOf('Reply rate')
  const end   = text.indexOf('Positive reply rate')
  const card  = text.slice(start, end === -1 ? undefined : end).trim()

  console.log(`\nRENDERED CARD (BenchmarksView, metrics from the client chokepoint)\n`)
  console.log(`  ${card}`)

  console.log(`\nCHECKS\n`)
  const expectedLine = `${replied} ${replied === 1 ? 'reply' : 'replies'} from ${contacted} ${contacted === 1 ? 'person' : 'people'} contacted`
  const oldLine = `${replied} ${replied === 1 ? 'reply' : 'replies'} from ${sent} sent`

  const checks: Array<[string, boolean]> = [
    [`card states "${expectedLine}"`, card.includes(expectedLine)],
    [`card does NOT state "${oldLine}"`, !card.includes(oldLine)],
    ['chokepoint replyRate equals replies/people',
      Math.abs((metrics.replyRate ?? -1) - (replied / contacted) * 100) < 1e-9],
    ['chokepoint replyRate is NOT replies/emails',
      Math.abs((metrics.replyRate ?? -1) - (replied / sent) * 100) > 1e-9],
    ['denominator named in the too-early line is people', card.includes('people contacted')],
  ]

  let failed = 0
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) failed++
  }

  console.log(
    `\nNOTE: the rate itself prints as a dash at this volume. The sample gate needs about ` +
    `400 people and there are ${contacted}. The COUNTS are true from the first email, which ` +
    `is why the card shows them regardless, and the denominator is visible in them.\n`,
  )

  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
