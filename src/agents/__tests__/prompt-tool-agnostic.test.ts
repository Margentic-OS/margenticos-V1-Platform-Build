// The tool-agnosticism scan over prompt text, added 2026-08-28.
//
// SEPARATE FROM THE INDUSTRY SCAN ON PURPOSE. They are different rules with different
// fixes. An industry assumption is fixed by rewording. A vendor name is sometimes fixed by
// rewording and sometimes not: the six in the messaging prompt are merge-tag syntax and
// threading config, where the vendor name is a symptom of a real coupling to that
// provider's format. Renaming those leaves the coupling intact. One scan carrying both
// exemption regimes is how an exemption list starts growing.
//
// THIS IS HALF THE RULE, AND IT IS THE SMALLER HALF. Measured 2026-08-28: the vendor name
// "Apollo" appeared TWICE in the ICP prompt and THIRTY-THREE times in stored generated
// documents, including twice in tier_3.disqualifiers, which the client-facing
// IcpDocumentView renders. A prompt-text scan would have caught 2 and missed 33.
//
// The output-side enforcement point is the load-bearing one and is NOT built here. Its
// boundary was reported for approval first, because a gate that stops a client describing
// their own buyer is worse than the leak it prevents. See BACKLOG.

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { scanFile, type Pattern } from './prompt-scan'

const PROMPTS = ['icp', 'positioning', 'tov', 'messaging'].map(n => `docs/prompts/${n}-agent.md`)
const SPEC = 'docs/prompts/shared-voice-spec.md'
const abs = (p: string) => join(process.cwd(), p)

// Every vendor on CLAUDE.md's tool-name list, plus the ones that reach these prompts.
// A new vendor goes here in the same commit that introduces its handler, which is the
// rule that MyEmailVerifier was missing from when it reached a column default.
const VENDORS: Pattern[] = [
  { label: 'vendor name', re: /\b(Instantly|Apollo|Taplio|Lemlist|GoHighLevel|Calendly|Hunter\.io|MyEmailVerifier|Bouncer|Apify|Brave|Smartlead)\b/ },
]

// Measured 2026-08-28. These may only go DOWN.
//
// icp 0:        was 2 ("Apollo-detectable" in the output schema and in the signal
//               categories). Both replaced with "Company-data-detectable", which names the
//               KIND of source rather than the tool that finds it.
// messaging 6:  merge-tag syntax and threading configuration. NOT a naming problem: the
//               tag format IS the coupling, so the fix is the registry handler supplying
//               it, which is a code change and its own backlog item. Recorded rather than
//               reworded, because rewording would hide the coupling instead of removing it.
const BASELINE: Record<string, number> = {
  'docs/prompts/icp-agent.md': 0,
  'docs/prompts/positioning-agent.md': 0,
  'docs/prompts/tov-agent.md': 0,
  'docs/prompts/messaging-agent.md': 6,
  'docs/prompts/shared-voice-spec.md': 0,
}

describe('prompt files name no vendor', () => {
  it.each([...PROMPTS, SPEC])('%s is at or below its recorded baseline', path => {
    const hits = scanFile(abs(path), VENDORS)
    const allowed = BASELINE[path]
    expect(allowed, `${path} has no recorded baseline`).toBeTypeOf('number')
    expect(
      hits.length,
      `${path}: ${hits.length} vendor names, baseline ${allowed}. Baselines may only go down.\n  ` +
      hits.map(h => `L${h.line} «${h.match}» ${h.text}`).join('\n  '),
    ).toBeLessThanOrEqual(allowed)
  })

  it('the ICP prompt is at zero and stays there', () => {
    // Stated separately from the baseline table because this is the file the whole change
    // was about, and a baseline of 0 read from a map is easy to raise without noticing.
    expect(scanFile(abs('docs/prompts/icp-agent.md'), VENDORS)).toEqual([])
  })

  it('the three-way signal taxonomy survived the rename', () => {
    // The vendor name had to go. The distinction it sat inside is genuinely useful and
    // must not be collapsed while removing the name.
    const icp = scanFile(abs('docs/prompts/icp-agent.md'), VENDORS)
    expect(icp).toEqual([])
    const src = require('node:fs').readFileSync(abs('docs/prompts/icp-agent.md'), 'utf-8')
    expect(src).toContain('Company-data-detectable')
    expect(src).toContain('Website-detectable')
    expect(src).toContain('Web search-detectable')
  })

  it('the ICP prompt forbids naming a tool anywhere, not only in evidence_to_find', () => {
    // The prefix alone was not enough. The vendor name reached tier_3.disqualifiers in two
    // active documents, outside evidence_to_find entirely, because the model picked it up
    // as vocabulary. The rule text has to reach the whole document.
    const src = require('node:fs').readFileSync(abs('docs/prompts/icp-agent.md'), 'utf-8')
    expect(src).toContain('NAME THE KIND OF SOURCE, NEVER THE TOOL')
    expect(src).toMatch(/EVERY\s+field in the document, not only to evidence_to_find/)
  })

  it('the vendor list has not been quietly emptied, and still matches', () => {
    expect(VENDORS[0].re.source.split('|').length).toBeGreaterThanOrEqual(10)
    expect(VENDORS.some(p => p.re.test('checkable via Apollo revenue estimates'))).toBe(true)
    expect(VENDORS.some(p => p.re.test('the Instantly merge tag'))).toBe(true)
    // Must not fire on the capability phrasing that replaced the vendor name.
    expect(VENDORS.some(p => p.re.test('Company-data-detectable: headcount change'))).toBe(false)
    expect(Object.values(BASELINE).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6)
  })
})
