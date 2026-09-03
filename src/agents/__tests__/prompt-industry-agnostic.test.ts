// The WHOLE-FILE industry-agnosticism scan, added 2026-08-28.
//
// rule-text-category-level.test.ts scans Rules 1 to 10 only, and says so deliberately.
// That scope let five industry assumptions sit in ICP runtime prompt text for months,
// including one four lines from Rule 9B telling the model to do the opposite. This scan
// covers the whole file, with three structural exemptions and a per-file baseline.
//
// THE BASELINE IS THE POINT. Setting it to the measured count makes the check live
// immediately across all four prompts without requiring every existing violation to be
// fixed in one commit, and every number can only go DOWN. A new violation fails the same
// day it is written.
//
// TOOL-AGNOSTICISM IS A SEPARATE SCAN, in prompt-tool-agnostic.test.ts. Different rule,
// different fix, and one scan carrying two exemption regimes is how an exemption list
// starts growing.

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { scanFile, canonicalListIsBareEnumeration, exemptRegions, redactExampleQuotes, MAX_EXEMPT_LINES_PER_FILE, MAX_EXEMPT_REGIONS_PER_FILE, type Pattern } from './prompt-scan'
import { readFileSync } from 'node:fs'

const PROMPTS = ['icp', 'positioning', 'tov', 'messaging'].map(n => `docs/prompts/${n}-agent.md`)
const SPEC = 'docs/prompts/shared-voice-spec.md'
const abs = (p: string) => join(process.cwd(), p)

const INDUSTRY: Pattern[] = [
  // "construction" was BARE here and matched "sentence construction" in the messaging
  // prompt. A false positive in a scan people are meant to trust is how exemptions get
  // asked for, so the pattern requires an industry noun after it rather than being
  // exempted at the line.
  //
  // FOUR ENTRIES ENDED MID-WORD AND THEN DEMANDED A WORD BOUNDARY, repaired 2026-08-31.
  // A truncated stem is only useful as a PREFIX, and \b is exactly what stops it being one:
  // the pattern reached the stem's last letter and asked for a boundary that the following
  // letter cannot provide. Each was dead for the whole time it was listed, which is worse
  // than absent, because a term written down reads as covered. The one inside the
  // construction group is the worst of them, because the phrasing it was most likely to
  // meet is the one it could never match.
  //
  // Repaired to the same form PR #19 used for this defect in the sibling deny-list data
  // module. That form is copied, not re-derived. Named by description rather than by
  // filename on purpose: a RULE ZERO guard flags any file under src/ that contains that
  // module's name, and it matches a mention in a comment as readily as a real import.
  // Measured one at a time and all together: +0 hits on every one of the five
  // sources below, so these were dead entries rather than suppressed hits, and every
  // baseline in this file is untouched.
  //
  // THE PLURALS ARE A SEPARATE, STILL-OPEN GAP and are deliberately not touched here. Most
  // nouns in this pattern are still bounded on the singular, so the plural form remains
  // invisible to it. Closing that in the sibling data file MOVED a count, which is a
  // widening that has to be argued for on its own evidence rather than smuggled into a
  // repair measured at zero.
  { label: 'named industry or sector', re: /\b(consult(ing|ant|ancy)|school catering|catering suppl(y|ies|ier|iers)|logistics|SaaS|manufactur(ing|er)|recruitment agenc(y|ies)|law firm|accountanc(y|ies)|hospitality|construction (firm|compan(y|ies)|industry|sector|business)|e-?commerce|fintech|healthcare provider)\b/i },
  { label: 'named country or nationality', re: /\b(Ireland|Irish|United Kingdom|Britain|British|England|Scotland|Wales|United States|America|American|Germany|German|France|French|Spain|Spanish|Canada|Canadian|Australia|Australian)\b/ },
  { label: 'named public body or programme', re: /\bDepartment of [A-Z]|\bMinistry of [A-Z]|\b(HSE|NHS|safefood|An Taisce|Green Schools|Green Flag|Hot School Meals|Revenue Commissioners|Companies House|HMRC|IRS|FDA|FCA|SEC)\b/ },
  { label: 'named statute or regulation', re: /\b(GDPR|CCPA|HIPAA|Sarbanes[- ]Oxley|SOX|Companies Act|Data Protection Act)\b/ },
  { label: 'named standard or scheme', re: /\bISO ?\d{4,5}\b|\b(SOC ?2|PCI[- ]DSS|Cyber Essentials|B Corp)\b/i },
]

// Measured 2026-08-28, after the ICP prompt was cleaned. These may only go DOWN.
//
// icp 1:          a four-line inline example of the unmatched-industries mechanic quotes
//                 two names from the canonical list. It is the same KIND of content as
//                 exemption A but sits outside the delimiters, and widening exemption A or
//                 B to reach it would cost more than recording it here.
// positioning 4:  same class as the five fixed in the ICP prompt. Not fixed in this
//                 session, which was scoped to the ICP path.
// tov 1:          same.
// messaging 8:    same, and the messaging prompt feeds the send path, so it is not edited
//                 as a drive-by.
//
// RATCHETED DOWN 2026-09-03, 14 -> 9, by the pass that removed the client's own sector from
// RULE PROSE rather than from examples. positioning 4 -> 0 and tov 1 -> 0.
//
// WHAT MOVED, and none of it was an example. positioning-agent.md named the sector in its
// QUALITY BAR ("should apply to no other consulting firm", "any boutique consultancy"), in
// Rule 3's differentiator test ("any other consulting pipeline service"), and in a banned
// phrase built around how that sector is sold. tov-agent.md named it in Rule 5's
// generic-item test ("any consulting firm's TOV guide"). Each is an instruction that every
// client's document generation runs through, so each was telling the model the client's
// category before the ICP document got a word in.
//
// THE ONE IN THE QUALITY BAR IS THE ONE THIS SCAN'S OWN NOTES ALREADY KNEW ABOUT: the
// sibling deny-list module records trying a negation guard here and rejecting it precisely
// because it silenced positioning-agent.md L38. That hit was real, it was described in two
// files, and it stayed for the recorded lifetime of both. Being visible in a baseline is
// not the same as being fixed.
//
// icp 1 and messaging 8 are UNCHANGED and were re-measured, not assumed. The icp hit is the
// inline unmatched-industries example this table already describes. The messaging figure is
// untouched because that prompt feeds the send path and its Rules 17 to 23 quote copy that
// actually shipped; it is not edited as a drive-by.
const BASELINE: Record<string, number> = {
  'docs/prompts/icp-agent.md': 1,
  'docs/prompts/positioning-agent.md': 0,
  'docs/prompts/tov-agent.md': 0,
  'docs/prompts/messaging-agent.md': 8,
  'docs/prompts/shared-voice-spec.md': 0,
}

describe('prompt files name no industry, country, public body, statute or standard', () => {
  it.each([...PROMPTS, SPEC])('%s is at or below its recorded baseline', path => {
    const hits = scanFile(abs(path), INDUSTRY)
    const allowed = BASELINE[path]
    expect(allowed, `${path} has no recorded baseline`).toBeTypeOf('number')
    expect(
      hits.length,
      `${path}: ${hits.length} hits, baseline ${allowed}. ` +
      `Baselines may only go down.\n  ${hits.map(h => `L${h.line} [${h.label}] «${h.match}» ${h.text}`).join('\n  ')}`,
    ).toBeLessThanOrEqual(allowed)
  })

  it('the baseline has not been raised to make a failure go away', () => {
    // Guards the guard. The recorded total is the thing a future edit is most likely to
    // reach for, so it is asserted against the value measured when the scan was written.
    // TIGHTENED WITH THE RATCHET, 14 -> 9. Leaving the cap at the old figure would let the
    // five lines just removed be written back one at a time while this still passed, which
    // is the whole failure mode a recorded total exists to prevent. A ratchet whose guard
    // is not moved down with it has stopped guarding the part that changed.
    expect(Object.values(BASELINE).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(9)
    expect(Object.keys(BASELINE)).toHaveLength(5)
  })

  it('found real content to scan, so nothing above passes vacuously', () => {
    for (const p of [...PROMPTS, SPEC]) {
      expect(readFileSync(abs(p), 'utf-8').length, p).toBeGreaterThan(5000)
    }
  })
})

describe('the exemptions are structurally capped', () => {
  it('the caps themselves are the measured values and have not been raised', () => {
    // THE FIRST VERSION OF THIS TEST WAS SELF-REFERENTIAL AND A MUTATION SURVIVED IT.
    // It asserted `exemptLines <= MAX_EXEMPT_LINES_PER_FILE`, so raising the constant to
    // 200 raised the assertion with it and the suite stayed green. The constants are now
    // pinned to the figures measured on 2026-08-28. Changing either is a two-line diff
    // that has to be explained, which is what a recorded total is for.
    expect(MAX_EXEMPT_REGIONS_PER_FILE).toBe(3)
    expect(MAX_EXEMPT_LINES_PER_FILE).toBe(43)
  })

  it('each file claims no more exempt lines than were measured', () => {
    // Asserted against LITERALS, not against the constants above, so that raising a
    // constant cannot raise this too.
    const measured: Record<string, number> = {
      'docs/prompts/icp-agent.md': 43,
      'docs/prompts/positioning-agent.md': 0,
      'docs/prompts/tov-agent.md': 0,
      'docs/prompts/messaging-agent.md': 0,
      'docs/prompts/shared-voice-spec.md': 0,
    }
    for (const p of [...PROMPTS, SPEC]) {
      const regions = exemptRegions(readFileSync(abs(p), 'utf-8').split('\n'), p)
      expect(regions.length, `${p} regions`).toBeLessThanOrEqual(3)
      const lines = regions.reduce((n, r) => n + (r.to - r.from + 1), 0)
      expect(lines, `${p} exempts ${lines} lines, measured ${measured[p]}`).toBeLessThanOrEqual(measured[p])
    }
  })

  it('exemption A covers a bare enumeration and not hidden prose', () => {
    // The canonical-list exemption is the widest of the three, so it is the one that has
    // to be proved harmless. Every non-blank line inside the markers must be part of the
    // pipe-delimited list. An instruction written in there would show up here.
    expect(canonicalListIsBareEnumeration(abs('docs/prompts/icp-agent.md'))).toEqual([])
  })

  it('exemption B needs a label AND quotes, so ordinary prose cannot claim it', () => {
    // Tested directly rather than through the real files. A mutation granting the
    // exemption to EVERY line survived the previous version of this test, because no
    // prompt line today has a labelled example with a scanned term outside its quotes.
    const hit = (s: string) => INDUSTRY.some(p => p.re.test(redactExampleQuotes(s)))

    // Labelled, term inside the quotes: exempt. This is Rule 9's "Acme Group" shape.
    expect(hit('Wrong (guide-led opener): "We help consulting firms build pipeline"')).toBe(false)
    expect(hit('Right: "a consulting firm"')).toBe(false)

    // Labelled, but the term is OUTSIDE the quotes: NOT exempt. The label is not a
    // blanket pass for the rest of the line.
    expect(hit('Wrong: consulting firms are the target, e.g. "some quote"')).toBe(true)

    // Unlabelled line containing a quotation: NOT exempt. A quote alone earns nothing.
    expect(hit('The document says "a consulting firm" here')).toBe(true)

    // And redaction must leave an unlabelled line completely untouched.
    expect(redactExampleQuotes('plain "quoted" prose')).toBe('plain "quoted" prose')
  })

  it('the industry patterns still match what they claim, and not what they do not', () => {
    const probe = (text: string) => INDUSTRY.some(p => p.re.test(text))
    expect(probe('a consulting firm')).toBe(true)
    expect(probe('schools in Ireland')).toBe(true)
    expect(probe('the Department of Transport')).toBe(true)
    expect(probe('ISO 9001 compliance')).toBe(true)
    expect(probe('a construction firm')).toBe(true)
    // The four entries repaired on 2026-08-31. Each ended mid-word and was then followed
    // by \b, so each matched nothing at all. These fail if a fragment is reintroduced,
    // which the hit counts cannot do: a dead entry and a correct one both score zero.
    expect(probe('a catering supplier')).toBe(true)
    expect(probe('a recruitment agency')).toBe(true)
    expect(probe('an accountancy practice')).toBe(true)
    expect(probe('a construction company')).toBe(true)
    // The false positive that would have been exempted at the line instead of fixed.
    expect(probe('Parallel sentence construction across consecutive sentences')).toBe(false)
    expect(probe('a public body or government agency')).toBe(false)
    expect(probe('the sector the buyer operates in')).toBe(false)
  })
})
