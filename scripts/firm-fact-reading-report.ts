// Builds the operator's reading file for the firm-fact tier: the regenerated sequences in
// full, and real firm-fact Email 1s with their sources.
//
//   npx tsx scripts/firm-fact-reading-report.ts --org <id> --facts <a.json,b.json> --out <file.md> [--count 10]
//
// THE OUTPUT NAMES REAL FIRMS. Write it under .writer-export/ (gitignored) and never commit
// it. This script holds no names; it reads them from the database at run time.
//
// The emails are composed by decideFirmFactEmail1, the SAME function composition calls, on
// the PENDING messaging suggestion with firm_fact_tier treated as on. So the file shows
// exactly what would ship once the suggestion is approved and the tier switched on, and
// nothing in the database changes.

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { execSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import { decideFirmFactEmail1 } from '../src/lib/composition/firm-fact-email1'
import { assignVariantDeterministically } from '../src/lib/composition/variant-assignment'
import { readBrief, briefItemIndex, type OutboundBrief } from '../src/lib/outbound-brief/brief'
import { countWords } from '../src/lib/composition/personalization'
import type { VariantLines } from '../src/lib/outbound-templates/template-shape'
import type { FirmFactRecord } from '../src/lib/agents/research/firm-fact'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function describeIds(ids: string[], brief: OutboundBrief): string {
  const kind = briefItemIndex(brief)
  const text = (id: string): string => {
    const k = kind.get(id)
    if (k === 'pain_angle') return brief.pain_angles.find(a => a.id === id)!.statement
    if (k === 'proof_point') return brief.proof_points.find(p => p.id === id)!.claim
    if (k === 'scope_does') return brief.scope.does.find(d => d.id === id)!.statement
    if (k === 'third_party') return brief.third_parties.find(t => t.id === id)!.term
    return k ?? 'UNKNOWN ID'
  }
  return ids.map(id => `${id} (${text(id)})`).join('; ')
}

function quoteBlock(text: string): string {
  return text.split('\n').map(l => `> ${l}`).join('\n')
}

async function main() {
  const orgId = arg('org')
  const out = arg('out')
  const factFiles = (arg('facts') ?? '').split(',').filter(Boolean)
  const count = Number(arg('count') ?? '10')
  if (!orgId || !out || factFiles.length === 0) throw new Error('--org, --facts and --out are required')
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: pending, error } = await supabase.from('document_suggestions').select('id, suggested_value, created_at')
    .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'pending').single()
  if (error || !pending) throw new Error('no pending messaging suggestion')
  const content = JSON.parse(pending.suggested_value) as Record<string, any>
  // The problems, not just the fact of one: a brief in an older shape is sitting right there.
  const read = readBrief(content)
  if (!read.brief) {
    throw new Error(read.present
      ? `the outbound brief in the pending suggestion is not valid:\n- ${read.problems.join('\n- ')}`
      : 'the pending suggestion holds no outbound brief')
  }
  const brief = read.brief
  const variantKeys = Object.keys(content.variants).sort()
  const sha = execSync('git rev-parse --short HEAD').toString().trim()

  const lines: string[] = []
  lines.push('# Firm-fact tier: reading file')
  lines.push('')
  lines.push(`Generated ${new Date().toISOString().slice(0, 16)} UTC from branch firm-fact-tier at ${sha}. Pending messaging suggestion ${pending.id} (outbound brief v${brief.brief_version}). Contains real firm names: never commit, never paste into Notion.`)
  lines.push('')
  lines.push('Marks: each email carries my line (PASS / PASS WITH NOTE / FAIL). Overwrite it with yours. Nothing ships until you approve: the suggestion is pending, and firm_fact_tier.enabled is false in it.')
  lines.push('')
  lines.push('## Part 1. The four regenerated sequences')
  lines.push('')
  lines.push('Generated from the outbound brief only (the old templates were hidden from the agent). Every line passed the deterministic validator over an invented fill matrix and the scope judge. The bodies below are the TEMPLATE tier (slot-free), which is what a prospect with no research trigger and no firm fact receives. The slotted lines are shown beneath each Email 1.')
  lines.push('')
  lines.push(`Opener frames (firm-fact tier only, rotated by prospect): ${(content.opener_frames as string[]).map(f => `"${f}"`).join(', ')}`)
  lines.push('')
  for (const key of variantKeys) {
    const v = content.variants[key] as { emails: Array<{ sequence_position: number; subject_line: string | null; body: string; offer_angle?: string | null }>; lines: VariantLines }
    const l = v.lines
    const order = [l.email1.angle, ...l.followups.filter(f => f.position !== 4).map(f => f.angle)]
    lines.push(`### Variant ${key}`)
    lines.push('')
    lines.push(`Angles, Emails 1 to 3: ${order.join(' > ')}. Email 1 angle: ${describeIds([l.email1.angle], brief)}`)
    lines.push(`offer_angle: ${l.email1.offer_angle === null ? 'null (the NEUTRAL offer line)' : `"${l.email1.offer_angle}"`}`)
    lines.push('')
    for (const e of v.emails) {
      lines.push(`**Email ${e.sequence_position}** (${countWords(e.body)} words${e.subject_line ? `, subject "${e.subject_line}"` : ''})`)
      lines.push('')
      lines.push(quoteBlock(e.body))
      lines.push('')
      if (e.sequence_position === 1) {
        lines.push('Slotted lines (firm-fact tier):')
        for (const k of ['subject', 'pain', 'offer', 'question'] as const) {
          const line = l.email1[k]
          lines.push(`- ${k}: "${line.text}"${line.slot_free ? ` / slot-free "${line.slot_free}"` : ''}. From: ${describeIds(line.from, brief)}`)
        }
        lines.push('')
      } else {
        const f = l.followups.find(x => x.position === e.sequence_position)
        if (f) lines.push(`From: ${describeIds([...new Set([f.angle, ...f.paragraphs.flatMap(p => p.from)])], brief)}`)
        lines.push('')
      }
    }
    lines.push(`Verdict, variant ${key}: VERDICT_${key}`)
    lines.push('')
  }

  // Part 2: real firm-fact Email 1s.
  const records = factFiles.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf-8')) as Array<{ prospect_id: string; upload_status: string | null; record: FirmFactRecord }>)
  const latest = new Map<string, (typeof records)[number]>()
  for (const r of records) latest.set(r.prospect_id, r)
  const passing = [...latest.values()].filter(r => r.record.passed)
    .sort((a, b) => (a.upload_status === 'pending' ? 0 : 1) - (b.upload_status === 'pending' ? 0 : 1))

  const forReport = { ...content, firm_fact_tier: { enabled: true } }
  lines.push('## Part 2. Real firm-fact Email 1s')
  lines.push('')
  lines.push(`${passing.length} of ${latest.size} distinct prospects sampled passed extraction. Shown: the first ${count} that also compose, prospects not yet uploaded first. Each is the WHOLE Email 1 as composition would build it, then its sources. Uploaded prospects were read in a dry run: their rows were not changed and their sent copy is unaffected.`)
  lines.push('')
  let shown = 0
  const failedCompose: string[] = []
  for (const r of passing) {
    if (shown >= count) break
    const { data: p } = await supabase.from('prospects').select('id, first_name, company_name, variant_id, outbound_upload_status')
      .eq('organisation_id', orgId).eq('id', r.prospect_id).single()
    if (!p) continue
    const variantId = p.variant_id && content.variants[p.variant_id] ? p.variant_id : assignVariantDeterministically(p.id, variantKeys)
    const decision = decideFirmFactEmail1({
      messagingContent: forReport, variantId, prospectId: p.id, firmFact: r.record,
      templateEmail1Body: content.variants[variantId].emails[0].body,
      now: new Date(),
    })
    if (decision.tier !== 'firm_fact') {
      failedCompose.push(`${p.company_name}: template ships (${decision.reason}${decision.violations ? `: ${decision.violations.join('; ')}` : ''})`)
      continue
    }
    shown++
    const body = decision.body.replace('{{first_name}}', p.first_name ?? '{{first_name}}')
    lines.push(`### ${shown}. ${p.company_name} (variant ${variantId}, opener frame ${decision.detail.frame_index}, ${p.outbound_upload_status === 'pending' ? 'not yet uploaded: fact stored' : 'already uploaded: dry run'})`)
    lines.push('')
    lines.push(`Subject: ${decision.subject}`)
    lines.push('')
    lines.push(quoteBlock(body))
    lines.push('')
    lines.push(`${decision.word_count} words. Sources:`)
    lines.push(`- {does} "${r.record.does}", from their site ${r.record.source_url ?? '(no url)'}, ${r.record.section} section, research row ${r.record.research_result_id} fetched ${r.record.source_fetched_at?.slice(0, 10)}`)
    lines.push(`- verbatim quote: "${r.record.quote}"`)
    lines.push(`- {for_whom}: ${r.record.for_whom ? `"${r.record.for_whom}"` : 'none (offer and subject use their slot-free forms)'}; peer group: ${r.record.peer_group_label ? `"${r.record.peer_group_label}"` : `none (default "${brief.peer_group_default.label}")`}`)
    lines.push(`- faithfulness judge: ${r.record.judge?.claims.map(c => `"${c.claim}" ${c.supported ? 'supported' : 'NOT supported'}`).join('; ')}`)
    lines.push(`- cost of this prospect's extraction and judge, full price: $${r.record.cost_usd_full_price.toFixed(4)}`)
    lines.push('')
    lines.push(`Verdict: VERDICT_FACT_${shown}`)
    lines.push('')
  }
  if (failedCompose.length > 0) {
    lines.push('### Facts that passed extraction but failed re-validation at composition (template ships)')
    lines.push('')
    for (const f of failedCompose) lines.push(`- ${f}`)
    lines.push('')
  }
  fs.writeFileSync(out, lines.join('\n'))
  console.log(`Wrote ${out}: ${variantKeys.length} sequences, ${shown} firm-fact emails, ${failedCompose.length} failed re-validation`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
