// Renders a BLIND A/B read of stored copy against what the current code would produce.
// WRITES NOTHING to the database.
//
//   npx tsx --env-file=.env.local scripts/ab-read.ts --template <prospect_id>...
//   npx tsx --env-file=.env.local scripts/ab-read.ts --from-run <writer-run-*.json>...
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY TWO MODES, AND WHY ONE OF THEM IS FREE
//
// --template  For a prospect whose stored findings FAIL hasUsableCandidate. The current
//             writer refuses these (produce-opening.ts, the no-usable-candidate stop), and
//             per the 2026-09-11 decision the variant's approved opening ships instead.
//             That outcome is known WITHOUT CALLING A MODEL: side B is the authored
//             template. So this mode costs nothing and is the honest render of what the
//             prospect would receive today.
//
//             IT VERIFIES THE PREMISE RATHER THAN ASSUMING IT. hasUsableCandidate is run,
//             here, over the same findings loadStoredFindings would select. A prospect that
//             turns out to HAVE a usable candidate is refused and named, not quietly
//             rendered as a template. Otherwise this mode would manufacture the very
//             comparison it is supposed to measure.
//
// --from-run  Reads an export-writer-run JSON and renders its records. The paid half is
//             NOT reimplemented here: export-writer-run already reproduces a reuse run and
//             is audited not to write. A second implementation of that path would be the
//             two-things-that-must-agree shape, and the disagreement would surface as
//             different copy rather than as an error.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ON THE PAGE, AND WHAT IS DELIBERATELY NOT
//
// One prospect per block. A and B. The composed EMAIL 1 on both sides, with its subject
// line, {{first_name}} resolved and the opt-out footer appended, which is what the prospect
// actually receives. Not the raw trigger: the trigger fills the P2 slot of a frame, and
// judging it alone judges something nobody is ever sent.
//
// NOT on the page: name, company, tier, category, dates, scores, which side is which, or
// any ordering that correlates with them. A and B are assigned per block by crypto random,
// so position leaks nothing across blocks either.
//
// The block INDEX is present because the key has to join to something. It is the only
// non-copy text on the page.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT CANNOT WRITE
//
// Same two mechanisms as export-writer-run, and the client is literally its client.
//
// 1. Reads go through readOnlyClient: a Proxy whose builder allowlist contains no write
//    verb and no rpc, and which THROWS on anything unlisted rather than passing it on.
// 2. The composition path used here is the PURE half. composeEmail1WithOpening and
//    getVariantEmail1Frame take a document and a string and return a value. composeSequence
//    is deliberately NOT called: its step 3 stamps variant_id and messaging_doc_id onto the
//    prospect when they are null, which is a write, and it is reached before any copy is
//    produced.
// 3. The three personalisation columns are read BEFORE and AFTER and compared. The receipt
//    is the comparison, not this comment.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readOnlyClient } from './export-writer-run'
import {
  composeEmail1WithOpening,
  getVariantEmail1Frame,
  fetchApprovedMessagingDoc,
} from '@/lib/composition/compose-sequence'
import { resolveVariantId, type MessagingContent } from '@/lib/agents/research/produce-opening'
import { loadStoredFindings } from '@/lib/agents/prospect-research-agent-v2'
import { hasUsableCandidate } from '@/lib/agents/research/synthesize'
// PRODUCTION'S OWN JOIN, imported rather than reimplemented. The writer returns the
// observation and the bridge as two fields and this is what makes them one opening; it is
// also what personalisation_trigger stores. Writing `[a, b].join('\n\n')` here instead
// would be a second copy of a rule that must agree with the first, and the disagreement
// would surface as different copy rather than as an error.
import { joinOpening } from '@/lib/agents/research/write-opening'

const OUT_DIR = '.writer-export'

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`ab-read: ${name} is not set. Run with --env-file=.env.local`)
  return v
}

/** The three columns this script must not touch. */
interface StoredCopy {
  trigger: string | null
  question: string | null
  subject: string | null
}

interface ProspectRow {
  id: string
  organisation_id: string
  first_name: string | null
  variant_id: string | null
  segment_id: string | null
  stored: StoredCopy
}

async function readProspect(supabase: SupabaseClient, id: string): Promise<ProspectRow> {
  const { data, error } = await supabase
    .from('prospects')
    // ONE STRING LITERAL, deliberately, exactly as loadStoredFindings does and for the same
    // reason: supabase-js infers the row type from the select as a literal type, and
    // splitting it across concatenated strings collapses every column to
    // GenericStringError. The first version of this file concatenated, and the only symptom
    // was a cast that would not typecheck. The cast was the messenger.
    .select('id, organisation_id, first_name, variant_id, segment_id, personalisation_trigger, personalisation_question, personalisation_subject')
    .eq('id', id)
    .single()
  if (error) throw new Error(`ab-read: could not read prospect ${id}: ${error.message}`)
  const r = data as unknown as Record<string, unknown>
  return {
    id: r.id as string,
    organisation_id: r.organisation_id as string,
    first_name: (r.first_name ?? null) as string | null,
    variant_id: (r.variant_id ?? null) as string | null,
    segment_id: (r.segment_id ?? null) as string | null,
    stored: {
      trigger: (r.personalisation_trigger ?? null) as string | null,
      question: (r.personalisation_question ?? null) as string | null,
      subject: (r.personalisation_subject ?? null) as string | null,
    },
  }
}

/** One rendered side, exactly as the prospect would receive it. */
interface Side {
  subject: string
  body: string
}

function render(
  doc: MessagingContent,
  variantId: string,
  firstName: string | null,
  opening: string,
  question: string | null,
  subject: string | null,
): Side {
  const email1 = composeEmail1WithOpening(doc, variantId, opening, question, firstName, subject)
  return { subject: email1.subject_line ?? '', body: email1.body }
}

// ─── Fidelity: does the render carry every field the record holds? ───────────
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS EXISTS FOR
//
// The first version of this script rendered the fresh side from `rec.observation` alone
// and never passed `rec.bridge`. The writer returns them as two fields; production joins
// them with joinOpening and stores the joined string. So every one of 31 fresh sides
// shipped a paragraph short, against a stored side that had both, and the whole file was
// unjudgeable: the arm with less copy always looks thinner.
//
// WHAT THE EXISTING CHECKS COULD NOT DO. The run was verified for unresolved merge tags,
// empty subjects, footer counts, em dashes and leaked identifiers, and every one of those
// passed, correctly. A six-paragraph email is perfectly well formed. WELL-FORMEDNESS
// CANNOT DETECT A MISSING FIELD, because nothing about the output is malformed when a
// field never arrives: it is a valid email that says less than it should.
//
// The only check that catches it compares the render against THE RECORD IT CAME FROM. A
// field the record holds and the render does not is a dropped field, whatever the output
// looks like on its own.
//
// PARAGRAPH BREAKS ARE PRESERVED when normalising, deliberately. Collapsing all whitespace
// would make this pass for an opening joined with a space instead of a blank line, which
// is the same bug one layer down: both paragraphs present, structure wrong.
function normaliseKeepBreaks(s: string): string {
  return s
    .split(/\n{2,}/)
    .map(p => p.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Throws naming every field the record holds that the render does not carry.
 *
 * A null or empty field is skipped, not failed: a record that holds no bridge has no
 * bridge to find, and failing on it would make the check cry wolf on the template path
 * until someone switched it off.
 */
function assertRenderCarries(
  label: string,
  side: Side,
  fields: ReadonlyArray<readonly [string, string | null]>,
): void {
  const haystack = normaliseKeepBreaks(`${side.subject}\n\n${side.body}`)
  const missing: string[] = []
  for (const [name, value] of fields) {
    if (value === null || value.trim() === '') continue
    if (!haystack.includes(normaliseKeepBreaks(value))) missing.push(name)
  }
  if (missing.length > 0) {
    throw new Error(
      `ab-read: ${label} — the render is missing ${missing.length} field(s) the record holds: ` +
      `${missing.join(', ')}. The page would understate this side. Refusing to write it.`,
    )
  }
}

/**
 * CONTROL: prove the check above can FAIL before trusting the fact that it did not.
 *
 * Runs on every invocation, not as a separate test, because the failure mode being guarded
 * against is a check that silently stops working. A green run whose checker cannot go red
 * is the same reassuring nothing as a grep that never executed, and this whole file exists
 * because of one of those.
 */
function proveCheckerCanFail(): void {
  const damaged: Side = { subject: 'a subject', body: 'Robin\n\nthe observation\n\nthe offer line' }
  let threw = false
  try {
    assertRenderCarries('control', damaged, [
      ['observation', 'the observation'],
      ['bridge', 'a bridge this render does not contain'],
    ])
  } catch {
    threw = true
  }
  if (!threw) {
    throw new Error(
      'ab-read: the fidelity check did not fail on a render that is provably missing a field. ' +
      'The check is broken, so its green result on real blocks means nothing. Refusing to run.',
    )
  }
}

interface Block {
  prospect_id: string
  /** What the row holds now, composed. */
  old: Side
  /** What the current code would produce, composed. */
  fresh: Side
  /** How side B was arrived at, for the key file only. Never rendered on the page. */
  fresh_origin: string
}

// ─── Mode 1: template (free) ─────────────────────────────────────────────────

async function templateBlocks(supabase: SupabaseClient, ids: string[]): Promise<Block[]> {
  const blocks: Block[] = []
  for (const id of ids) {
    const p = await readProspect(supabase, id)
    if (!p.stored.trigger) {
      console.error(`SKIP ${id}: holds no stored copy, so there is nothing to compare`)
      continue
    }

    // VERIFY THE PREMISE. Same function the agent calls, over the same findings
    // loadStoredFindings would select. Not a re-derivation of the rule.
    const findings = await loadStoredFindings(supabase as never, p.id, p.organisation_id)
    if (!findings) {
      console.error(`SKIP ${id}: no stored findings in the reuse window, so the writer would fetch, not stop`)
      continue
    }
    if (hasUsableCandidate(findings.candidates)) {
      console.error(`SKIP ${id}: hasUsableCandidate is TRUE, so the writer would NOT stop. Belongs in --from-run.`)
      continue
    }

    const doc = await fetchApprovedMessagingDoc(supabase as never, p.organisation_id, p.segment_id)

    // VARIANT RESOLUTION WITHOUT THE WRITE. variant_id is NULL on every prospect that has
    // not been uploaded, because composeSequence assigns it at upload time and writes it
    // there. resolveVariantId is the pure half of that: `assigned ?? deterministic(id)`,
    // and the deterministic function is the SAME ONE compose-sequence calls
    // (variant-assignment.ts, one definition, no database read, stable per prospect). So
    // this is the variant the prospect would actually receive, not a stand-in for it.
    const variantId = resolveVariantId(p.id, p.variant_id, doc.content)
    const frame = getVariantEmail1Frame(doc.content, variantId)

    const old = render(doc.content, variantId, p.first_name, p.stored.trigger, p.stored.question, p.stored.subject)
    // The approved template: the variant's own authored opener back in its own slot, its
    // own CTA and its own subject. This is what composition ships when
    // personalisation_trigger is null, because TRIGGER_FALLBACKS_ENABLED is false.
    //
    // ONE PARAGRAPH, AND THAT IS CORRECT HERE. The authored frame carries exactly four
    // content paragraphs (observation slot, offer line, CTA, sign-off), so the template
    // side has no bridge and is not supposed to. That is a real property of what this
    // prospect would receive, not the dropped-field defect the run path had.
    const fresh = render(doc.content, variantId, p.first_name, frame.authoredOpening, null, null)

    assertRenderCarries(`${p.id} STORED`, old, [
      ['personalisation_trigger', p.stored.trigger],
      ['personalisation_question', p.stored.question],
      ['personalisation_subject', p.stored.subject],
    ])
    assertRenderCarries(`${p.id} NEW`, fresh, [['authored opening', frame.authoredOpening]])

    blocks.push({
      prospect_id: p.id,
      old,
      fresh,
      fresh_origin: `approved template, variant ${variantId}` +
        `${p.variant_id ? '' : ' (computed: not yet uploaded)'} (writer stops: no usable candidate)`,
    })
  }
  return blocks
}

// ─── Mode 2: from an export-writer-run JSON ──────────────────────────────────

/**
 * The half of export-writer-run's record this script reads.
 *
 * `bridge` WAS MISSING FROM THIS INTERFACE, and that is why nothing caught the dropped
 * paragraph. A local type that models fewer fields than the JSON holds cannot warn about
 * the one it omits: the compiler only ever saw the fields named here, so reading
 * `observation` alone looked complete. Anything added to the record and wanted here has to
 * be added in both places, which is why assertRenderCarries exists as the runtime backstop.
 */
interface RunRecord {
  prospect_id: string
  organisation_id: string
  variant_id: string
  observation: string | null
  bridge: string | null
  question: string | null
  subject: string | null
  stored_before: StoredCopy
}

async function fromRunBlocks(supabase: SupabaseClient, jsonPaths: string[]): Promise<Block[]> {
  const blocks: Block[] = []
  const seen = new Set<string>()

  for (const jsonPath of jsonPaths) {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { records: RunRecord[] }
    for (const rec of parsed.records) {
      if (seen.has(rec.prospect_id)) continue
      seen.add(rec.prospect_id)

      const p = await readProspect(supabase, rec.prospect_id)
      const doc = await fetchApprovedMessagingDoc(supabase as never, p.organisation_id, p.segment_id)
      // The run's own variant wins: it is the one the writer was briefed against. Falling
      // back to the pure resolver keeps a record written before variant_id existed usable.
      const variantId = rec.variant_id || resolveVariantId(p.id, p.variant_id, doc.content)

      // THE OLD SIDE COMES FROM stored_before, NOT FROM THE ROW READ JUST NOW. They are the
      // same value and the receipt below proves it, but stored_before is what the writer
      // was compared against inside the run, so it is the honest left-hand side.
      const storedTrigger = rec.stored_before.trigger
      if (!storedTrigger) {
        console.error(`SKIP ${rec.prospect_id}: no stored copy recorded in the run`)
        continue
      }

      const frame = getVariantEmail1Frame(doc.content, variantId)
      const wrote = typeof rec.observation === 'string' && rec.observation.trim().length > 0

      // THE OPENING IS THE OBSERVATION AND THE BRIDGE TOGETHER, joined by the same function
      // production calls before it stores personalisation_trigger. Passing the observation
      // alone is the defect this script shipped once: the fresh side came out a paragraph
      // short against a stored side that had both.
      const freshOpening = wrote
        ? joinOpening(rec.observation ?? '', rec.bridge ?? '')
        : frame.authoredOpening

      const old = render(
        doc.content, variantId, p.first_name,
        storedTrigger, rec.stored_before.question, rec.stored_before.subject,
      )
      const fresh = render(
        doc.content, variantId, p.first_name,
        freshOpening, wrote ? rec.question : null, wrote ? rec.subject : null,
      )

      // Every field the record holds must appear in the side built from it.
      assertRenderCarries(`${rec.prospect_id} STORED`, old, [
        ['stored_before.trigger', rec.stored_before.trigger],
        ['stored_before.question', rec.stored_before.question],
        ['stored_before.subject', rec.stored_before.subject],
      ])
      assertRenderCarries(`${rec.prospect_id} NEW`, fresh, wrote
        ? [
            ['observation', rec.observation],
            ['bridge', rec.bridge],
            ['question', rec.question],
            ['subject', rec.subject],
          ]
        : [['authored opening', frame.authoredOpening]])

      blocks.push({
        prospect_id: rec.prospect_id,
        old,
        fresh,
        fresh_origin: wrote ? 'writer output (reuse run)' : 'approved template (writer produced nothing)',
      })
    }
  }
  return blocks
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Assigns each block's two sides to A and B independently, by crypto random.
 *
 * PER BLOCK, not once for the run. A single coin flip for the whole page means a reader who
 * works out one block has worked out all of them, which is not a blind read, it is a
 * labelled one with an extra step.
 */
function renderPage(blocks: Block[]): { page: string; key: string[] } {
  const page: string[] = []
  const key: string[] = []

  blocks.forEach((b, i) => {
    const n = i + 1
    const oldIsA = crypto.randomInt(2) === 0
    const sideA = oldIsA ? b.old : b.fresh
    const sideB = oldIsA ? b.fresh : b.old

    page.push(String(n))
    page.push('')
    page.push('A')
    page.push('')
    page.push(`Subject: ${sideA.subject}`)
    page.push('')
    page.push(sideA.body)
    page.push('')
    page.push('B')
    page.push('')
    page.push(`Subject: ${sideB.subject}`)
    page.push('')
    page.push(sideB.body)
    page.push('')
    page.push('')

    key.push(
      `${String(n).padStart(3)}  A=${oldIsA ? 'STORED' : 'NEW   '}  B=${oldIsA ? 'NEW   ' : 'STORED'}  ` +
      `${b.prospect_id}  ${b.fresh_origin}`,
    )
  })

  return { page: page.join('\n'), key }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // FIRST, before any work: prove the fidelity check can go red. Everything below trusts
  // it, and a check that has silently stopped working reports exactly what a clean run
  // reports.
  proveCheckerCanFail()

  const argv = process.argv.slice(2)
  const mode = argv.find(a => a === '--template' || a === '--from-run')
  const args = argv.filter(a => !a.startsWith('--'))

  if (!mode || args.length === 0) {
    console.error('usage: npx tsx --env-file=.env.local scripts/ab-read.ts --template <prospect_id>...')
    console.error('       npx tsx --env-file=.env.local scripts/ab-read.ts --from-run <writer-run-*.json>...')
    process.exit(1)
  }

  const supabase = readOnlyClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

  // BEFORE. The receipt's first half.
  const idsForReceipt = mode === '--template'
    ? args
    : args.flatMap(p => (JSON.parse(fs.readFileSync(p, 'utf8')) as { records: RunRecord[] })
        .records.map(r => r.prospect_id))
  const before = new Map<string, string>()
  for (const id of idsForReceipt) {
    const p = await readProspect(supabase, id)
    before.set(id, JSON.stringify(p.stored))
  }

  const blocks = mode === '--template'
    ? await templateBlocks(supabase, args)
    : await fromRunBlocks(supabase, args)

  if (blocks.length === 0) {
    console.error('ab-read: no blocks to render.')
    process.exit(1)
  }

  // AFTER. Any difference here means something in this run wrote, and the run is void.
  let drifted = 0
  for (const id of idsForReceipt) {
    const p = await readProspect(supabase, id)
    if (before.get(id) !== JSON.stringify(p.stored)) {
      console.error(`!! ${id}: stored copy CHANGED during this run`)
      drifted++
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const { page, key } = renderPage(blocks)

  const pagePath = path.join(OUT_DIR, `ab-${stamp}.txt`)
  const keyPath = path.join(OUT_DIR, `ab-${stamp}.KEY.txt`)
  fs.writeFileSync(pagePath, page)
  fs.writeFileSync(keyPath,
    [`ab-${stamp}`, `${blocks.length} blocks`, '', ...key, '',
     `stored-copy drift during run: ${drifted} (0 is the receipt that nothing was written)`,
    ].join('\n'))

  console.log(`blocks   ${blocks.length}`)
  console.log(`page     ${pagePath}`)
  console.log(`key      ${keyPath}`)
  console.log(`drift    ${drifted} (0 = nothing written)`)
}

if (process.argv[1] && process.argv[1].includes('ab-read')) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
