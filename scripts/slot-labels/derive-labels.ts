// Derives an Email 1 slot labelling for every stored messaging document and PRINTS it.
//
// WRITES NOTHING unless --apply is passed. The default run is a proposal for review:
// every paragraph, the label proposed for it, and the reason that label was chosen.
//
// Deterministic by rule (ADR-018). Every decision below is a structural or lexical test
// that a person can check by reading the same paragraph. No model call is involved, and
// none is warranted: the job of a paragraph in a four-paragraph frame is decidable from
// its position relative to the sign-off and from whether its subject is the sender.
//
// Confidence is ALL-OR-NOTHING PER ROW. A row where any paragraph is uncertain is left
// unlabelled entirely rather than partly labelled, because a partial labelling is harder
// to reason about than none: a reader finding three of four slots cannot tell whether the
// fourth is absent or merely unrecognised. An unlabelled row falls back to the positional
// read, which is exactly today's behaviour, so leaving one out costs nothing.

import { createClient } from '@supabase/supabase-js'
import {
  splitEmail1Paragraphs,
  slotsMatchBody,
  type Email1Slot,
  type Email1ParagraphSlot,
} from '../../src/lib/composition/email1-slots'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

interface StoredEmailLike {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
  slots?: Email1ParagraphSlot[]
}

interface Decision {
  index: number
  text: string
  slot: Email1Slot | null
  reason: string
  confident: boolean
}

// A paragraph whose grammatical subject is the sender. These are the only openings that
// appear in the stored corpus; anything else is treated as not sender-facing and the row
// is reported rather than guessed.
const SENDER_FACING = /^(We|I)\b/
// A self-introduction: "We're <Name>." / "We are <Name>." Names the organisation as an
// identity rather than naming what changes for the reader.
const SELF_INTRODUCTION = /^(We're|We are)\s+[A-Z]/

function decide(
  paras: string[],
  founderFirstName: string | null,
  orgName: string | null,
): Decision[] {
  const last = paras.length - 1
  const decisions: Decision[] = []

  paras.forEach((text, i) => {
    // ── The sign-off: structurally the last paragraph. ──────────────────────
    if (i === last) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      const nameMatches = founderFirstName != null && lines[0] === founderFirstName
      const companyMatches = orgName != null && lines[1] === orgName
      decisions.push({
        index: i,
        text,
        slot: 'sign_off',
        reason: nameMatches
          ? `last paragraph; line 1 is the organisation's founder_first_name` +
            (companyMatches ? ` and line 2 is its name` : ` (one-line sign-off, pre-dates the two-line rule)`)
          : `last paragraph, but line 1 does not match founder_first_name`,
        confident: nameMatches,
      })
      return
    }

    // ── The CTA: the paragraph before the sign-off, and it must ask something. ──
    if (i === last - 1) {
      const hasQuestion = text.includes('?')
      decisions.push({
        index: i,
        text,
        slot: 'cta',
        reason: hasQuestion
          ? `immediately precedes the sign-off and asks a question`
          : `immediately precedes the sign-off but contains no question mark`,
        confident: hasQuestion,
      })
      return
    }

    // ── The observation slot: structurally the first paragraph. ─────────────
    // This is not a content judgement. applyTriggerToEmail1 replaces the first non-empty
    // line after {{first_name}}, so paragraph 0 IS the slot regardless of what it says.
    if (i === 0) {
      decisions.push({
        index: i,
        text,
        slot: 'observation',
        reason: `first paragraph, which is the line composition replaces with the researched observation`,
        confident: true,
      })
      return
    }

    // ── Everything between the observation and the CTA. ─────────────────────
    // A stray question mark here is the ambiguous case: it may be a rhetorical device or
    // it may mean the frame is not the one assumed. Reported, never guessed.
    if (text.includes('?')) {
      decisions.push({
        index: i,
        text,
        slot: null,
        reason: `middle paragraph containing a question mark: ambiguous against the CTA, not labelled`,
        confident: false,
      })
      return
    }

    if (SELF_INTRODUCTION.test(text)) {
      decisions.push({
        index: i,
        text,
        slot: 'sender_credentials',
        reason: `opens by naming the sender's organisation as an identity, then describes background and process`,
        confident: true,
      })
      return
    }

    if (SENDER_FACING.test(text)) {
      decisions.push({
        index: i,
        text,
        slot: 'offer',
        reason: `subject is the sender: names what the sender does and what changes for the reader`,
        confident: true,
      })
      return
    }

    decisions.push({
      index: i,
      text,
      slot: 'problem_context',
      reason: `subject is not the sender and it asks nothing: continues framing the problem`,
      confident: true,
    })
  })

  return decisions
}

// Redaction for the printed report only. Never applied to anything stored.
function redactor(founderFirstName: string | null, orgName: string | null) {
  const pairs: Array<[RegExp, string]> = []
  if (founderFirstName) pairs.push([new RegExp(`\\b${escapeRe(founderFirstName)}\\b`, 'g'), '[FOUNDER]'])
  if (orgName) pairs.push([new RegExp(escapeRe(orgName), 'g'), '[ORG]'])
  return (s: string) => pairs.reduce((acc, [re, to]) => acc.replace(re, to), s)
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function truncate(s: string, n = 96): string {
  const oneLine = s.replace(/\n/g, ' / ')
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + '…'
}

async function main() {
  const { data: docs, error } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, status, client_approval_status, version, created_at, content')
    .eq('document_type', 'messaging')
    .order('created_at', { ascending: true })
  if (error) throw error

  const { data: orgs } = await supabase.from('organisations').select('id, name, founder_first_name')
  const orgById = new Map((orgs ?? []).map(o => [o.id, o]))

  let rowsTotal = 0
  let rowsConfident = 0
  let rowsUnlabelled = 0
  const unlabelled: string[] = []
  const slotTally = new Map<string, number>()
  const pendingWrites: Array<{ id: string; content: unknown }> = []
  const report: unknown[] = []

  for (const d of docs ?? []) {
    const content = d.content as Record<string, unknown> | unknown[]
    const org = orgById.get(d.organisation_id)
    const redact = redactor(org?.founder_first_name ?? null, org?.name ?? null)

    if (Array.isArray(content) || !content || !(content as Record<string, unknown>).variants) {
      console.log(`\n━━━ DOC ${d.id}  v${d.version}  ${d.status}/${d.client_approval_status}`)
      console.log(`    SKIPPED: no "variants" key (content is a bare ${Array.isArray(content) ? 'array' : 'object'}). Not readable by the frame reader either.`)
      continue
    }

    const variants = (content as Record<string, unknown>).variants as Record<
      string,
      { emails: StoredEmailLike[] }
    >

    console.log(`\n━━━ DOC ${d.id}  v${d.version}  ${d.status}/${d.client_approval_status}  ${String(d.created_at).slice(0, 10)}`)

    const nextVariants: Record<string, unknown> = {}
    let docChanged = false

    for (const key of Object.keys(variants).sort()) {
      const variant = variants[key]
      const emails = variant.emails ?? []
      const e1 = emails.find(e => Number(e.sequence_position) === 1)
      if (!e1) {
        console.log(`  [${key}] NO EMAIL 1 — skipped`)
        nextVariants[key] = variant
        continue
      }

      rowsTotal++
      const paras = splitEmail1Paragraphs(e1.body)
      const decisions = decide(paras, org?.founder_first_name ?? null, org?.name ?? null)
      const rowConfident = decisions.every(x => x.confident && x.slot !== null)

      // What the CURRENT positional read hands the writer as the offer line, so the
      // proposal can be judged against the thing it is meant to correct.
      const positionalP3 = paras[1] ?? '(out of range)'
      const proposedOffer = decisions.find(x => x.slot === 'offer')

      console.log(`  [${key}] ${paras.length} paragraphs — ${rowConfident ? 'CONFIDENT' : 'NOT CONFIDENT, left unlabelled'}`)
      for (const x of decisions) {
        const mark = x.slot === null ? '??' : x.confident ? 'ok' : '!!'
        console.log(`     ${x.index}  ${mark}  ${(x.slot ?? 'UNLABELLED').padEnd(18)} ${truncate(redact(x.text))}`)
        console.log(`            reason: ${x.reason}`)
      }
      console.log(`     positional read currently briefs the writer with index 1 as the offer line:`)
      console.log(`            "${truncate(redact(positionalP3), 88)}"`)
      console.log(`     proposed offer line: ${proposedOffer ? `"${truncate(redact(proposedOffer.text), 76)}"` : 'NONE — this document has no offer paragraph'}`)

      report.push({
        docId: d.id, version: d.version, status: d.status,
        approval: d.client_approval_status, created: String(d.created_at).slice(0, 10),
        org: org?.name ?? null, variant: key, confident: rowConfident,
        paragraphs: decisions.map(x => ({
          index: x.index, slot: x.slot, confident: x.confident,
          reason: x.reason, text: redact(x.text),
        })),
        positionalOfferLine: redact(positionalP3),
        proposedOfferLine: proposedOffer ? redact(proposedOffer.text) : null,
      })

      if (rowConfident) {
        rowsConfident++
        for (const x of decisions) slotTally.set(x.slot!, (slotTally.get(x.slot!) ?? 0) + 1)
        const slots: Email1ParagraphSlot[] = decisions.map(x => ({ slot: x.slot!, text: x.text }))
        if (!slotsMatchBody(slots, e1.body)) {
          throw new Error(`derive-labels: self-check failed for ${d.id}/${key} — derived slots do not reproduce the body`)
        }
        nextVariants[key] = {
          ...variant,
          emails: emails.map(e => (Number(e.sequence_position) === 1 ? { ...e, slots } : e)),
        }
        docChanged = true
      } else {
        rowsUnlabelled++
        unlabelled.push(`${d.id}/${key} (${d.status}) — ${decisions.filter(x => !x.confident).map(x => `p${x.index}: ${x.reason}`).join('; ')}`)
        nextVariants[key] = variant
      }
    }

    if (docChanged) {
      pendingWrites.push({ id: d.id, content: { ...(content as Record<string, unknown>), variants: nextVariants } })
    }
  }

  console.log(`\n${'═'.repeat(78)}`)
  console.log(`SUMMARY`)
  console.log(`  variant rows examined : ${rowsTotal}`)
  console.log(`  would be labelled     : ${rowsConfident}`)
  console.log(`  left unlabelled       : ${rowsUnlabelled}`)
  console.log(`  documents to update   : ${pendingWrites.length}`)
  console.log(`\n  slot totals across labelled rows:`)
  for (const [slot, n] of [...slotTally.entries()].sort()) {
    console.log(`     ${slot.padEnd(20)} ${n}`)
  }
  if (unlabelled.length > 0) {
    console.log(`\n  ROWS LEFT UNLABELLED (they keep today's positional read):`)
    for (const u of unlabelled) console.log(`     ${u}`)
  }

  if (JSON_OUT) {
    const fs = await import('node:fs')
    fs.writeFileSync(process.env.SLOT_LABELS_JSON!, JSON.stringify({
      rows: report,
      summary: { rowsTotal, rowsConfident, rowsUnlabelled, docsToUpdate: pendingWrites.length,
                 slotTally: Object.fromEntries(slotTally) },
    }, null, 2))
    console.log(`\n  JSON written to ${process.env.SLOT_LABELS_JSON}`)
  }

  if (!APPLY) {
    console.log(`\n  NOTHING WRITTEN. Re-run with --apply to store this labelling.`)
    return
  }

  console.log(`\n  APPLYING to ${pendingWrites.length} documents…`)
  for (const w of pendingWrites) {
    const { error: upErr } = await supabase
      .from('strategy_documents')
      .update({ content: w.content })
      .eq('id', w.id)
    if (upErr) throw new Error(`derive-labels: update failed for ${w.id}: ${upErr.message}`)
    console.log(`     updated ${w.id}`)
  }
  console.log(`  done.`)
}

main().catch(e => { console.error(e); process.exit(1) })
