// Write emails 2 and 3 for prospects that already hold a personalised Email 1.
//
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --dry-run
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --commit
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --commit --limit=10
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// The follow-up call runs inside the research path, so it reaches prospects researched
// FROM NOW ON. Prospects whose research already ran hold a personalised Email 1 and no
// follow-ups, and re-running research to reach them would re-buy Apify, Apollo, the
// website fetch, web search and synthesis, at roughly twenty times the cost of the two
// calls actually needed, and would REPLACE the Email 1 copy that is being held precisely
// because it is good.
//
// So this reproduces only the paid half that is missing: the follow-up call, against the
// stored Email 1 exactly as it will ship.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEQUENCING PROBLEM, WHICH IS THE REASON THIS SCRIPT IS CAREFUL
//
// Another session re-runs Email 1 for these same prospects to fix copy faults. A follow-up
// opens with a callback to a specific observation; under a DIFFERENT Email 1 that callback
// points at something the prospect never read. Nothing would error, the word counts would
// be right, and the only person who notices is the recipient.
//
// TWO INDEPENDENT MECHANISMS, because a single one would be a race:
//
// 1. THIS SCRIPT RECORDS WHAT IT WROTE AGAINST. followup_email1_fingerprint is the sha256
//    of the composed Email 1 body at the moment the follow-ups were written.
//
// 2. COMPOSITION RE-CHECKS IT AT SEND TIME. followupsMatchEmail1 recomputes the hash from
//    the email it is about to send and discards the follow-ups on any mismatch, shipping
//    the approved template ones instead.
//
// The second is what makes this safe to run BEFORE the other session finishes. If Email 1
// changes afterwards, the follow-ups retire themselves; they are never shipped against the
// wrong Email 1. Re-running this script then regenerates them at ~$0.008 each.
//
// It also needs no coordination: the other session does not have to know this feature
// exists. Its write changes the trigger, the hash stops matching, and the guard fires.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT WRITES, AND THE ONE THING IT MUST NOT TOUCH
//
// Writes exactly three columns, and only on prospects that already satisfy the coherence
// rule: followup_email2, followup_email3, followup_email1_fingerprint.
//
// It NEVER writes personalisation_trigger, personalisation_question or
// personalisation_subject. Those are the Email 1 the other session is fixing, and this
// script's whole purpose is to leave them alone. The update below names three columns and
// there is no code path that names a fourth.
//
// ═════════════════════════════════════════════════════════════════════════════
// DRY RUN IS THE DEFAULT, AND --commit IS THE ONLY WAY TO WRITE
//
// Without --commit it resolves the cohort, composes each Email 1, makes the model calls and
// prints what it would store, and writes nothing. The model calls are PAID either way:
// what --commit controls is the database write, not the spend.

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildFollowupsFor } from '@/lib/agents/research/produce-opening'
import { writeFollowups } from '@/lib/agents/research/write-followups'
import { buildFindingsBlock, buildFindingsEvidence } from '@/lib/agents/research/write-opening'
import { loadStoredFindings } from '@/lib/agents/prospect-research-agent-v2'
import { writerInputForStored, usdForUsage } from './export-writer-run'
import { loadClientContext } from '@/lib/agents/research/synthesize'
import { resolveBuyer } from '@/lib/agents/research/resolve-buyer'
import {
  fetchApprovedMessagingDoc,
  composeEmail1WithOpening,
  getVariantEmail1Frame,
  type MessagingContent,
} from '@/lib/composition/compose-sequence'
import { resolveVariantId, loadClientName } from '@/lib/agents/research/produce-opening'
import { fingerprintEmail1, assignFollowupArm } from '@/lib/composition/followup-assignment'
import type { ProspectContext } from '@/lib/agents/research/types'
import { companyFactsFromRow } from '@/lib/agents/research/company-facts'

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

/**
 * The cohort. Every condition here is load-bearing:
 *
 *   personalisation_trigger not null   the personalised Email 1 WON. This is the coherence
 *                                      rule at the source: a follow-up may only exist where
 *                                      the personalised Email 1 ships.
 *   current_research_result_id not null  findings are stored, so no research is re-bought.
 *   outbound_upload_status = 'pending'   NOT YET UPLOADED. Anything already uploaded is
 *                                      mid-sequence at the provider and our gates govern
 *                                      upload, not delivery (ADR-034): writing follow-ups
 *                                      for it would change nothing and record a claim about
 *                                      copy the provider has already sent.
 *   not suppressed                     never mail a suppressed prospect.
 *   followup_email2 is null            not already done, so a re-run is cheap and idempotent.
 */
/**
 * `ids` NARROWS THE COHORT TO A NAMED SET, and it exists because --limit cannot.
 *
 * ADDED 2026-09-23. --limit takes the first N by id order, which is an arbitrary slice,
 * so there was no way to run this for a SPECIFIC group of prospects. A session that had
 * just re-run Email 1 for 13 prospects had two options: write follow-ups for all 57 in
 * the organisation, or none.
 *
 * That is the sequencing hazard this file's own header describes, in the one direction it
 * did not guard: a follow-up composed against an Email 1 that a DIFFERENT run has since
 * replaced opens with a callback to something the prospect never read. Nothing errors and
 * the word counts are fine. Naming the prospects is how a caller says "these, whose
 * Email 1 I just wrote and am holding".
 *
 * The other filters still apply on top, so an id that is suppressed, already uploaded or
 * already has follow-ups is still excluded. This narrows the cohort; it never widens it.
 */
async function loadCohort(supabase: SupabaseClient, orgId: string, limit: number | null, ids: string[] | null) {
  let q = supabase
    .from('prospects')
    .select('id, organisation_id, segment_id, variant_id, first_name, last_name, company_name, country, role, job_title, email, linkedin_url, website_url, personalisation_trigger, personalisation_question, personalisation_subject, company_headcount, company_industry, apollo_enrichment_data, current_research_result_id')
    .eq('organisation_id', orgId)
    .not('personalisation_trigger', 'is', null)
    .not('current_research_result_id', 'is', null)
    .eq('outbound_upload_status', 'pending')
    .is('followup_email2', null)
    .or('suppressed.is.null,suppressed.eq.false')
    .order('id')
  if (ids && ids.length > 0) q = q.in('id', ids)
  if (limit) q = q.limit(limit)
  const { data, error } = await q
  if (error) throw new Error(`could not load the cohort: ${error.message}`)
  return data ?? []
}

async function main() {
  const argv = process.argv.slice(2)
  const commit = argv.includes('--commit')
  const limitArg = argv.find(a => a.startsWith('--limit='))?.split('=')[1]
  const limit = limitArg ? Number(limitArg) : null
  const idsArg = argv.find(a => a.startsWith('--ids='))?.split('=')[1]
  const ids = idsArg ? idsArg.split(',').map(x => x.trim()).filter(Boolean) : null
  const orgId = argv.find(a => a.startsWith('--org='))?.split('=')[1] ?? env('BACKFILL_ORG_ID')

  const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const apiKey = env('ANTHROPIC_API_KEY')

  const cohort = await loadCohort(supabase, orgId, limit, ids)
  console.log(ids
    ? `  Scope        : ${ids.length} named id(s); ${cohort.length} of them meet the cohort filters`
    : `  Scope        : EVERY eligible prospect in the organisation (${cohort.length})`)
  console.log(`backfill-followups: ${cohort.length} prospects.`)
  console.log(commit
    ? 'COMMIT MODE: the three follow-up columns WILL be written.'
    : 'DRY RUN: model calls are made and PAID, nothing is written. Pass --commit to store.')

  const messaging = await fetchApprovedMessagingDoc(supabase as never, orgId, null)
  const content = messaging.content as MessagingContent
  console.log(`messaging document ${messaging.doc_id}`)

  const clientName = await loadClientName(supabase as never, orgId)
  let written = 0, skipped = 0, usd = 0

  for (const [i, p] of cohort.entries()) {
    const id = p.id as string
    console.log(`[${i + 1}/${cohort.length}] ${id}`)

    // THE ARM. At GENERATED_ARM_PERCENT = 100 this is every prospect. Read here rather
    // than assumed so that lowering the setting skips the right prospects in the backfill
    // exactly as it does in the research path, from the same function.
    if (assignFollowupArm(id) !== 'generated') {
      console.log('  assigned the template arm, skipping'); skipped++; continue
    }

    const stored = await loadStoredFindings(supabase as never, id, orgId)
    if (!stored) { console.log('  no stored findings, skipping'); skipped++; continue }

    // The variant composition WILL assign. Resolved with the same shared function
    // composition uses, so the Email 1 fingerprinted here is the one that ships. These
    // prospects have variant_id NULL because variant assignment happens at composition.
    const variantId = resolveVariantId(id, (p.variant_id ?? null) as string | null, content)
    const reference = buildFollowupsFor(content, variantId, (p.company_name ?? null) as string | null)
    if (!reference) { console.log('  no usable follow-up reference, skipping'); skipped++; continue }

    const ctx = { ...p, ...companyFactsFromRow(p) } as unknown as ProspectContext
    // THE SAME MAPPING THE EXPORT AND THE AGENT USE, imported rather than re-derived, so
    // the findings block this writer reads is the one the Email 1 writer read.
    const writerInput = await writerInputForStored(stored, ctx, orgId)
    const clientCtx = await loadClientContext(orgId, (p.segment_id ?? null) as string | null)
    const buyer = resolveBuyer(ctx.job_title, clientCtx.buyerTitle)

    // ═══ THE STORED EMAIL 1, COMPOSED EXACTLY AS IT WILL SHIP ═══
    //
    // Built from the columns on the row, not from a fresh writer run. That is the whole
    // point: this reaches prospects whose Email 1 is finished and being held.
    //
    // TWO COMPOSITIONS, for the reason produce-opening documents at length: the writer is
    // shown the body with {{first_name}} resolved because it reads the email as the
    // prospect will, and the fingerprint is taken with the tag UNRESOLVED because that is
    // what composition hashes. Fingerprinting the resolved body would mismatch on every
    // prospect and the feature would silently never fire.
    const args = [
      content, variantId,
      p.personalisation_trigger as string,
      (p.personalisation_question ?? null) as string | null,
    ] as const
    const email1Body = composeEmail1WithOpening(
      ...args, (p.first_name ?? null) as string | null, (p.personalisation_subject ?? null) as string | null,
    ).body
    const email1ForFingerprint = composeEmail1WithOpening(
      ...args, undefined, (p.personalisation_subject ?? null) as string | null,
    ).body

    const result = await writeFollowups({
      apiKey,
      clientName,
      buyer: buyer.description,
      email1Body,
      // The variant's approved offer line, for the narrow echo gate. Read from the same
      // frame composition reads, so the gate sees the line the prospect actually got.
      offerLine: getVariantEmail1Frame(content, variantId).p3,
      findings: buildFindingsBlock(writerInput.candidates, {
        selectedCandidateId: writerInput.selectedCandidateId ?? null,
        relevanceReason: writerInput.relevanceReason ?? null,
        selectionReason: writerInput.selectionReason ?? null,
      }),
      findingsEvidence: buildFindingsEvidence(writerInput.candidates),
      reference,
      prospectId: id,
    })
    usd += usdForUsage(result.usage)

    if (result.email2.prose === null) {
      console.log(`  follow-ups rejected: ${result.email2.failures.join('; ').slice(0, 160)}`)
      skipped++
      continue
    }

    const fingerprint = fingerprintEmail1(email1ForFingerprint)
    console.log(`  email2 ${result.email2.prose.split(/\s+/).length}w  email3 ${result.email3.prose!.split(/\s+/).length}w  fp ${fingerprint.slice(0, 12)}`)

    if (!commit) { written++; continue }

    // THREE COLUMNS. Never the personalisation columns: those are the Email 1 another
    // session is fixing, and leaving them untouched is this script's core promise.
    const { error } = await supabase
      .from('prospects')
      .update({
        followup_email2: result.email2.prose,
        followup_email3: result.email3.prose,
        followup_email1_fingerprint: fingerprint,
      })
      .eq('id', id)
      .eq('organisation_id', orgId)
      // NOT-YET-UPLOADED RE-CHECKED AT THE WRITE, not only at the read. The model calls
      // take ~20s each, so a prospect can be uploaded between the two, and writing
      // follow-ups onto a row that is already at the provider records a claim about copy
      // it has already sent.
      .eq('outbound_upload_status', 'pending')
    if (error) { console.log(`  WRITE FAILED: ${error.message}`); skipped++; continue }
    written++
  }

  console.log('\n' + '='.repeat(70))
  console.log(`${commit ? 'written' : 'would write'}  ${written}`)
  console.log(`skipped              ${skipped}`)
  console.log(`anthropic            $${usd.toFixed(4)} total, $${(usd / Math.max(cohort.length, 1)).toFixed(4)} per prospect`)
  if (!commit) console.log('\nDRY RUN: nothing was written. Re-run with --commit to store.')
}

main().catch(err => { console.error(err); process.exit(1) })
