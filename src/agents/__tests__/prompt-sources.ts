// Every place prompt text lives, and how to read it back out.
//
// WHY A REGISTRY AND NOT A GLOB. docs/prompts/ holds twelve markdown files and only
// SIX of them are read at runtime; the rest are documentation of agents that either
// build their prompt in TypeScript or no longer exist. A glob over the directory
// would scan four files nothing sends to a model, and miss the ~1,300 lines of
// prompt text that live in template literals under src/. Scanning the wrong set
// while reporting success is the failure this whole file exists to avoid.
//
// SEVEN MARKDOWN FILES ARE SCANNED, SIX OF THEM RUNTIME-LOADED. The seventh is
// shared-voice-spec.md, which no loader reads and which is prompt text anyway because
// it is copied by hand into four of the other six. `loadedAtRuntime` is what separates
// the two, so "scanned" and "loadable" stay different questions with different answers.
//
// ONE LIST OF PAIRS, never two parallel arrays. Each entry names both the location
// and how to extract it, so a source cannot be added without saying how it is read.
//
// KEEPING IT HONEST: prompt-forbidden-content.test.ts asserts that every
// `loadSystemPrompt` in the codebase resolves to a markdown file named here, so a
// seventh runtime-read prompt file cannot appear without this list learning about
// it. That check is what stops this registry from silently going stale.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exemptRegions, redactExampleQuotes } from './prompt-scan'

export type PromptSource =
  | { kind: 'markdown'; path: string; note: string; loadedAtRuntime: boolean }
  | { kind: 'template-literal'; path: string; symbol: string; note: string }

export const PROMPT_SOURCES: PromptSource[] = [
  // ── Markdown, read from disk at runtime by a loadSystemPrompt() ──
  { kind: 'markdown', path: 'docs/prompts/icp-agent.md',            note: 'icp-generation-agent.ts',        loadedAtRuntime: true },
  { kind: 'markdown', path: 'docs/prompts/positioning-agent.md',    note: 'positioning-generation-agent.ts', loadedAtRuntime: true },
  { kind: 'markdown', path: 'docs/prompts/tov-agent.md',            note: 'tov-generation-agent.ts',        loadedAtRuntime: true },
  { kind: 'markdown', path: 'docs/prompts/messaging-agent.md',      note: 'messaging-generation-agent.ts',  loadedAtRuntime: true },
  { kind: 'markdown', path: 'docs/prompts/faq-extraction-agent.md', note: 'faq-extraction-agent.ts',        loadedAtRuntime: true },
  { kind: 'markdown', path: 'docs/prompts/reply-draft-agent.md',    note: 'reply-draft-agent.ts',           loadedAtRuntime: true },

  // ── Markdown that reaches a model by COPY rather than by loader ──
  //
  // THE CANONICAL SPEC IS NOT LOADED AT RUNTIME AND IS STILL PROMPT TEXT. Its content is
  // hand-copied into the four document prompts under "## Shared voice rules", so anything
  // written here reaches a model on the next re-sync. That re-sync is a MANUAL procedure
  // documented in the file's own header; no script performs it and nothing checks it ran.
  //
  // Scanning the four copies and not the source is the shape where a correction to a copy
  // is reverted by the next sync and the scan reports success throughout. Two exemplar
  // passages and a caption were corrected in messaging-agent.md on 2026-08-29 while their
  // originals sat untouched here, which is exactly that, and it is why this entry exists.
  { kind: 'markdown', path: 'docs/prompts/shared-voice-spec.md',    note: 'copied by hand into the four document prompts', loadedAtRuntime: false },

  // ── TypeScript template literals, sent as a system prompt ──
  { kind: 'template-literal', path: 'src/lib/agents/research/write-opening.ts',            symbol: 'buildWriterPrompt',    note: 'the research writer, ~9.3k tokens' },
  { kind: 'template-literal', path: 'src/lib/agents/research/write-opening.ts',            symbol: 'buildFloorPrompt',     note: 'the research floor judge' },
  { kind: 'template-literal', path: 'src/lib/agents/research/write-opening.ts',            symbol: 'buildJudgePrompt',     note: 'the research comparison judge' },
  { kind: 'template-literal', path: 'src/lib/agents/research/prompts/synthesis-prompt.ts', symbol: 'buildSynthesisPrompt', note: 'research synthesis' },
  { kind: 'template-literal', path: 'src/lib/agents/reply-classifier.ts',                  symbol: 'SYSTEM_PROMPT',        note: 'reply classification' },
  { kind: 'template-literal', path: 'src/lib/agents/faq-seed-agent.ts',                    symbol: 'buildSystemPrompt',    note: 'FAQ seeding' },
  { kind: 'template-literal', path: 'src/lib/composition/personalization.ts',              symbol: 'systemPrompt',         note: 'the bridge; dormant behind BRIDGE_ENABLED=false but still shipped code' },
  { kind: 'template-literal', path: 'src/lib/agents/revision/run-revision.ts',             symbol: 'buildRevisionPrompt',  note: 'document revision' },

  // ── The sourcing tuner's judge ──
  //
  // ADDED 2026-09-08 with the tuner. It is the only prompt in this repository whose whole
  // subject is deciding what an organisation is from its name, which is the shortest
  // possible distance to writing a sector down, so it is scanned from the day it exists
  // rather than the day someone notices. It carries ZERO against the deny list, measured
  // before and after the entry was added, and the total stays at 29.
  { kind: 'template-literal', path: 'src/lib/tuner/judge.ts',                              symbol: 'buildJudgePrompt',     note: 'the sourcing tuner judge' },

  // ── The tuner's fit judge ──
  //
  // ADDED 2026-09-09. It decides whether a researched organisation is the best kind of
  // customer, an acceptable one, or neither, which makes it the prompt most likely to reach
  // for a sector noun. Scanned from the day it exists rather than the day someone notices.
  { kind: 'template-literal', path: 'src/lib/tuner/fit-judge.ts',                           symbol: 'buildFitJudgePrompt',  note: 'the tuner fit judge, four verdicts' },

  // ── The name signal ──
  //
  // ADDED 2026-09-09. THIS IS THE HIGHEST-RISK PROMPT IN THE REPOSITORY for this scan, and it
  // is the reason the scan exists. Its entire job is deciding what an organisation is from
  // its name and nothing else, so a single concrete noun written into it would become a rule
  // about names that outlives every client and applies to all of them.
  //
  // The design test, which the scan cannot check but a reader can: the same employer name
  // must be able to come back one way for one client and the opposite way for another,
  // decided only by the four descriptions injected at run time. Any rule in this prompt that
  // survives changing the client is the violation.
  { kind: 'template-literal', path: 'src/lib/tuner/name-signal.ts',                        symbol: 'buildNameSignalPrompt', note: 'the name signal, four answers, highest Rule Zero risk' },

  // ── The web lookup's own instruction ──
  //
  // ADDED 2026-09-09 with the cheaper read. It had been sending model-facing text since long
  // before the tuner existed and was never on this list, because it lives in a utility rather
  // than in an agent file. It is a prompt regardless of which directory it sits in: it is the
  // text that decides what gets read about a real organisation, and it now carries a second
  // framing added specifically to make the model stop searching.
  //
  // BOTH framings are inside searchViaNativeAnthropic, so naming the function rather than a
  // constant scans the default and the brief one together. Scanning only the new one would
  // leave the older text unscanned for the same reason it was unscanned before.
  { kind: 'template-literal', path: 'src/lib/agents/tools/webSearch.ts',                    symbol: 'searchViaNativeAnthropic', note: 'the web lookup, default and brief framings' },
  // ── The document agents' USER MESSAGES ──
  //
  // ADDED 2026-09-08, and this registry was WRONG WITHOUT THEM in the most specific way
  // possible: these are the exact files the industry-hardcoding incident happened in, and
  // they were the only prompt text in the repository that nothing scanned.
  //
  // On 2026-06-10 `buildUserMessage` in icp-generation-agent.ts opened, unconditionally:
  //
  //     You are generating an ICP document for a founder-led B2B consulting firm.
  //
  // with all four of its research queries naming the same industry and two naming a country.
  // A medical-device manufacturer was given a consulting ICP, and a sourcing run bought 20
  // healthcare consultancies against it. Positioning and TOV carried the same sentence.
  //
  // The Backlog row that recorded it proposed, as the durable fix, "a test that asserts no
  // agent prompt template contains a literal industry or country name". That test was
  // written. It scanned the six markdown SYSTEM prompts and nine template literals under
  // src/lib, and it did not scan src/agents at all. So the guard existed, passed, and could
  // not see the file the incident happened in. The prompt was fixed by hand on main in
  // PR #62 and the hole in the scan stayed open for four more days.
  //
  // A system prompt and a user message are both prompt text. Only one of them was ever
  // treated that way here.
  { kind: 'template-literal', path: 'src/agents/icp-generation-agent.ts',         symbol: 'buildUserMessage', note: 'the ICP user message, where the hardcoded industry lived' },
  { kind: 'template-literal', path: 'src/agents/positioning-generation-agent.ts', symbol: 'buildUserMessage', note: 'the positioning user message, same sentence' },
  { kind: 'template-literal', path: 'src/agents/tov-generation-agent.ts',         symbol: 'buildUserMessage', note: 'the TOV user message, same sentence' },
  { kind: 'template-literal', path: 'src/agents/messaging-generation-agent.ts',   symbol: 'buildUserMessage', note: 'the messaging user message' },
  { kind: 'template-literal', path: 'src/agents/messaging-generation-agent.ts',   symbol: 'buildSingleVariantUserMessage', note: 'the messaging single-variant retry, a SECOND prompt in the same file' },
  { kind: 'template-literal', path: 'src/agents/buyer-criterion-agent.ts',        symbol: 'buildUserMessage', note: 'the buyer criterion user message; its own docs say an example job title here reaches every client' },
]

// The markdown prompt files a loadSystemPrompt() is allowed to resolve to. Derived
// from PROMPT_SOURCES rather than restated, so the two cannot disagree.
//
// `loadedAtRuntime` IS REQUIRED, NOT OPTIONAL, and that is the whole guard. A markdown
// entry added without it is a COMPILE ERROR, which is the notification that somebody has
// to decide whether a loadSystemPrompt may resolve to it. Defaulting the field would make
// the shared spec silently loadable the day the next unscanned file is added.
export const RUNTIME_MARKDOWN = PROMPT_SOURCES
  .filter((s): s is Extract<PromptSource, { kind: 'markdown' }> => s.kind === 'markdown')
  .filter(s => s.loadedAtRuntime)
  .map(s => s.path)

export interface SourceText { label: string; lines: { n: number; text: string }[] }

/**
 * Pulls the text of EVERY template literal belonging to one symbol, with real line
 * numbers preserved so a hit can be pointed at.
 *
 * EVERY, not the first, and that is the whole correctness of this function. The
 * first version took "the next backtick after the declaration" and on
 * run-revision.ts it stopped at a one-line helper literal, reporting 1 line scanned
 * for a prompt builder that assembles roughly 40. It found zero hits and looked
 * like a pass. buildRevisionPrompt holds three literals — a failure block, a
 * messaging-rules block and the returned prompt — and all three are interpolated
 * into what the model receives, so all three are prompt text.
 *
 * Walks characters rather than matching a regex, because these literals contain
 * backticks (a fenced json block), `${...}` interpolations and escapes. It tracks
 * brace depth so it knows where the declaration's body ends, and it skips over
 * ordinary quoted strings and comments so a backtick inside either cannot open a
 * phantom literal.
 *
 * Throws rather than returning empty if the symbol is not found or a literal is
 * unterminated. A registry entry that no longer resolves is a stale registry and it
 * has to be loud: returning [] would let a renamed prompt drop out of coverage
 * while the suite stayed green, which is the failure this file exists to prevent.
 */
/**
 * The index to begin scanning a declaration's body from.
 *
 * For a `function name(...)` declaration this is the matching `)` of the parameter list, so
 * an inline object type in the parameters cannot be mistaken for the function body. For a
 * `const name = ...` declaration there is no parameter list to skip, so the declaration index
 * is returned unchanged and the existing `;`/literal termination applies.
 */
function bodyStart(src: string, declIdx: number): number {
  const open = src.indexOf('(', declIdx)
  if (open === -1) return declIdx

  // Anything that arrives BEFORE the paren means this is not a function signature, and the
  // paren belongs to something else entirely, quite possibly inside the literal we are
  // looking for. `const SYSTEM_PROMPT = \`... (like this) ...\`` is the live case: skipping
  // to that paren jumped past the whole prompt and reported it missing.
  //
  // Checked in the order they can legally appear:
  //   =  an assignment, so a const/let/var rather than a function declaration
  //   `  the literal itself has already started
  //   {  a body or an object has already opened
  for (const stop of ['=', '`', '{']) {
    const at = src.indexOf(stop, declIdx)
    if (at !== -1 && at < open) return declIdx
  }

  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return declIdx
}

export function extractTemplateLiteral(abs: string, symbol: string): SourceText['lines'] {
  const src = readFileSync(abs, 'utf-8')
  const declaration = new RegExp(`(?:function|const|let|var)\\s+${symbol}\\b`)
  const declIdx = src.search(declaration)
  if (declIdx === -1) throw new Error(`prompt-sources: symbol "${symbol}" not found in ${abs}`)

  // START AFTER THE PARAMETER LIST, not at the declaration.
  //
  // A function whose parameter is an inline object TYPE, which is how all six agent prompt
  // builders are written:
  //
  //     function buildUserMessage(params: { intake: IntakeRow[]; ... }): string {
  //
  // opens and closes a brace before the body begins. The scan below counts braces to find
  // the end of the body, so starting at the declaration made it treat the parameter type as
  // the body: `entered` went true on the type's `{`, depth returned to 0 on its `}`, and the
  // loop broke before reaching a single line of prompt text. It then threw "no template
  // literal found", which reads like the prompt is missing rather than like the reader
  // stopped early.
  //
  // Skipping to the matching `)` of the parameter list removes the whole class: parameter
  // types can contain braces, generics, defaults and nested objects, and none of it is body.
  // Parentheses are matched rather than searched for, because a default value or a nested
  // signature can contain `)`.
  const scanFrom = bodyStart(src, declIdx)

  const lineOf = (idx: number) => src.slice(0, idx).split('\n').length
  const out: SourceText['lines'] = []
  let depth = 0
  let entered = false

  for (let i = scanFrom; i < src.length; i++) {
    const c = src[i]

    // Comments: skip wholesale, so a backtick in prose cannot open a literal.
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) break; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e === -1) break; i = e + 1; continue }

    // Ordinary strings: skip, same reason.
    if (c === '"' || c === "'") {
      const q = c
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue }
        if (src[i] === q) break
      }
      continue
    }

    if (c === '`') {
      const open = i
      let exprDepth = 0
      for (i++; i < src.length; i++) {
        const d = src[i]
        if (d === '\\') { i++; continue }
        if (exprDepth === 0 && d === '`') break
        if (d === '$' && src[i + 1] === '{') { exprDepth++; i++; continue }
        if (exprDepth > 0 && d === '}') exprDepth--
      }
      if (i >= src.length) throw new Error(`prompt-sources: unterminated template literal for "${symbol}" in ${abs}`)
      const first = lineOf(open)
      src.slice(open + 1, i).split('\n').forEach((text, k) => out.push({ n: first + k, text }))
      // A `const X = \`...\`` declaration ends with its literal.
      if (!entered) break
      continue
    }

    if (c === '{') { depth++; entered = true; continue }
    if (c === '}') { depth--; if (entered && depth === 0) break; continue }

    // A `const X = value` with no body and no literal: stop at the statement end.
    if (c === ';' && !entered) break
  }

  if (out.length === 0) throw new Error(`prompt-sources: no template literal found for "${symbol}" in ${abs}`)
  return out
}

/**
 * Reads one source into numbered lines, whichever kind it is.
 *
 * MARKDOWN GOES THROUGH THE EXISTING EXEMPTION MACHINERY in prompt-scan.ts, reused
 * rather than reimplemented. Two of the three exemptions are load-bearing here:
 *
 *   the canonical industry list — CLAUDE.md REQUIRES those exact NAICS-derived names
 *   in the ICP prompt, so a scan that flags them is asking for the opposite of the
 *   rule. Nineteen of this scan's first twenty-seven ICP hits were that list.
 *
 *   labelled examples in quotes — "Wrong: ..." lines quote the banned thing on
 *   purpose, which is how a prompt teaches a model not to write it.
 *
 * Template literals get NO exemptions, because none of the three markers exists in
 * TypeScript. If a literal ever needs one, it needs it for a stated reason and the
 * mechanism has to be extended deliberately, not inherited by accident.
 */
export function readSource(s: PromptSource, cwd = process.cwd()): SourceText {
  if (s.kind === 'markdown') {
    const raw = readFileSync(join(cwd, s.path), 'utf-8').split('\n')
    const regions = exemptRegions(raw, s.path)
    const exempt = (n: number) => regions.some(r => n >= r.from && n <= r.to)
    return {
      label: s.path,
      lines: raw
        .map((text, k) => ({ n: k + 1, text }))
        .filter(l => !exempt(l.n))
        .map(l => ({ n: l.n, text: redactExampleQuotes(l.text) })),
    }
  }
  return { label: `${s.path}:${s.symbol}`, lines: extractTemplateLiteral(join(cwd, s.path), s.symbol) }
}
