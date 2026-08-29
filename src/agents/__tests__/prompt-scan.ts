// Shared scanning primitives for the two prompt-text scans.
//
// WHY THIS IS ONE MODULE AND NOT COPIED INTO BOTH TESTS. The exemption machinery is the
// part most likely to drift, and two copies of an exemption rule is the parallel-list
// shape CLAUDE.md warns about: the industry scan would grow an exemption the vendor scan
// never learned about, and nobody would notice because both suites stay green.
//
// THE TWO SCANS ARE STILL SEPARATE TESTS ON PURPOSE. Industry-agnosticism and
// tool-agnosticism are different rules with different fixes. One scan carrying two
// exemption regimes is how an exemption list starts growing.

import { readFileSync } from 'node:fs'

export interface Pattern { label: string; re: RegExp }

// ─── Exemptions ───────────────────────────────────────────────────────────────
//
// Three kinds, each capped by a STRUCTURAL property rather than by a list of blessed
// lines. A list of lines grows one line at a time and never shrinks. A structural cap
// has to be argued with.

// A. The canonical industry enumeration. CLAUDE.md REQUIRES these exact NAICS-derived
//    names, so the scan cannot ask for them to be removed. Bounded by explicit markers,
//    so the block cannot creep outward into surrounding prose, and asserted to be a bare
//    enumeration: if someone writes an instruction inside the markers, EXEMPT_A_MAX_PROSE
//    catches it.
const CANONICAL_BEGIN = '<!-- CANONICAL-INDUSTRY-LIST:BEGIN -->'
const CANONICAL_END = '<!-- CANONICAL-INDUSTRY-LIST:END -->'

// B. Labelled examples. Rule 9's "Acme Group" already works this way. A line only earns
//    this exemption if it is LABELLED as an example and the named thing is INSIDE QUOTES,
//    so ordinary prose cannot claim it by accident.
const EXAMPLE_LABEL = /^\s*(Wrong|Right|Banned|Bad|Good)\b[^:]{0,40}:/

// C. Worked-example sections. One per file, whole-section, matched by heading.
const WORKED_EXAMPLE_HEADING = /^#{2,3} Worked example/

// The guard on the guard. Raising either of these is a deliberate act that shows up in a
// diff and has to be explained, which is the entire point of a structural cap.
export const MAX_EXEMPT_REGIONS_PER_FILE = 3

// MEASURED, not chosen. On 2026-08-28 the only file with any exempt region is
// icp-agent.md: the canonical industry list is 25 lines and the worked example is 18, so
// 43. The other three prompts have zero. The cap is set AT the measured total rather than
// above it, so the next line added to either region fails this and has to be argued for
// in a diff. That is the whole mechanism: an exemption list that can grow silently is how
// a check stops checking.
//
// The first value tried here was 40, chosen by guess. It failed, which is the correct
// behaviour and is why the number is measured now.
export const MAX_EXEMPT_LINES_PER_FILE = 43

export interface ExemptRegion { kind: 'canonical-list' | 'worked-example'; from: number; to: number }

// Returns the line ranges (1-indexed, inclusive) that are exempt, and throws if the file
// claims more regions than the cap allows.
export function exemptRegions(lines: string[], path: string): ExemptRegion[] {
  const regions: ExemptRegion[] = []

  const begin = lines.findIndex(l => l.includes(CANONICAL_BEGIN))
  const end = lines.findIndex(l => l.includes(CANONICAL_END))
  if (begin !== -1 || end !== -1) {
    if (begin === -1 || end === -1 || end <= begin) {
      throw new Error(`${path}: canonical-industry-list markers are unbalanced`)
    }
    regions.push({ kind: 'canonical-list', from: begin + 1, to: end + 1 })
  }

  // One worked-example section, running to the next heading of the same or higher level.
  const we = lines.findIndex(l => WORKED_EXAMPLE_HEADING.test(l))
  if (we !== -1) {
    if (lines.slice(we + 1).some(l => WORKED_EXAMPLE_HEADING.test(l))) {
      throw new Error(`${path}: more than one worked-example section, which exemption C does not allow`)
    }
    let to = lines.length
    for (let i = we + 1; i < lines.length; i++) {
      if (/^#{1,3} /.test(lines[i])) { to = i; break }
    }
    regions.push({ kind: 'worked-example', from: we + 1, to })
  }

  if (regions.length > MAX_EXEMPT_REGIONS_PER_FILE) {
    throw new Error(`${path}: ${regions.length} exempt regions, cap is ${MAX_EXEMPT_REGIONS_PER_FILE}`)
  }
  const exemptLines = regions.reduce((n, r) => n + (r.to - r.from + 1), 0)
  if (exemptLines > MAX_EXEMPT_LINES_PER_FILE) {
    throw new Error(`${path}: ${exemptLines} exempt lines, cap is ${MAX_EXEMPT_LINES_PER_FILE}`)
  }
  return regions
}

export interface Hit { line: number; label: string; match: string; text: string }

// Scans a whole prompt file, honouring the three exemptions.
export function scanFile(path: string, patterns: Pattern[]): Hit[] {
  const lines = readFileSync(path, 'utf-8').split('\n')
  const regions = exemptRegions(lines, path)
  const exempt = (n: number) => regions.some(r => n >= r.from && n <= r.to)

  const hits: Hit[] = []
  lines.forEach((line, i) => {
    const lineNo = i + 1
    if (exempt(lineNo)) return
    const searchable = redactExampleQuotes(line)
    for (const { label, re } of patterns) {
      const m = searchable.match(re)
      if (m) { hits.push({ line: lineNo, label, match: m[0], text: line.trim().slice(0, 100) }); break }
    }
  })
  return hits
}

// Asserts the canonical-list region really is a bare enumeration and not a place to hide
// prose. Exemption A is the widest of the three, so it is the one that needs this.
export function canonicalListIsBareEnumeration(path: string): string[] {
  const lines = readFileSync(path, 'utf-8').split('\n')
  const region = exemptRegions(lines, path).find(r => r.kind === 'canonical-list')
  if (!region) return []
  return lines
    .slice(region.from, region.to - 1)
    .filter(l => l.trim().length > 0 && !l.includes('|'))
}

// Exemption B, isolated so it can be tested without a fixture file.
//
// A line earns this exemption only if it is LABELLED as an example AND the named thing is
// INSIDE quotes. Both halves matter. Without the label, any line containing a quotation
// could name anything. Without the quote requirement, a labelled line could name something
// in its surrounding prose and still pass, which is a hole wide enough to drive the whole
// rule through.
//
// Extracted after a mutation that made every line count as labelled SURVIVED the suite:
// no real prompt line currently has a labelled example with a scanned term outside its
// quotes, so the real files could not exercise the rule. A guard that only real data can
// reach is a guard with untested branches.
export function redactExampleQuotes(line: string): string {
  if (!EXAMPLE_LABEL.test(line)) return line
  return line.replace(/["\u201c\u201d][^"\u201c\u201d]*["\u201c\u201d]/g, '\u00abexample\u00bb')
}

// ─── Example spans, for the inverted name check ───────────────────────────────
//
// WHY QUOTED SPANS ARE THE DEFINITION OF "EXAMPLE". Every one of the fourteen prompt
// sources marks its examples the same way: the specimen text sits inside quotes, and the
// prose around it explains what the specimen teaches. That is a STRUCTURAL property of how
// these files are written, not a convention this scan is imposing on them, so it does not
// need a per-file marker and cannot be silently opted out of by dropping one.
//
// A span may run over several lines. The writer prompt's worked examples routinely do, and
// a line-by-line matcher misses every one of them: measured on 2026-08-29, matching within
// single lines found 40 capitalised tokens where spanning found 143. Reporting the smaller
// number as a clean result is the failure this whole family of scans exists to avoid, so
// the joined text is matched and the offset is mapped back to a line afterwards.
//
// THE LIMIT, STATED RATHER THAN DISCOVERED LATER. Only quoted text is examined. A real name
// in ordinary prose outside quotes is NOT seen by this. That is deliberate: prose names its
// own subject constantly ("the Moore statement", a section heading) and gating on it would
// bury the specimens under commentary. Examples are where a name gets copied into a real
// email, which is the risk being managed.
export interface ExampleSpan { from: number; to: number; text: string }

export function exampleSpans(lines: { n: number; text: string }[]): ExampleSpan[] {
  const joined = lines.map(l => l.text).join('\n')
  // Offset -> line number, precomputed rather than recounted per match.
  const lineAt: number[] = []
  lines.forEach((l, i) => {
    const len = l.text.length + (i < lines.length - 1 ? 1 : 0)
    for (let k = 0; k < len; k++) lineAt.push(l.n)
  })

  const out: ExampleSpan[] = []
  const re = /["“]([^"“”]{3,600})["”]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(joined))) {
    out.push({
      from: lineAt[m.index] ?? lines[0]?.n ?? 0,
      to: lineAt[Math.min(m.index + m[0].length - 1, lineAt.length - 1)] ?? 0,
      text: m[1],
    })
  }
  return out
}
