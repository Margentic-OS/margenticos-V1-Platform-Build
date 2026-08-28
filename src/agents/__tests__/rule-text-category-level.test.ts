// The shared rule text must be category-level: no named organisation, programme, statute,
// country, industry or sector.
//
// WHY THIS COVERS ALL RULE TEXT AND NOT JUST RULE 9. A test narrower than the standard it
// enforces is the shape that let thirty-five industry-specific violations survive four
// months in these prompts. When Rule 9 was narrowed on 2026-08-28, the same standard was
// applied to it, and applying it only there would have left the Rule 5 derivation rule
// naming two sectors in live runtime prompt text. It did, and this test is why that was
// found and fixed rather than scoped around.
//
// SCOPE: Rules 1 to 10, the block that is canonical in the shared spec and synced verbatim
// into the four runtime prompts. Deliberately NOT the whole prompt file: each agent's own
// sections legitimately discuss the client's industry, and the ICP prompt has a worked
// example section that names a sector on purpose. The rules are the shared, universal part,
// and they are the part that must hold for every client in every market.
//
// The lists below are patterns, not an exhaustive dictionary. They cannot catch every
// possible name. They catch the shapes that have actually appeared in this repo, and the
// last test guards the file itself against being quietly narrowed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SPEC = join(process.cwd(), 'docs/prompts/shared-voice-spec.md')
const PROMPTS = ['icp', 'positioning', 'tov', 'messaging'].map(n =>
  join(process.cwd(), `docs/prompts/${n}-agent.md`),
)

function ruleBlock(path: string): string {
  const raw = readFileSync(path, 'utf-8')
  const isSpec = path.endsWith('shared-voice-spec.md')
  const startRe = isSpec ? /^## Rule 1:/m : /^### Rule 1:/m
  const endRe = isSpec ? /^## Exemplar passages/m : /^### (Rule 11:|Exemplar passages)/m
  const s = raw.search(startRe)
  const e = raw.search(endRe)
  expect(s, `${path}: no Rule 1 heading`).toBeGreaterThan(-1)
  expect(e, `${path}: no end-of-rules heading`).toBeGreaterThan(s)
  return raw.slice(s, e)
}

// Shapes that have actually appeared in this repo's rule text, plus the obvious neighbours.
const BANNED: Array<{ label: string; re: RegExp }> = [
  // Sectors and industries. "consulting" is the one this codebase keeps reaching for.
  { label: 'named industry or sector', re: /\b(consult(ing|ant|ancy)|school catering|catering suppl|logistics|SaaS|manufactur(ing|er)|recruitment agenc|law firm|accountanc|hospitality|construction|e-?commerce|fintech|healthcare provider)\b/i },
  // Countries, nationalities and named markets.
  { label: 'named country or nationality', re: /\b(Ireland|Irish|United Kingdom|Britain|British|England|Scotland|Wales|United States|America|American|Germany|German|France|French|Spain|Spanish|Canada|Canadian|Australia|Australian)\b/ },
  // Public bodies, regulators, programmes, statutes and schemes.
  { label: 'named public body or programme', re: /\bDepartment of [A-Z]|\bMinistry of [A-Z]|\b(HSE|NHS|safefood|An Taisce|Green Schools|Green Flag|Hot School Meals|Revenue Commissioners|Companies House|HMRC|IRS|FDA|FCA|SEC)\b/ },
  { label: 'named statute or regulation', re: /\b(GDPR|CCPA|HIPAA|Sarbanes[- ]Oxley|SOX|Companies Act|Data Protection Act)\b/ },
  { label: 'named standard or scheme', re: /\bISO ?\d{4,5}\b|\b(SOC ?2|PCI[- ]DSS|Cyber Essentials|B Corp)\b/i },
  // Companies. "Acme" is the sanctioned placeholder in Rule 9's Right/Wrong pair.
  { label: 'named company', re: /\b(Accenture|McKinsey|Deloitte|KPMG|PwC|Bain|HubSpot|Salesforce|Instantly|Apollo|Taplio|Lemlist|GoHighLevel|Calendly|Sandler|Lean Enterprise Institute)\b/ },
]

const ALLOWED_PLACEHOLDERS = [
  // The Right/Wrong pair in Rule 9 needs one obviously-fake company name to show the shape
  // of the failure. "Acme Group" is not a real organisation and is the established
  // placeholder in this file.
  'Acme Group',
]

function scan(text: string) {
  let cleaned = text
  for (const p of ALLOWED_PLACEHOLDERS) cleaned = cleaned.split(p).join('«placeholder»')
  const hits: string[] = []
  for (const { label, re } of BANNED) {
    for (const line of cleaned.split('\n')) {
      const m = line.match(re)
      if (m) hits.push(`${label}: "${m[0]}" in: ${line.trim().slice(0, 100)}`)
    }
  }
  return hits
}

describe('shared rule text is category-level', () => {
  it('found rule text to scan, so nothing below passes vacuously', () => {
    const block = ruleBlock(SPEC)
    expect(block.length).toBeGreaterThan(5000)
    expect(block).toContain('Rule 9')
    expect(block).toContain('Rule 9B')
    expect(block).toContain('Rule 10')
  })

  it('the shared spec names no organisation, programme, statute, country or industry', () => {
    const hits = scan(ruleBlock(SPEC))
    expect(hits, `shared-voice-spec.md Rules 1-10:\n  ${hits.join('\n  ')}`).toEqual([])
  })

  it.each(PROMPTS)('%s names none either', path => {
    const hits = scan(ruleBlock(path))
    expect(hits, `${path} Rules 1-10:\n  ${hits.join('\n  ')}`).toEqual([])
  })

  it('Rule 9 in particular is clean, since it is the rule that discusses these categories', () => {
    // Rule 9 Tier Two lists the KINDS of public institution that may be flagged. Naming one
    // as an example would be the easiest way to reintroduce an industry assumption, and it
    // would be the most persuasive one, because it would sit inside the rule that forbids it.
    const block = ruleBlock(SPEC)
    const r9 = block.slice(block.indexOf('## Rule 9:'), block.indexOf('## Rule 10:'))
    expect(r9.length).toBeGreaterThan(1000)
    const hits = scan(r9)
    expect(hits, `Rule 9:\n  ${hits.join('\n  ')}`).toEqual([])
  })

  it('Rule 9B is clean, and it is the rule most likely to attract a worked example', () => {
    // Rule 9B tells the model to be CONCRETE about the client. The tempting way to write
    // that rule is to show what concrete looks like, and every example of a named product
    // range, a delivery mechanism or a founder's background belongs to some real industry.
    // A worked example here would teach the industry along with the rule, inside the rule
    // that is supposed to make the document specific to whichever client is in front of it.
    const block = ruleBlock(SPEC)
    const r9b = block.slice(block.indexOf('## Rule 9B:'), block.indexOf('## Rule 10:'))
    expect(r9b.length, 'Rule 9B not found in the shared spec').toBeGreaterThan(1000)
    const hits = scan(r9b)
    expect(hits, `Rule 9B:\n  ${hits.join('\n  ')}`).toEqual([])
  })

  it('Rule 9B is present in the ICP prompt and says the same thing as the spec', () => {
    // Recorded divergence 7: 9B is in the spec and the ICP prompt only. This asserts the
    // half that IS synced actually matches, so the two cannot drift while the other three
    // prompts wait for the re-sync. Heading level is the one permitted difference.
    const spec = readFileSync(SPEC, 'utf-8')
    const icp = readFileSync(join(process.cwd(), 'docs/prompts/icp-agent.md'), 'utf-8')

    const cut = (raw: string, h: string) =>
      raw.slice(raw.indexOf(`${h} Rule 9B:`), raw.indexOf(`${h} Rule 10:`))
        .replace(/^#+ /gm, '')
        .replace(/^---$/gm, '')
        .trim()

    const fromSpec = cut(spec, '##')
    const fromIcp = cut(icp, '###')
    expect(fromSpec.length).toBeGreaterThan(1000)
    expect(fromIcp).toBe(fromSpec)
  })

  it('Rule 9B carries no em dash, because the prompt copy bans the character', () => {
    // Divergence 3: the spec still uses em dashes in older rules and the prompts may not.
    // 9B was written without one so the two copies stay byte-identical and the assertion
    // above stays a real check rather than one that has to allow for conversions.
    const icp = readFileSync(join(process.cwd(), 'docs/prompts/icp-agent.md'), 'utf-8')
    const r9b = icp.slice(icp.indexOf('### Rule 9B:'), icp.indexOf('### Rule 10:'))
    expect(r9b).not.toMatch(/[\u2014\u2013]|--/)
  })

  it('the banned list itself has not been quietly emptied', () => {
    // Guards the guard. A future edit that deletes patterns to make a failure go away
    // should fail here rather than silently weaken every test above.
    expect(BANNED.length).toBeGreaterThanOrEqual(6)
    expect(ALLOWED_PLACEHOLDERS.length).toBeLessThanOrEqual(2)
    // And the patterns must actually match the things they claim to.
    expect(scan('a consulting firm').length).toBeGreaterThan(0)
    expect(scan('schools in Ireland').length).toBeGreaterThan(0)
    expect(scan('the Department of Transport').length).toBeGreaterThan(0)
    expect(scan('ISO 9001 compliance').length).toBeGreaterThan(0)
    expect(scan('McKinsey reports').length).toBeGreaterThan(0)
    // And must not fire on ordinary category-level prose.
    expect(scan('a public body or government agency')).toEqual([])
    expect(scan('the sector the buyer operates in')).toEqual([])
  })
})
