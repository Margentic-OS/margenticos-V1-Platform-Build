// Firm-fact extraction from the command line: a backfill for template-bound prospects not
// yet uploaded, and a DRY RUN for sampling.
//
//   npx tsx scripts/run-firm-fact.ts --org <id> [--limit 20] [--max-usd 3] [--include-uploaded] [--out <file>] [--exclude <earlier out files>]
//
// Selects the organisation's researched prospects that ended on the template (no
// personalisation_trigger) and have stored website text, newest first.
//
//   - Not yet uploaded: the fact is extracted and STORED on prospects.firm_fact, exactly as
//     the research pipeline would store it. Inert until the client's messaging document
//     switches firm_fact_tier on: composition reads nothing until then.
//   - --include-uploaded adds prospects already uploaded, as a DRY RUN: extracted and
//     returned, usage recorded (the money is spent), the prospect row never touched. Their
//     copy is already with the sending tool and must not change.
//
// Peer groups come from the brief in the messaging document: the pending suggestion if
// there is one, else the live document. Rule Zero: nothing here names a client or market.
// --out writes the outcomes as JSON for the reading report. It names real firms: keep it
// under .writer-export/, which is gitignored, and never commit it.
//
// --max-usd <n> is the most this run may spend, in US dollars. 3 when it is left off. Before
// each extraction the run checks that the cap still covers one more at the per-prospect
// ceiling, and stops when it does not. --limit bounds how MANY, this bounds how MUCH, and
// whichever is reached first ends the run. It applies to --recheck too.
//
// EVERY FLAG THAT TAKES A VALUE TAKES A SPACE: --limit 5, not --limit=5. The equals form of
// any of them is refused before anything is paid for, because it would otherwise be ignored
// without a word: --limit=5 ran 20, --prospects=a,b ran everybody, --exclude=<file> paid
// again for the prospects in it. Until 2026-10-02 only --max-usd was refused that way.
// --limit is a whole number greater than zero, and anything else is refused too: "abc" used
// to mean no count limit at all.

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { isFaithful, judgeFaithfulness, runFirmFactForProspect } from '../src/lib/agents/research/firm-fact'
import { actualFirmFactCostUsd, findWordsAbsentFromQuote, FIRM_FACT_CEILING_USD } from '../src/lib/agents/research/firm-fact-checks'
import { controlProblems, parseMustFail, type MustFailControl } from '../src/lib/agents/research/firm-fact-recheck'
import { readBrief, clientGenericWords } from '../src/lib/outbound-brief/brief'
import { RunSpend, parseCapUsd, parseLimit, valueFlagProblems } from '../src/lib/operator/run-spend'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * The flags of this script that take a value. Each is read ONLY as --name value. EVERY
 * NAME arg() IS CALLED WITH BELONGS HERE: one left off is a flag whose equals form is
 * dropped without a word. A test reads this file and holds the two in step.
 */
const VALUE_FLAGS = ['org', 'limit', 'max-usd', 'prospects', 'exclude', 'out', 'recheck', 'must-fail'] as const

/** How many extractions a run makes when --limit is left off. */
const DEFAULT_LIMIT = 20

/**
 * --recheck <files> [--must-fail <prospect id prefix>=<added word>,...]
 *
 * Replays STORED clause-and-quote pairs through the current code check and the current
 * judge, without paying for extraction again. Each distinct pair is checked once.
 *
 * --must-fail names records that are CONTROLS: clauses known to add something their quote
 * does not say, each with the word it adds. The run exits non-zero unless every control is
 * rejected by BOTH the code check and the judge, FOR THAT WORD, so a check that has gone
 * lenient is caught by the run itself. A judge that gave no verdict has tested nothing and
 * fails the control too: see firm-fact-recheck.ts.
 */
async function recheck(files: string[], mustFail: MustFailControl[], apiKey: string, spend: RunSpend) {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })
  const seen = new Map<string, { id: string; does: string; quote: string; forWhom: string | null; peer: string | null }>()
  for (const f of files) {
    for (const o of JSON.parse(fs.readFileSync(f, 'utf-8')) as Array<{ prospect_id: string; record: { does: string | null; quote: string | null; for_whom: string | null; peer_group_label: string | null } }>) {
      if (!o.record.does || !o.record.quote) continue
      const key = `${o.record.does}|${o.record.quote}`
      if (!seen.has(key)) seen.set(key, { id: o.prospect_id.slice(0, 8), does: o.record.does, quote: o.record.quote, forWhom: o.record.for_whom, peer: o.record.peer_group_label })
    }
  }
  let codePass = 0, judgePass = 0, bothPass = 0, noVerdict = 0
  const controlFailures: string[] = []
  // The id prefixes actually put to the judge, so a control the cap stopped short of is
  // reported as not reached and can never pass by not being asked.
  const rechecked: string[] = []
  for (const r of seen.values()) {
    // THE SAME CAP AS AN EXTRACTION RUN, and the same reservation. One judge call is the
    // smaller of the two calls FIRM_FACT_CEILING_USD covers, so reserving the whole ceiling
    // for it over-reserves on purpose: at most two cents of the cap go unused, and there is
    // one worst-case figure in this script instead of two.
    if (!spend.canAfford(FIRM_FACT_CEILING_USD)) break
    const absent = findWordsAbsentFromQuote(r.does, r.quote)
    const judged = await judgeFaithfulness(client, { quote: r.quote, does: r.does, forWhom: r.forWhom, peerLabel: r.peer })
    spend.add(actualFirmFactCostUsd(null, judged.usage))
    rechecked.push(r.id)
    const codeOk = absent.length === 0
    const judgeOk = judged.verdict !== null && isFaithful(judged.verdict)
    if (codeOk) codePass++
    if (judgeOk) judgePass++
    if (codeOk && judgeOk) bothPass++
    if (judged.verdict === null) noVerdict++
    const control = mustFail.find(m => r.id.startsWith(m.idPrefix))
    const judgeText = judged.verdict === null
      ? `NO VERDICT (${judged.reason})`
      : judgeOk ? 'pass' : `FAIL (${judged.verdict.added_concepts.join(', ') || 'unsupported claim'})`
    console.log(`${r.id}${control ? ' CONTROL' : ''} | code ${codeOk ? 'pass' : `FAIL (${absent.join(', ')})`} | judge ${judgeText} | ${r.does}`)
    if (control) {
      const problems = controlProblems({ word: control.word, codeAbsent: absent, judge: judged.verdict, judgeFaithful: judgeOk })
      if (problems.length > 0) controlFailures.push(`${r.id}: ${problems.join('; ')} | ${r.does}`)
    }
  }
  if (rechecked.length < seen.size) {
    console.log(`STOPPED AT THE SPEND CAP: ${seen.size - rechecked.length} of ${seen.size} distinct clauses were NOT rechecked. One more judge call is reserved at $${FIRM_FACT_CEILING_USD.toFixed(2)} and the cap could not cover it. Raise --max-usd to reach them.`)
  }
  console.log(`${rechecked.length} distinct clauses: code passes ${codePass}, judge passes ${judgePass}, both pass ${bothPass}, judge gave no verdict on ${noVerdict}. Judge spend $${spend.spent.toFixed(4)}.`)
  console.log(`Spend: ${spend.summary()} (--max-usd).`)
  const missing = mustFail.filter(m => ![...seen.values()].some(r => r.id.startsWith(m.idPrefix)))
  if (missing.length > 0) {
    console.error(`MUST-FAIL CONTROLS NOT FOUND in the files: ${missing.map(m => m.idPrefix).join(', ')}`)
    process.exit(1)
  }
  // A control the cap stopped short of was never asked, so it has confirmed nothing. Without
  // this the closing line below would say every control was rejected when some were not tried.
  const notReached = mustFail.filter(m => !rechecked.some(id => id.startsWith(m.idPrefix)))
  if (notReached.length > 0) {
    console.error(`MUST-FAIL CONTROLS NOT REACHED before the spend cap: ${notReached.map(m => m.idPrefix).join(', ')}. Raise --max-usd and run again.`)
    process.exit(1)
  }
  if (controlFailures.length > 0) {
    console.error(`MUST-FAIL CONTROLS NOT CONFIRMED:\n- ${controlFailures.join('\n- ')}`)
    process.exit(1)
  }
  if (mustFail.length > 0) console.log(`All ${mustFail.length} must-fail controls were rejected by both the code check and the judge, each for its own word.`)
}

async function main() {
  // THE CAP AND THE LIMIT, read before anything is paid for. A value flag written with an
  // equals sign would not be read at all and the run would carry on as if it had not been
  // typed: under the default cap, which is the expensive mistake whenever the cap somebody
  // typed was lower, or with the default limit, or for every prospect and not the named
  // ones. So that form is refused, for every flag that takes a value.
  const misread = valueFlagProblems(process.argv.slice(2), VALUE_FLAGS, 'space')
  if (misread.length > 0) throw new Error(`${misread.join('.\n')}.`)
  const spend = new RunSpend(parseCapUsd(arg('max-usd')))
  const limit = parseLimit(arg('limit')) ?? DEFAULT_LIMIT

  const recheckFiles = (arg('recheck') ?? '').split(',').filter(Boolean)
  if (recheckFiles.length > 0) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY missing')
    return recheck(recheckFiles, parseMustFail(arg('must-fail') ?? ''), key, spend)
  }
  const orgId = arg('org')
  if (!orgId) throw new Error('--org is required')
  const includeUploaded = process.argv.includes('--include-uploaded')
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing')
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  // The brief: pending suggestion first (it may not be approved yet), else the live doc.
  const { data: pending } = await supabase.from('document_suggestions').select('suggested_value')
    .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'pending').maybeSingle()
  const { data: live } = await supabase.from('strategy_documents').select('content')
    .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'active').is('segment_id', null).maybeSingle()
  const where = pending ? 'pending suggestion' : 'live messaging document'
  const read = readBrief(pending ? JSON.parse(pending.suggested_value) : live?.content)
  if (!read.brief) {
    // Say which document was read and why its brief was refused: a brief in an older shape
    // is not "no brief", and reported as one it sends the reader looking for something
    // that is sitting right there.
    throw new Error(read.present
      ? `the outbound brief in the ${where} is not valid:\n- ${read.problems.join('\n- ')}`
      : `no outbound brief in the ${where}`)
  }
  const brief = read.brief
  const peerGroups = brief.peer_groups.map(p => ({ id: p.id, label: p.label }))
  const genericWords = clientGenericWords(brief)

  let query = supabase.from('prospects')
    .select('id, outbound_upload_status, firm_fact, updated_at')
    .eq('organisation_id', orgId)
    .not('current_research_result_id', 'is', null)
    .or('personalisation_trigger.is.null,personalisation_trigger.eq.')
    .order('updated_at', { ascending: false })
    .limit(500)
  if (!includeUploaded) query = query.eq('outbound_upload_status', 'pending')
  // --prospects id,id: exactly these (still subject to every gate in runFirmFactForProspect).
  const only = (arg('prospects') ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (only.length > 0) query = query.in('id', only)
  const { data: prospects, error } = await query
  if (error) throw new Error(error.message)

  // --exclude <file,...>: earlier --out files. Dry runs store nothing on the prospect, so
  // without this a second sampling run would pay again for the same prospects.
  const excluded = new Set<string>(
    (arg('exclude') ?? '').split(',').filter(Boolean)
      .flatMap(f => (JSON.parse(fs.readFileSync(f, 'utf-8')) as Array<{ prospect_id: string }>).map(o => o.prospect_id)),
  )

  const outcomes: unknown[] = []
  let attempted = 0
  let notAttempted = 0
  const rows = (prospects ?? []) as Array<{ id: string; outbound_upload_status: string | null; firm_fact: unknown }>
  for (const [i, p] of rows.entries()) {
    if (attempted >= limit) break
    if (excluded.has(p.id)) continue
    // THE SPEND CAP, asked before the prospect is handed over, because that call is where
    // the money goes. The reservation is the per-prospect ceiling, FIRM_FACT_CEILING_USD:
    // both calls at their token caps are held under it by a build-time test
    // (worstCaseFirmFactCostUsd), so what is spent after this prospect cannot pass the cap.
    // Some prospects below would have cost nothing (already attempted, no website text).
    // They are not looked at either: whether one is free is only known by starting it.
    if (!spend.canAfford(FIRM_FACT_CEILING_USD)) {
      notAttempted = rows.slice(i).filter(q => !excluded.has(q.id)).length
      break
    }
    const pendingUpload = p.outbound_upload_status === 'pending'
    // No skip here for a prospect that already has a record: runFirmFactForProspect owns
    // that decision (a paid attempt under the CURRENT checks is never repeated).
    const result = await runFirmFactForProspect({
      supabase, apiKey, organisationId: orgId, prospectId: p.id, peerGroups, genericWords,
      persist: pendingUpload, usagePath: 'cli',
    })
    if (result.status === 'skipped') {
      if (result.reason !== 'already_attempted') console.log(`${p.id.slice(0, 8)} skipped: ${result.reason}`)
      continue
    }
    // NO WEBSITE TEXT IS A RESULT, AND IS WRITTEN DOWN. It costs nothing and does not count
    // against --limit, but it used to be dropped without a line: the prospect then had no
    // record in the --out file, and the census could only say "no_fact" for it, which is
    // not a reason. Thirteen prospects read that way on 2026-10-01.
    if (result.outcome.record.reason === 'no_website_text') {
      console.log(`${p.id.slice(0, 8)} ${pendingUpload ? 'stored ' : 'dry-run'} fail no_website_text $0.0000`)
      outcomes.push({ prospect_id: p.id, upload_status: p.outbound_upload_status, persisted: result.persisted, record: result.outcome.record })
      continue
    }
    attempted++
    // The cost the extraction step itself computed from returned usage. One price table,
    // in firm-fact-checks.ts, and this script reads the answer.
    spend.add(result.outcome.record.cost_usd_full_price)
    const r = result.outcome.record
    console.log(`${p.id.slice(0, 8)} ${pendingUpload ? 'stored ' : 'dry-run'} ${r.passed ? `PASS ${r.rung ?? ''}` : 'fail'} ${r.reason ?? ''} $${r.cost_usd_full_price.toFixed(4)}`)
    outcomes.push({ prospect_id: p.id, upload_status: p.outbound_upload_status, persisted: result.persisted, record: r })
  }
  const rungs = (outcomes as Array<{ record: { passed: boolean; rung?: string | null; reason: string | null } }>).reduce<Record<string, number>>((acc, o) => {
    const key = o.record.passed ? `passed:${o.record.rung ?? 'unknown'}` : `failed:${o.record.reason ?? 'unknown'}`
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  console.log(`By rung and reason: ${JSON.stringify(rungs)}`)
  if (notAttempted > 0) {
    console.log(`STOPPED AT THE SPEND CAP: ${notAttempted} selected prospect(s) were not attempted. One more extraction is reserved at $${FIRM_FACT_CEILING_USD.toFixed(2)} and the cap could not cover it. Raise --max-usd to reach them. A stored attempt is not paid for twice; a dry-run one is, unless this run's --out file is passed to --exclude.`)
  }
  console.log(`${attempted} extractions, $${spend.spent.toFixed(4)} at full price, max per prospect $${Math.max(0, ...outcomes.map(o => (o as { record: { cost_usd_full_price: number } }).record.cost_usd_full_price)).toFixed(4)}`)
  console.log(`Spend: ${spend.summary()} (--max-usd).`)
  const out = arg('out')
  if (out) {
    fs.writeFileSync(out, JSON.stringify(outcomes, null, 2))
    console.log(`Wrote ${out}`)
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
