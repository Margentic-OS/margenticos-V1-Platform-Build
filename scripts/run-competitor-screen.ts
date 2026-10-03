// The competitor screen from the command line: a DRY RUN by default.
//
//   npx tsx scripts/run-competitor-screen.ts --org <id> [--brief <file>] [--commit]
//                                            [--rescreen-excluded] [--include-uploaded]
//                                            [--limit N] [--out <file>] [--max-usd 3]
//
// Research runs the same screen by itself, on the prospects it is about to research. This
// script is for the two things research never does:
//
//   1. Look at a client's WHOLE pool at once: every prospect holding a tier that has not
//      been uploaded. Without --commit it writes nothing, so the list of who WOULD be
//      excluded can be read before anybody is.
//   2. --rescreen-excluded: look again at the prospects already excluded. An excluded
//      prospect has no tier, so research never selects it and nothing else reaches it. After
//      a category is narrowed this is the way back, and it works two ways: a prospect that
//      still carries a phrase is asked about again and may now read clear; a prospect that
//      carries no phrase any more, because the phrase or the category was taken off the
//      list, is restored with no model asked. Either way its removal reason is cleared and
//      the next tiering run gives it a tier again. They are listed under RESTORED.
//
// --include-uploaded adds prospects already uploaded, DRY RUN ONLY: it answers "how many
// competitors have we already written to" and never writes to one.
//
// --brief <file> reads the competitor categories from a brief JSON file instead of the live
// messaging document, to try a list before it is approved. It is DRY RUN ONLY and refuses
// --commit: a list nobody approved must not remove anybody.
//
// The model is asked only about a company whose provider record carries one of the brief's
// phrases, and that costs money in a dry run too (about a tenth of a cent each). A dry run
// stores no verdict, so the same companies are asked about again when it is run with --commit.
//
// --out writes the per-prospect outcomes as JSON. It names real firms: keep it under
// .writer-export/, which is gitignored, and never commit it.
//
// --max-usd <n> is the most this run may spend, in US dollars. 3 when it is left off. The
// screen cannot be stopped part-way, so the cap is turned into a number of model questions
// before it starts (see WORST_CASE_USD_PER_QUESTION below). A company past that number is
// HELD, not passed: it is asked about on a later run. A dry run is paid, so it is capped too.
//
// FLAGS HERE TAKE A SPACE: --limit 5, not --limit=5. The equals form is refused, because
// it would otherwise be ignored without a word and the whole pool screened. --limit is a
// whole number greater than zero, and anything else is refused: "abc" and "0" each used to
// screen nobody, and "2.5" screened two.

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { createClient } from '@supabase/supabase-js'
import {
  screenCompetitors,
  COMPETITOR_JUDGE_MODEL,
  COMPETITOR_JUDGE_MAX_TOKENS,
  COMPETITOR_JUDGE_SYSTEM_PROMPT,
  SITE_TEXT_SHOWN_CHARS,
  TAGS_SHOWN_MAX,
} from '../src/lib/sourcing/competitor-screen'
import { isCompetitorExcluded } from '../src/lib/sourcing/competitor-verdict'
import { RunSpend, parseCapUsd, parseLimit, valueFlagProblems } from '../src/lib/operator/run-spend'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

/** Full price per million tokens for the judge model, for the spend line. */
const USD_PER_MTOK = { input: 1, output: 5 }

/** The flags of this script that take a value. Each is read ONLY as --name value. */
const VALUE_FLAGS = ['org', 'brief', 'limit', 'out', 'max-usd'] as const

/** The most model questions one run asks, whatever the dollar cap allows. */
const MAX_JUDGE_CALLS = 2000

// ─── The most ONE model question can cost, so a dollar cap can become a count ───
//
// The library takes a number of questions, not a number of dollars, and it cannot be
// stopped between questions from here. So the cap is divided by the worst case of one
// question, before the run. The arithmetic, from the library's own limits and the price
// literal above:
//
//   INPUT, per request
//     the system prompt        its own length in characters
//     the homepage text        at most SITE_TEXT_SHOWN_CHARS (2,500) characters
//       both counted at 2 characters to a token. Plain English runs nearer 4, and page
//       text full of menus and symbols runs denser, so 2 errs high.
//     the tags                 at most TAGS_SHOWN_MAX (150), counted at 8 tokens each.
//                              A tag is two or three words and a comma.
//     everything else          400 tokens: the category's wording, what is outside it,
//                              the company name and its industry labels. THE LIBRARY PUTS
//                              NO LIMIT ON THESE. 400 is an allowance, not a bound.
//   OUTPUT
//     COMPETITOR_JUDGE_MAX_TOKENS (220), then twice that on the one retry
//
//   A REPLY CUT OFF AT THE LIMIT IS ASKED AGAIN ONCE AND BOTH ARE BILLED, and the library
//   counts the pair as one question. So the worst case of one question is two requests.
//
// At the time of writing: about 3,900 input tokens a request, so 7,800 x $1 + 660 x $5 per
// million, which is a little over one cent. The usual question costs about a tenth of
// that (see the header). A $3 cap therefore allows roughly 270 questions. The library's
// header records 44 of 660 prospects carrying a phrase on the live client on 2026-10-01,
// so a whole-pool run of that size sits well inside the default.
//
// A STATED WORST CASE, NOT A METER. What was actually spent is priced from the usage the
// model returned and printed beside the cap after the run.
const CHARS_PER_TOKEN_WORST = 2
const TOKENS_PER_TAG_WORST = 8
const UNBOUNDED_WORDING_TOKENS = 400
const WORST_INPUT_TOKENS_PER_REQUEST =
  Math.ceil((COMPETITOR_JUDGE_SYSTEM_PROMPT.length + SITE_TEXT_SHOWN_CHARS) / CHARS_PER_TOKEN_WORST)
  + TAGS_SHOWN_MAX * TOKENS_PER_TAG_WORST
  + UNBOUNDED_WORDING_TOKENS
const WORST_CASE_USD_PER_QUESTION = (
  2 * WORST_INPUT_TOKENS_PER_REQUEST * USD_PER_MTOK.input
  + (COMPETITOR_JUDGE_MAX_TOKENS + 2 * COMPETITOR_JUDGE_MAX_TOKENS) * USD_PER_MTOK.output
) / 1_000_000

async function main() {
  // REFUSED BEFORE ANY WORK: a value flag written with an equals sign. arg() reads the
  // argument AFTER the flag, so `--limit=5` is one argument it does not recognise: the
  // limit is not applied and every company in the pool that carries a phrase is asked about.
  const misread = valueFlagProblems(process.argv.slice(2), VALUE_FLAGS, 'space')
  if (misread.length > 0) throw new Error(`nothing was screened.\n  ${misread.join('.\n  ')}.`)

  const runSpend = new RunSpend(parseCapUsd(arg('max-usd')))
  const affordableQuestions = runSpend.affordableCount(WORST_CASE_USD_PER_QUESTION)
  if (affordableQuestions < 1) {
    throw new Error(`a cap of $${runSpend.capUsd.toFixed(4)} does not cover one model question at its worst case of $${WORST_CASE_USD_PER_QUESTION.toFixed(4)}. Nothing was screened. Raise --max-usd.`)
  }
  const maxJudgeCalls = Math.min(MAX_JUDGE_CALLS, affordableQuestions)

  const orgId = arg('org')
  if (!orgId) throw new Error('--org <organisation id> is required')
  const commit = flag('commit')
  const briefFile = arg('brief')
  const rescreen = flag('rescreen-excluded')
  const limit = parseLimit(arg('limit'))
  const out = arg('out')
  const includeUploaded = flag('include-uploaded')
  if (includeUploaded && commit) {
    throw new Error('--include-uploaded is dry run only. An uploaded prospect is already with the sending tool; this script never writes to one.')
  }
  if (briefFile && commit) {
    throw new Error('--brief is dry run only. Exclusions are written from the live messaging document, never from a file.')
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local')
  const supabase = createClient(url, key)

  // The pool: holds a tier, not suppressed. Paged, because a single read returns at most
  // 1,000 rows and reports nothing about the rest.
  type Row = { id: string; company_name: string | null; outbound_upload_status: string | null; competitor_check: unknown; sourced_tier: string | null }
  const pool: Row[] = []
  for (let from = 0; ; from += 1000) {
    let query = supabase
      .from('prospects')
      .select('id, company_name, outbound_upload_status, competitor_check, sourced_tier, tiering_reason')
      .eq('organisation_id', orgId)
      .eq('suppressed', false)
      .order('id', { ascending: true })
      .range(from, from + 999)
    query = rescreen
      ? query.or('sourced_tier.not.is.null,tiering_reason.eq.competitor')
      : query.not('sourced_tier', 'is', null)
    const { data, error } = await query
    if (error) throw new Error(`could not read prospects: ${error.message}`)
    pool.push(...((data ?? []) as unknown as Row[]))
    if ((data ?? []).length < 1000) break
  }

  const uploaded = pool.filter(p => p.outbound_upload_status !== null && p.outbound_upload_status !== 'pending')
  let selected = includeUploaded
    ? pool
    : pool.filter(p => p.outbound_upload_status === null || p.outbound_upload_status === 'pending')
  if (limit !== null) selected = selected.slice(0, limit)
  const alreadyExcluded = selected.filter(p => isCompetitorExcluded(p.competitor_check)).length

  console.log('')
  console.log(`  Organisation        : ${orgId}`)
  console.log(`  Mode                : ${commit ? 'COMMIT (verdicts and exclusions are written)' : 'DRY RUN (nothing is written)'}`)
  console.log(`  Categories from     : ${briefFile ? briefFile : 'the live messaging document'}`)
  console.log(`  In the pool         : ${pool.length} (holding a tier${rescreen ? ', or excluded as a competitor' : ''})`)
  console.log(`  Already uploaded    : ${uploaded.length} (${includeUploaded ? 'INCLUDED, dry run: shows who has already been written to' : 'not screened here: their email is already with the sending tool'})`)
  console.log(`  Screened            : ${selected.length}${alreadyExcluded ? ` (${alreadyExcluded} already excluded, looked at again)` : ''}`)
  console.log(`  Spend cap           : $${runSpend.capUsd.toFixed(2)} (--max-usd), so at most ${maxJudgeCalls} model questions at a worst case of $${WORST_CASE_USD_PER_QUESTION.toFixed(4)} each`)

  const messagingContent = briefFile
    ? { outbound_brief: JSON.parse(fs.readFileSync(briefFile, 'utf-8')) }
    : undefined

  const result = await screenCompetitors({
    supabase,
    organisationId: orgId,
    prospectIds: selected.map(p => p.id),
    messagingContent,
    persist: commit,
    maxJudgeCalls,
    ignoreStored: rescreen,
  })
  if (!result.ok) throw new Error(result.error)

  if (!result.screened) {
    // The document carries no competitor list at all. A list that is present and cannot be
    // used is refused above, with its problems; an empty, well-formed list is screened
    // against nothing and restores anybody an earlier list excluded.
    console.log('')
    console.log('  NOT SCREENED: the messaging document carries no competitor list.')
    console.log('')
    return
  }

  const uploadedIds = new Set(uploaded.map(p => p.id))
  const nameOf = new Map(selected.map(p => [p.id, p.company_name ?? '(no company name)']))
  // A restored prospect reads "clear" and is listed with them, marked, whether or not a
  // model was asked: one that lost its phrase has no phrases to show and is still named.
  const by = (outcome: string) => result.details.filter(d => d.outcome === outcome)
  const spend = (result.usage.input_tokens * USD_PER_MTOK.input + result.usage.output_tokens * USD_PER_MTOK.output) / 1_000_000

  console.log('')
  console.log(`  No phrase in record : ${by('no_phrase').length} (never judged, free)`)
  console.log(`  No record to screen : ${result.unscreenable}`)
  console.log(`  Judged clear        : ${by('clear').length}`)
  console.log(`  EXCLUDED            : ${by('excluded').length}`)
  console.log(`  RESTORED            : ${result.restored.length} (excluded before; ${commit ? 'their removal reason is cleared' : 'would have their removal reason cleared'})`)
  console.log(`  Held, no verdict    : ${by('held').length}`)
  console.log(`  Model questions     : ${result.judge_calls} (${COMPETITOR_JUDGE_MODEL}), $${spend.toFixed(4)} at full price`)
  runSpend.add(spend)
  console.log(`  Spend               : ${runSpend.summary()} (--max-usd), ${result.judge_calls} of the ${maxJudgeCalls} questions allowed`)
  const heldAtCap = result.details.filter(d => d.held_reason === 'call_budget').length
  if (heldAtCap > 0) {
    console.log(`  HELD AT THE CAP     : ${heldAtCap} not asked about, because ${maxJudgeCalls === MAX_JUDGE_CALLS ? `one run asks at most ${MAX_JUDGE_CALLS} questions` : 'the --max-usd cap allowed no more questions. Raise --max-usd to reach them'}. Held is not cleared: they are asked about on a later run.`)
  }
  // The count above was worked out from a stated worst case. If the bill still passed the
  // cap, that worst case is wrong and somebody needs to know.
  if (runSpend.spent > runSpend.capUsd) {
    console.log('  OVER THE CAP        : the run spent more than --max-usd allowed. The worst case per question in this script is too low and needs correcting.')
  }
  for (const p of result.problems) console.log(`  PROBLEM IN THE BRIEF: ${p}`)

  for (const outcome of ['excluded', 'clear', 'held'] as const) {
    const rows = by(outcome)
    if (rows.length === 0) continue
    console.log('')
    console.log(`  ${outcome.toUpperCase()} (${rows.length})`)
    for (const d of rows) {
      console.log(`    ${d.prospect_id.slice(0, 8)}  ${nameOf.get(d.prospect_id)}${uploadedIds.has(d.prospect_id) ? '  [already uploaded]' : ''}`)
      console.log(`              phrases: ${d.phrase_hits.join(', ')}`)
      if (d.in_category) console.log(`              model said: ${d.in_category}`)
      if (d.main_business) console.log(`              mainly sells: ${d.main_business}`)
      if (d.evidence.length) console.log(`              evidence: ${d.evidence.join(' | ')}`)
      if (d.held_reason) console.log(`              held: ${d.held_reason}`)
      if (d.restored) console.log('              RESTORED: excluded under an earlier list')
    }
  }
  console.log('')

  if (out) {
    fs.writeFileSync(out, JSON.stringify(result.details.map(d => ({ ...d, company_name: nameOf.get(d.prospect_id) })), null, 2))
    console.log(`  Wrote ${out}. It names real firms: do not commit it.`)
    console.log('')
  }
}

main().catch(err => {
  console.error('')
  console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`)
  console.error('')
  process.exit(1)
})
