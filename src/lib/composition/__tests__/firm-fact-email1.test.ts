// The firm-fact tier at composition. Pure: no database, no model.
//
// ZERO MODEL CALLS (Round 3, ripple j). The SDK is mocked so that constructing a client
// records it; every branch below runs, and the record must stay empty. A static import
// check would not do: the validator imports the messaging agent module, which imports the
// SDK, so the question is whether anything CALLS it, which only running answers.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const constructed: unknown[] = []
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  class RecordingAnthropic {
    constructor(opts: unknown) {
      constructed.push(opts)
    }
  }
  return { ...actual, default: RecordingAnthropic }
})

import { decideEmail1LeadIn, decideFirmFactEmail1, decideFollowupFills, decideTemplateEmail1, signoffFromBody } from '../firm-fact-email1'
import { renderEmail1SlotFree, wordingsOf } from '@/lib/outbound-templates/template-shape'
import { FIRM_FACT_CHECKS_VERSION } from '@/lib/agents/research/firm-fact-checks'
import { INVENTED_FILL_CELLS, validateTemplateDocument } from '@/lib/outbound-templates/validate-templates'
import { buildMessagingContent } from '@/agents/outbound-template-agent'
import {
  INVENTED_OPENER_FRAMES,
  INVENTED_PEER_FRAMES,
  INVENTED_SIGNOFF,
  inventedBrief,
  inventedPeerBrief,
  inventedVariants,
} from '@/lib/outbound-templates/__tests__/fixtures/invented-client'
import type { OutboundBrief } from '@/lib/outbound-brief/brief'
import type { PeerKindRecord } from '@/lib/sourcing/peer-kind'

function content(enabled = true): Record<string, any> {
  return buildMessagingContent({
    base: {},
    brief: inventedBrief(),
    result: { opener_frames: INVENTED_OPENER_FRAMES, variants: inventedVariants() },
    signoff: INVENTED_SIGNOFF,
    firmFactTierEnabled: enabled,
  }) as Record<string, any>
}

const NOW = new Date('2026-09-30T12:00:00Z')
const FACT = {
  version: FIRM_FACT_CHECKS_VERSION,
  passed: true,
  does: 'you run dental clinics',
  for_whom: 'bakeries',
  peer_group_label: 'software makers',
  research_result_id: 'rr-9',
  source_fetched_at: '2026-09-25T00:00:00Z',
  // The verb the extraction gave for the kind. Read only when a test also sets `kind`.
  kind_verb: 'run',
}

/**
 * A stored kind always carries the quote that says it. Tests that set a kind and are not
 * about the quote get the plainest one that says it; a test that IS about the quote sets
 * kind_quote itself, null included.
 */
function withKindQuote(fact: unknown): unknown {
  if (!fact || typeof fact !== 'object') return fact
  const f = fact as { kind?: unknown; kind_quote?: unknown }
  if (typeof f.kind !== 'string' || 'kind_quote' in f) return fact
  return { ...f, kind_quote: `We are ${f.kind}.` }
}

function decide(overrides: { content?: Record<string, any>; fact?: unknown; variant?: string; prospect?: string; headcount?: number | null } = {}) {
  const c = overrides.content ?? content()
  const variant = overrides.variant ?? 'A'
  return decideFirmFactEmail1({
    messagingContent: c,
    variantId: variant,
    prospectId: overrides.prospect ?? 'prospect-1',
    firmFact: 'fact' in overrides ? withKindQuote(overrides.fact) : FACT,
    templateEmail1Body: c.variants[variant]?.emails[0].body ?? '',
    now: NOW,
    ...('headcount' in overrides ? { headcount: overrides.headcount } : {}),
  })
}

/** The pain line names its source mid-sentence (2026-10-03), in either of the fixture's wordings. */
const namesSource = (label: string) => new RegExp(`^(When we chat to ${label}, a lot of them say|Talking to ${label}, we hear that) `)

beforeEach(() => { constructed.length = 0 })

describe('decideFirmFactEmail1', () => {
  it('composes the firm-fact Email 1 from the stored fact', () => {
    const d = decide()
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    const paras = d.body.split('\n\n')
    expect(paras[0]).toBe('{{first_name}}')
    expect(paras[1]).toMatch(/you run dental clinics\.$/)
    // Either wording of the pain line, with the prospect's own peer group named as the source.
    expect(paras[2]).toMatch(namesSource('software makers'))
    expect(paras[3]).toContain('bakeries')
    // The offer opens on the lead-in's slot-free form: the firm is named later, by composition.
    expect(paras[3]).toMatch(/^If you're seeing this too, we /)
    expect(paras[paras.length - 1]).toBe('Sam\nQuillmere')
    // A subject keeps the case it was written in; it is not a sentence.
    expect(d.subject).toBe(d.detail.wording.subject === 0 ? 'bakeries abroad' : 'pages buyers abroad can read')
    expect(d.detail).toMatchObject({ fills: { does: 'you run dental clinics', for_whom: 'bakeries', peer_group: 'software makers' }, research_result_id: 'rr-9' })
    expect(d.detail.wording_counts).toEqual({ subject: 2, pain: 2, offer: 2, question: 2 })
  })

  it('ships the opener with NO for_whom, on the slot-free offer and subject (rule 9)', () => {
    const d = decide({ fact: { ...FACT, for_whom: null } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.body).toMatch(/you run dental clinics\./)
    expect(d.body).not.toContain('{for_whom}')
    expect(d.body).toMatch(/buyers abroad|your buyers/)
    expect(d.detail.slotted.offer).toBe(false)
    expect(d.detail.fills.for_whom).toBeNull()
  })

  it('falls back line by line: no peer group gives the default peer noun', () => {
    const d = decide({ fact: { ...FACT, peer_group_label: null } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.body.split('\n\n')[2]).toMatch(namesSource('exporters'))
    expect(d.detail.slotted.pain).toBe(false)
  })

  it('rotates the two wordings between prospects, and records which shipped (rule 8)', () => {
    // On a frame that shares no word with either pain wording, so what is measured here is
    // the rotation alone. Since 2026-10-02 a pain wording whose first sentence repeats a word
    // of the opener is not shipped under it (see "no word in the opener and again in the
    // sentence under it" below): a frame that says "your site" over a pain line that says
    // "the site", as this fixture's did until that day, moves every reader to the alternate.
    const c = content()
    c.opener_frames = ['Can see {does}.']
    const seen = { pain: new Set<number>(), offer: new Set<number>(), question: new Set<number>() }
    for (let i = 0; i < 40; i++) {
      const d = decide({ content: c, prospect: `prospect-${i}` })
      if (d.tier !== 'firm_fact') throw new Error('expected firm_fact')
      for (const k of ['pain', 'offer', 'question'] as const) seen[k].add(d.detail.wording[k])
    }
    expect([...seen.pain].sort()).toEqual([0, 1])
    expect([...seen.offer].sort()).toEqual([0, 1])
    expect([...seen.question].sort()).toEqual([0, 1])
  })

  it.each([
    ['the tier is off', { content: content(false) }, 'tier_off'],
    ['there is no fact', { fact: null }, 'no_fact'],
    ['the fact did not pass', { fact: { ...FACT, passed: false } }, 'fact_did_not_pass'],
    ['the variant has no lines', { content: (() => { const c = content(); delete c.variants.A.lines; return c })() }, 'variant_has_no_lines'],
    ['the lines are from an older brief', { content: (() => { const c = content(); c.outbound_brief.brief_version = 2; return c })() }, 'lines_from_an_older_brief'],
    ['there is no brief', { content: (() => { const c = content(); delete c.outbound_brief; return c })() }, 'no_brief'],
    ['there are no opener frames', { content: (() => { const c = content(); c.opener_frames = []; return c })() }, 'no_opener_frames'],
    ['the fact was judged under an older version of the checks', { fact: { ...FACT, version: FIRM_FACT_CHECKS_VERSION - 1 } }, 'fact_from_older_checks'],
    ['the source page is older than the age cap at send time', { fact: { ...FACT, source_fetched_at: '2026-06-01T00:00:00Z' } }, 'stale_source'],
    ['the source date is missing', { fact: { ...FACT, source_fetched_at: undefined } }, 'stale_source'],
  ])('ships the template when %s', (_name, overrides, reason) => {
    const d = decide(overrides as Parameters<typeof decide>[0])
    expect(d).toMatchObject({ tier: 'template', reason })
  })

  it('re-validates the REAL fill and ships the template when it breaks a rule (planted)', () => {
    // 14 words of {does}: the frame plus clause is over the 15-word sentence cap.
    const d = decide({ fact: { ...FACT, does: 'you design build and fit cold rooms and freezers for regional food wholesalers' } })
    expect(d.tier).toBe('template')
    if (d.tier !== 'template') return
    expect(d.reason).toBe('revalidation_failed')
    expect(d.violations!.join(' ')).toContain('sentence_length')
  })

  it('does not hold the sender\'s never-claims phrases against the prospect\'s own clause', () => {
    // "instant" is a never_claims phrase in the invented brief. In the prospect's {does}
    // it is their word about themselves, not a claim the sender makes.
    const d = decide({ fact: { ...FACT, does: 'you sell instant coffee to offices' } })
    expect(d.tier).toBe('firm_fact')
  })

  it('reports a brief that no longer validates as that, with the problems, not as "no brief"', () => {
    // The brief's shape moved on 2026-10-01 (lead_differentiator, avoid_wording, symptom).
    // A stored brief in the older shape read as "no_brief": tier 2 switched off for the
    // whole client and the recorded reason said there was nothing there.
    const c = content()
    delete c.outbound_brief.lead_differentiator
    const d = decide({ content: c })
    expect(d).toMatchObject({ tier: 'template', reason: 'brief_invalid' })
    expect(d.tier === 'template' && d.violations).toEqual(['lead_differentiator must be a proof point id or null'])
    // Control: a document with no brief at all is still "no_brief".
    const none = content()
    delete none.outbound_brief
    expect(decide({ content: none })).toEqual({ tier: 'template', reason: 'no_brief' })
  })

  it('re-validates the wording the prospect SHIPS, not wording 0 (planted in an alternate)', () => {
    // An unvalidated document: the alternate offer says something the brief forbids. Every
    // prospect whose offer index is 1 must fall to the template, and those on wording 0
    // must not. If the masked render stopped passing the prospect's wording, the alternate
    // would be re-validated as wording 0 and ship.
    const c = content()
    const alt = c.variants.A.lines.email1.offer.alt
    alt.text = 'We put your pages through machine translation for {for_whom}. Native speakers review the result.'
    alt.slot_free = 'We put your pages through machine translation for your buyers. Native speakers review the result.'
    const seen = { alternate: 0, first: 0 }
    for (let i = 0; i < 40; i++) {
      const d = decide({ content: c, prospect: `prospect-${i}` })
      if (d.tier === 'template') {
        seen.alternate++
        expect(d).toMatchObject({ reason: 'revalidation_failed' })
        expect(d.violations?.join(' ')).toContain('machine translation')
      } else {
        seen.first++
        expect(d.detail.wording.offer).toBe(0)
      }
    }
    // Both wordings were actually exercised, so neither branch passed vacuously.
    expect(seen.alternate).toBeGreaterThan(0)
    expect(seen.first).toBeGreaterThan(0)
  })

  it('fails closed, never throws, when an alternate wording cannot render slot-free', () => {
    // {for_whom} is optional since rule 9, so a prospect with no customer group reaches the
    // slot-free form of every line. An alternate that uses {for_whom} and has none threw out
    // of composition for the prospects who drew it.
    const c = content()
    c.variants.A.lines.email1.offer.alt.slot_free = null
    const results = Array.from({ length: 40 }, (_, i) => decide({ content: c, prospect: `prospect-${i}`, fact: { ...FACT, for_whom: null } }))
    const failed = results.filter(d => d.tier === 'template')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every(d => d.tier === 'template' && d.reason === 'render_failed')).toBe(true)
    expect(results.some(d => d.tier === 'firm_fact')).toBe(true)
  })

  it('sends the template for a stored clause that names nothing specific', () => {
    // Applied at composition too, so the rule reaches a fact stored before it existed.
    expect(decide({ fact: { ...FACT, does: 'you provide professional services for businesses' } }))
      .toEqual({ tier: 'template', reason: 'fact_not_specific' })
  })

  it('PLANTED: what names nothing is read from THIS client\'s brief, as it is today', () => {
    // The invented client writes to exporters: "export" is true of every firm on its list.
    expect(decide({ fact: { ...FACT, does: 'you provide export services for businesses' } }))
      .toEqual({ tier: 'template', reason: 'fact_not_specific' })
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a small export business' } }))
      .toEqual({ tier: 'template', reason: 'fact_not_specific' })
    // Control: with the word taken off the brief's list the same stored fact ships, with no
    // new extraction. The default label still makes "exporters" generic.
    const c = content()
    c.outbound_brief.generic_kind_words = []
    const d = decide({ content: c, fact: { ...FACT, does: null, for_whom: null, kind: 'a small export business' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('broad')
    // The label is a plural; the kind a page uses is the singular. It is the singular the
    // label has to cover, and it does, by inflection.
    expect(decide({ content: c, fact: { ...FACT, does: null, for_whom: null, kind: 'an exporter' } }))
      .toEqual({ tier: 'template', reason: 'fact_not_specific' })
  })

  it('PLANTED: a stored kind with its noun left off never opens an email, and says why', () => {
    // Reaches a fact already stored: the check runs on the stored words at composition.
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'an IT consulting' } }))
      .toEqual({ tier: 'template', reason: 'fact_kind_does_not_read' })
    // With a specific clause beside it, the specific clause ships and the kind is not used.
    const d = decide({ fact: { ...FACT, kind: 'an IT consulting' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
    // Control: the same kind with its noun is the broad line.
    const whole = decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'an IT consulting firm' } })
    expect(whole.tier === 'firm_fact' && whole.detail.rung).toBe('broad')
  })

  it('PLANTED: the broad line\'s verb is CODE\'S, from the kind and the headcount; the stored verb is not read (2026-10-03)', () => {
    // Until 2026-10-03 the verb was the extraction's, stored with the kind. It is now
    // kindVerbFor's: "you run" for a firm noun, "you are" for a person noun only when the
    // firm is one person, and no broad line at all for a person noun on any other firm.
    const kindLine = (kind: string, headcount: number | null | undefined, kind_verb: unknown = 'run') => {
      const d = decide({ fact: { ...FACT, does: null, for_whom: null, kind, kind_verb }, ...(headcount === undefined ? {} : { headcount }) })
      return d.tier === 'firm_fact' ? opener(d.body) : d
    }
    // A person noun, one person or none on the record: "you are", whatever verb was stored.
    expect(kindLine('an executive coach', 1)).toMatch(/you are an executive coach\.$/)
    expect(kindLine('an executive coach', 0, null)).toMatch(/you are an executive coach\.$/)
    // A person noun on a firm of more than one, or of unknown size: no broad line.
    for (const headcount of [2, 40, null, undefined]) {
      expect(kindLine('an executive coach', headcount, 'are'), String(headcount)).toEqual({ tier: 'template', reason: 'fact_kind_does_not_read' })
    }
    // A firm noun is "you run", whatever its size and whatever verb was stored (control).
    expect(kindLine('a dental practice', 40, 'are')).toMatch(/you run a dental practice\.$/)
    expect(kindLine('a dental practice', null, null)).toMatch(/you run a dental practice\.$/)
    // With a specific clause beside a person noun that gives no broad line, the clause ships.
    const d = decide({ fact: { ...FACT, kind: 'an executive coach' }, headcount: 12 })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
  })

  it('PLANTED: a stored kind that stops before its noun, or holds a name, never opens an email', () => {
    // The stored quote is read again at composition, with the same function extraction uses.
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a web design', kind_quote: 'We are a web design studio.' } }))
      .toEqual({ tier: 'template', reason: 'fact_kind_does_not_read' })
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a design Studio', kind_quote: 'A Design Studio.' } }))
      .toEqual({ tier: 'template', reason: 'fact_kind_does_not_read' })
    // A heading or a name says the words and not that the firm is one.
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a board search', kind_quote: 'Northtown Board Search' } }))
      .toEqual({ tier: 'template', reason: 'fact_kind_does_not_read' })
    // A stored kind with no stored quote is not read as "nothing to check".
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a web design studio', kind_quote: null } }))
      .toEqual({ tier: 'template', reason: 'fact_kind_does_not_read' })
    // Control: whole, and in lower case, the same kind is the broad line.
    const whole = decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a web design studio', kind_quote: 'We are a web design studio.' } })
    expect(whole.tier === 'firm_fact' && whole.detail.rung).toBe('broad')
  })

  it('PLANTED: a word on the idiom list in the PROSPECT\'S OWN clause does not send a paid fact to the template', () => {
    // The idiom list names figures of speech an author must not write. A prospect's own
    // clause uses the same words literally, and each of these was refused at composition
    // after the extraction had passed it and been paid for.
    for (const does of ['you provide bandwidth for rural schools', 'you breed wheat for drought']) {
      const d = decide({ fact: { ...FACT, does, for_whom: null } })
      expect(d.tier, does).toBe('firm_fact')
    }
  })

  it('PLANTED: a kind that only says how big or whose the firm is never opens an email', () => {
    for (const kind of ['a small business', 'a family firm', 'a limited company', 'a Northtown business', 'a mid-size company', 'a start-up']) {
      expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind } })).toEqual({ tier: 'template', reason: 'fact_not_specific' })
    }
  })

  it('uses the stored peer label only while the brief still holds it', () => {
    // The fact stores the label as a string from the day of extraction. A brief that has
    // since dropped or reworded it must not ship the old one: re-validation masks the slot.
    const kept = decide()
    expect(kept.tier === 'firm_fact' && kept.detail.fills.peer_group).toBe('software makers')
    const c = content()
    c.outbound_brief.peer_groups[0].label = 'software firms'
    const dropped = decide({ content: c })
    expect(dropped.tier).toBe('firm_fact')
    if (dropped.tier !== 'firm_fact') return
    expect(dropped.detail.fills.peer_group).toBeNull()
    expect(dropped.body).not.toContain('oftware makers')
    expect(dropped.body.split('\n\n')[2]).toMatch(namesSource('exporters'))
  })

  it('keeps the opener when the customer group breaks a rule: slot-free offer, group set aside (rule 9)', () => {
    // A stored group with an ampersand breaks a style rule once it sits in the offer. The
    // opener passed extraction and faithfulness; it used to be thrown away with the group.
    const d = decide({ fact: { ...FACT, for_whom: 'food & drink brands' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.fills.for_whom).toBeNull()
    expect(d.detail.slotted.offer).toBe(false)
    expect(d.detail.for_whom_dropped?.join(' ')).toContain('ampersand')
    expect(d.body).toContain('you run dental clinics')
    expect(d.body).not.toContain('drink brands')
    expect(d.subject).not.toContain('&')
    // Control: the short group in FACT ships in the offer, with nothing recorded as dropped.
    const ok = decide()
    expect(ok.tier === 'firm_fact' && ok.detail.fills.for_whom).toBe('bakeries')
    expect(ok.tier === 'firm_fact' && ok.detail.for_whom_dropped).toBeUndefined()
  })

  it('grades the OPENER CLAUSE on its own, and sends the template when it is a string of long abstract nouns', () => {
    // Note 9 of the second reading graded the whole email with the prospect's words in it.
    // Note 6 of the fourth gave the opener clause its own, higher cap: it is the prospect's
    // wording about their own trade. What that cap still refuses is word salad.
    const d = decide({ fact: { ...FACT, does: 'you provide organisational internationalisation documentation', for_whom: null } })
    expect(d.tier).toBe('template')
    if (d.tier !== 'template') return
    expect(d.reason).toBe('revalidation_failed')
    expect(d.violations!.join(' ')).toContain('opener_clause_grade')
    // Control: the plain clause in FACT passes the same check.
    expect(decide().tier).toBe('firm_fact')
  })

  it('PLANTED: a faithful clause in a trade\'s own long words ships; before note 6 it sent the email to the template', () => {
    const d = decide({ fact: { ...FACT, does: 'you provide cultural resource management and ecological surveys', for_whom: null } })
    expect(d.tier).toBe('firm_fact')
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
  })

  it('PLANTED: the filled grade still reads what the client\'s lines become with the reader\'s customer group in them', () => {
    // The opener clause is graded apart. The customer group sits in the OFFER, which the
    // client wrote, and long words there drop the group, not the opener.
    const d = decide({ fact: { ...FACT, for_whom: 'international pharmaceutical manufacturing conglomerates' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.fills.for_whom).toBeNull()
    expect(d.detail.for_whom_dropped?.join(' ')).toContain('reading_grade_filled')
  })

  // ── The fallback ladder (second reading, note 6) ──
  const HARD = 'you provide organisational internationalisation documentation'
  it('ships the BROAD line when the fact holds only the kind of firm', () => {
    const d = decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'a dental practice', rung: 'broad' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(d.body.split('\n\n')[1]).toMatch(/you run a dental practice\.$/)
    expect(d.detail.fills.for_whom).toBeNull()
    expect(d.detail.slotted.offer).toBe(false)
  })
  it('records the specific rung when the clause ships (control)', () => {
    const d = decide({ fact: { ...FACT, kind: 'a dental practice', rung: 'specific' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
    expect(d.tier === 'firm_fact' && d.body).toContain('you run dental clinics')
  })
  it('falls ONE rung, not to the template, when the specific clause breaks a rule with its real words', () => {
    const d = decide({ fact: { ...FACT, does: HARD, for_whom: null, kind: 'a dental practice', rung: 'specific' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(d.detail.specific_dropped?.join(' ')).toContain('opener_clause_grade')
    expect(d.body).not.toContain('internationalisation')
  })
  it('falls to the broad line when the stored clause names nothing', () => {
    const d = decide({ fact: { ...FACT, does: 'you provide export services', for_whom: null, kind: 'a dental practice' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('broad')
  })
  it('sends the template when every rung fails, with the first reason', () => {
    const d = decide({ fact: { ...FACT, does: HARD, for_whom: null, kind: 'an organisational internationalisation documentation consultancy' } })
    expect(d).toMatchObject({ tier: 'template', reason: 'revalidation_failed' })
    expect(decide({ fact: { ...FACT, does: null, kind: 'a firm' } })).toEqual({ tier: 'template', reason: 'fact_not_specific' })
    expect(decide({ fact: { ...FACT, does: null, kind: null } })).toEqual({ tier: 'template', reason: 'fact_did_not_pass' })
  })

  it('PLANTED: what generation certified, composition ships: the plain cells never fall on reading grade', () => {
    // Generation grades two plain cells WITH the fill in, against the longest peer label
    // (FillCell.gradeFilled). Composition grades every real email the same way. So a
    // document that passed generation must ship those same fills for every prospect, on
    // every variant and wording. Before 2026-10-01 generation graded them masked, and this
    // fixture passed generation while composition refused 79 of 100.
    // EVERY peer label, not one picked by length: a short label of long words reads harder
    // than a long label of short ones, and the first version of both the validator and this
    // test picked "the longest" by characters and missed it.
    const c = content()
    const labels = inventedBrief().peer_groups.map(p => p.label)
    expect(labels.length).toBeGreaterThan(1)
    const cells = INVENTED_FILL_CELLS.filter(cell => cell.gradeFilled)
    expect(cells.map(cell => cell.name).sort()).toEqual(['broad', 'short'])
    for (const label of labels) {
      for (const cell of cells) {
        for (const variant of ['A', 'B']) {
          for (let i = 0; i < 25; i++) {
            const fact = cell.name === 'broad'
              ? { ...FACT, does: null, for_whom: null, kind: (cell.fills.does ?? '').replace(/^you run /, ''), peer_group_label: label }
              : { ...FACT, does: cell.fills.does, for_whom: cell.fills.for_whom ?? null, peer_group_label: label }
            const d = decide({ content: c, variant, prospect: `prospect-${i}`, fact })
            expect(d.tier, `${label} / ${cell.name} / ${variant} / prospect-${i}: ${JSON.stringify(d)}`).toBe('firm_fact')
            if (d.tier !== 'firm_fact') continue
            // With its customer group, when the cell has one: nothing was dropped to make it fit.
            expect(d.detail.for_whom_dropped).toBeUndefined()
          }
        }
      }
    }
  })

  it('PLANTED: a peer label of hard words passes generation and ships: the label is masked in the filled grade (2026-10-03)', () => {
    // Until 2026-10-03 "veterinary diagnostic laboratories" failed the filled grade at generation and
    // at composition. It is the name of the reader's own trade, and every pain line names it.
    const brief = inventedBrief()
    brief.peer_groups.push({ id: 'PG3', label: 'veterinary diagnostic laboratories', industry: 'Veterinary Services', source: 'invented' })
    const violations = validateTemplateDocument({ brief, opener_frames: INVENTED_OPENER_FRAMES, variants: inventedVariants(), signoff: INVENTED_SIGNOFF })
    expect(violations.filter(v => v.rule === 'reading_grade_filled')).toEqual([])
  })

  it('picks the same opener frame for the same prospect every time', () => {
    const a = decide({ prospect: 'p-42' }), b = decide({ prospect: 'p-42' })
    expect(a.tier === 'firm_fact' && b.tier === 'firm_fact' && a.detail.frame_index === b.detail.frame_index).toBe(true)
  })

  it('makes zero model calls on every branch', () => {
    decide()
    decide({ fact: null })
    decide({ content: content(false) })
    decide({ fact: { ...FACT, does: 'you design build and fit cold rooms and freezers for regional food wholesalers' } })
    expect(constructed).toEqual([])
  })

  it('the recording mock does see a construction (control for the test above)', async () => {
    const Sdk = (await import('@anthropic-ai/sdk')).default as unknown as new (o: unknown) => unknown
    new Sdk({ apiKey: 'x' })
    expect(constructed).toHaveLength(1)
  })
})

describe('signoffFromBody', () => {
  it('reads the two sign-off lines', () => {
    expect(signoffFromBody('{{first_name}}\n\nHello.\n\nSam\nQuillmere')).toEqual({ firstName: 'Sam', companyName: 'Quillmere' })
  })
  it('refuses a body whose last paragraph is not two lines', () => {
    expect(signoffFromBody('{{first_name}}\n\nHello.\n\nSam')).toBeNull()
  })
})

describe('decideTemplateEmail1 (tier 3 wording rotation, rule 8)', () => {
  const stored = (c: Record<string, any>, v = 'A') => ({ storedBody: c.variants[v].emails[0].body, storedSubject: c.variants[v].emails[0].subject_line })

  it('rebuilds Email 1 from the lines with the prospect\'s wording, and it is one of the approved combinations', () => {
    const c = content()
    const d = decideTemplateEmail1({ messagingContent: c, variantId: 'A', prospectId: 'prospect-7', ...stored(c) })
    expect(d.rebuilt).toBe(true)
    if (!d.rebuilt) return
    const expected = renderEmail1SlotFree(c.variants.A.lines.email1, 'exporters', { firstName: 'Sam', companyName: 'Quillmere' }, d.wording)
    expect(d.body).toBe(expected.body)
    expect(d.subject).toBe(expected.subject)
    expect(d.body).not.toMatch(/\{(does|for_whom|peer_group)\}/)
  })

  it('wording 0 of every line IS the stored body (what tier 1 and the research writer read)', () => {
    const c = content()
    const zero = renderEmail1SlotFree(c.variants.A.lines.email1, 'exporters', { firstName: 'Sam', companyName: 'Quillmere' })
    expect(zero.body).toBe(c.variants.A.emails[0].body)
    expect(zero.subject).toBe(c.variants.A.emails[0].subject_line)
    expect(wordingsOf(c.variants.A.lines.email1.pain)).toHaveLength(2)
  })

  it('rotates across prospects', () => {
    const c = content()
    const bodies = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const d = decideTemplateEmail1({ messagingContent: c, variantId: 'A', prospectId: `prospect-${i}`, ...stored(c) })
      if (d.rebuilt) bodies.add(d.body)
    }
    expect(bodies.size).toBeGreaterThan(3)
  })

  it.each([
    ['the stored body no longer matches the lines', (c: Record<string, any>) => { c.variants.A.emails[0].body = c.variants.A.emails[0].body.replace('sales can stall', 'sales may stall') }, 'stored_body_differs_from_lines'],
    ['the stored subject no longer matches the lines', (c: Record<string, any>) => { c.variants.A.emails[0].subject_line = 'something else' }, 'stored_body_differs_from_lines'],
    ['the variant has no lines (written by the older agent)', (c: Record<string, any>) => { delete c.variants.A.lines }, 'variant_has_no_lines'],
    ['the lines are from an older brief', (c: Record<string, any>) => { c.outbound_brief.brief_version = 2 }, 'lines_from_an_older_brief'],
    ['there is no brief', (c: Record<string, any>) => { delete c.outbound_brief }, 'no_brief'],
  ])('ships the stored body untouched when %s', (_name, mutate, reason) => {
    const c = content()
    mutate(c)
    expect(decideTemplateEmail1({ messagingContent: c, variantId: 'A', prospectId: 'prospect-7', ...stored(c) })).toEqual({ rebuilt: false, reason })
  })

  it('ships the stored body, never throws, when an alternate wording cannot render', () => {
    const c = content()
    c.variants.A.lines.email1.offer.alt.slot_free = null
    const stored = c.variants.A.emails[0]
    const results = Array.from({ length: 40 }, (_, i) => decideTemplateEmail1({
      messagingContent: c, variantId: 'A', prospectId: `prospect-${i}`, storedBody: stored.body, storedSubject: stored.subject_line,
    }))
    expect(results.some(r => !r.rebuilt && r.reason === 'alternate_wording_does_not_render')).toBe(true)
    expect(results.some(r => r.rebuilt)).toBe(true)
  })

  it('names an invalid brief as the reason wording does not rotate', () => {
    const c = content()
    const stored = c.variants.A.emails[0]
    delete c.outbound_brief.avoid_wording
    // WITH the problems: with the tier off this is the only place an invalid brief shows,
    // and the reason alone does not say which field is wrong.
    expect(decideTemplateEmail1({ messagingContent: c, variantId: 'A', prospectId: 'p', storedBody: stored.body, storedSubject: stored.subject_line }))
      .toEqual({ rebuilt: false, reason: 'brief_invalid', problems: ['avoid_wording must be an array'] })
  })

  it('PLANTED: a brief stored before generic_kind_words existed says so by name', () => {
    const c = content()
    const stored = c.variants.A.emails[0]
    delete c.outbound_brief.generic_kind_words
    const d = decideTemplateEmail1({ messagingContent: c, variantId: 'A', prospectId: 'p', storedBody: stored.body, storedSubject: stored.subject_line })
    expect(d).toMatchObject({ rebuilt: false, reason: 'brief_invalid' })
    expect(!d.rebuilt && d.problems?.join(' ')).toContain('generic_kind_words must be an array')
  })

  it('does not depend on the firm-fact switch', () => {
    const c = content(false)
    expect(decideTemplateEmail1({ messagingContent: c, variantId: 'A', prospectId: 'prospect-7', ...stored(c) }).rebuilt).toBe(true)
  })
})


// ── The operator's fifth reading (2026-10-02) ─────────────────────────────────────────────
//
// Note 1, "build, don't check": the broadest rung of the ladder is assembled by code from
// the prospect's STORED record (industry, name, keywords) through the brief's peer kinds.
// No model reads anything for it and no judge passes it. Note 3: no word in two sentences
// in a row, where code fills both. Note 4: no unexplained acronym in the opener, and a
// service line before a slogan.
//
// These tests use the invented client's PEER document: one peer group carries a kind ("a
// software company"), and one of the two frames does not say the line was read on their site.
//
// WITH ITS PEER LABEL MOVED APART FROM ITS KIND (2026-10-03). Since the after-opener label
// was withdrawn, the pain line under "Can see you run a software company." names the
// group's own label, and the shared fixture's label, "software makers", says "software"
// again: every peer-rung prospect of that fixture fails the rung (planted below, in "the
// label under the opener"). The tests here are about the peer rung SHIPPING, so they use a
// label that shares no word with the kind.
const PEER_LABEL_APART = 'app makers'
function peerBriefApart(): OutboundBrief {
  const brief = inventedPeerBrief()
  brief.peer_groups[0].label = PEER_LABEL_APART
  return brief
}

function peerContent(options: { brief?: OutboundBrief; frames?: string[]; enabled?: boolean } = {}): Record<string, any> {
  return buildMessagingContent({
    base: {},
    brief: options.brief ?? peerBriefApart(),
    result: { opener_frames: options.frames ?? INVENTED_PEER_FRAMES, variants: inventedVariants() },
    signoff: INVENTED_SIGNOFF,
    firmFactTierEnabled: options.enabled ?? true,
  }) as Record<string, any>
}

/**
 * A stored company record that gives the peer rung both things it needs: an industry the
 * brief has a kind for, and a name holding a word the brief lists as true of every firm
 * this client writes to ("export"). Invented.
 */
const SOFTWARE_EXPORTER: PeerKindRecord = { name: 'Kessel Export', industry: 'software publishers', tags: [] }

/** For the caller that passes no company record at all, which is not the same as passing null. */
const NO_RECORD_PASSED = 'the company input left out entirely' as const

function decidePeer(overrides: {
  content?: Record<string, any>
  fact?: unknown
  prospect?: string
  company?: PeerKindRecord | null | typeof NO_RECORD_PASSED
} = {}) {
  const c = overrides.content ?? peerContent()
  const company = 'company' in overrides ? overrides.company : SOFTWARE_EXPORTER
  return decideFirmFactEmail1({
    messagingContent: c,
    variantId: 'A',
    prospectId: overrides.prospect ?? 'prospect-1',
    // NO stored fact unless the test gives one: the peer rung is what is left without it.
    firmFact: 'fact' in overrides ? withKindQuote(overrides.fact) : null,
    ...(company === NO_RECORD_PASSED ? {} : { company }),
    templateEmail1Body: c.variants.A.emails[0].body,
    now: NOW,
  })
}

const opener = (body: string) => body.split('\n\n')[1]
const painLine = (body: string) => body.split('\n\n')[2]

describe('the peer rung: the opener built from the stored record (fifth reading, note 1)', () => {
  it('PLANTED: with no stored fact the opener is "Can see you run a software company.", and the record says what it was built from', () => {
    const d = decidePeer()
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    // The frame that does not name the site: nobody read their site for this line.
    expect(opener(d.body)).toBe('Can see you run a software company.')
    expect(opener(d.body)).not.toContain('Your site says')
    expect(d.body.split('\n\n')[0]).toBe('{{first_name}}')
    expect(d.body.split('\n\n').pop()).toBe('Sam\nQuillmere')
    expect(d.detail.peer).toEqual({ peer_group_id: 'PG1', industry: 'Software Publishers', evidence: { word: 'export', found_in: 'name' } })
    expect(d.detail.fact_reason).toBe('no_fact')
    // No research result stands behind a line no model wrote.
    expect(d.detail.research_result_id).toBeNull()
    // No customer group is held for this rung: the offer and subject are their slot-free forms.
    expect(d.detail.fills.does).toBe('you run a software company')
    expect(d.detail.fills.for_whom).toBeNull()
    expect(d.detail.slotted.offer).toBe(false)
    expect(d.body).not.toMatch(/\{(does|for_whom|peer_group)\}/)
  })

  it('the same prospect and record with the client\'s switch off gets the template, with nothing said about a peer rung (control)', () => {
    expect(decidePeer({ content: peerContent({ enabled: false }) })).toEqual({ tier: 'template', reason: 'tier_off' })
  })

  it('PLANTED: no model is constructed for it', () => {
    const d = decidePeer()
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
    expect(constructed).toEqual([])
  })

  describe('the frame', () => {
    it('PLANTED: over many prospects the peer rung NEVER uses a frame that names the site, while the specific rung uses both', () => {
      const peerFrames = new Set<number>()
      const specificFrames = new Set<number>()
      for (let i = 0; i < 40; i++) {
        const peer = decidePeer({ prospect: `prospect-${i}` })
        const specific = decidePeer({ prospect: `prospect-${i}`, fact: FACT })
        if (peer.tier !== 'firm_fact' || specific.tier !== 'firm_fact') throw new Error(`prospect-${i}: expected firm_fact twice, got ${JSON.stringify([peer, specific])}`)
        expect(peer.detail.rung).toBe('peer')
        expect(specific.detail.rung).toBe('specific')
        expect(opener(peer.body), `prospect-${i}`).toBe('Can see you run a software company.')
        peerFrames.add(peer.detail.frame_index)
        specificFrames.add(specific.detail.frame_index)
      }
      expect([...peerFrames]).toEqual([1])
      // Control: the same forty prospects ARE spread over both frames when the line came
      // from their site, so the peer rung's one frame is a choice and not the only outcome.
      expect([...specificFrames].sort()).toEqual([0, 1])
      expect(INVENTED_PEER_FRAMES[0]).toContain('site')
      expect(INVENTED_PEER_FRAMES[1]).not.toContain('site')
    })

    it('PLANTED: the frame is chosen by what it SAYS, not by where it stands in the list', () => {
      // The same two frames the other way round: the site-free one is now index 0.
      const c = peerContent({ frames: [...INVENTED_PEER_FRAMES].reverse() })
      for (let i = 0; i < 40; i++) {
        const d = decidePeer({ content: c, prospect: `prospect-${i}` })
        if (d.tier !== 'firm_fact') throw new Error(`prospect-${i}: ${JSON.stringify(d)}`)
        expect(d.detail.frame_index).toBe(0)
        expect(opener(d.body)).toBe('Can see you run a software company.')
      }
    })

    it('PLANTED: a document with no frame that leaves the site out has no peer rung, and says so', () => {
      // Both of the shared fixture's frames say "your site". A line built from a stored
      // record under "Your site says" would claim a reading nobody did.
      expect(INVENTED_OPENER_FRAMES.every(frame => /site/.test(frame))).toBe(true)
      expect(decidePeer({ content: peerContent({ frames: INVENTED_OPENER_FRAMES }) }))
        .toEqual({ tier: 'template', reason: 'no_fact', peer_reason: 'no_frame_without_the_site' })
      // Control: the same brief and record with one site-free frame ships the peer rung.
      const d = decidePeer()
      expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
    })
  })

  describe('every reason the stored fact gives none of its rungs now falls to the peer rung, not the template', () => {
    const FACTS_WITH_NO_RUNG: Array<[string, unknown, string]> = [
      ['a fact judged under an older version of the checks', { ...FACT, version: 1 }, 'fact_from_older_checks'],
      ['a fact that did not pass', { ...FACT, passed: false }, 'fact_did_not_pass'],
      ['a clause that names nothing specific', { ...FACT, does: 'you provide professional services for businesses' }, 'fact_not_specific'],
      // A kind with its noun left off, holding one of the client's own words AND the word
      // before the brief kind's head ("software"): a stored kind missing either is a veto on
      // this rung since 2026-10-02 (see "the stored fact is a VETO" below). "an IT
      // consulting" was the first until round one, "an export consulting" the second until
      // round two, "a software export consulting" the third until the veto read other trades'
      // words (merge review).
      ['a kind with its noun left off', { ...FACT, does: null, for_whom: null, kind: 'a software exporting' }, 'fact_kind_does_not_read'],
      ['a page older than the age cap at send time', { ...FACT, source_fetched_at: '2026-06-01T00:00:00Z' }, 'stale_source'],
    ]

    it.each(FACTS_WITH_NO_RUNG)('PLANTED: %s ships the peer rung, and the record says which reason it was', (_what, fact, reason) => {
      const d = decidePeer({ fact })
      expect(d.tier).toBe('firm_fact')
      if (d.tier !== 'firm_fact') return
      expect(d.detail.rung).toBe('peer')
      expect(d.detail.fact_reason).toBe(reason)
      expect(opener(d.body)).toBe('Can see you run a software company.')
      // The stored fact's research result is not this line's: nothing of the fact shipped.
      expect(d.detail.research_result_id).toBeNull()
      expect(d.body).not.toContain('dental')
      expect(d.body).not.toContain('bakeries')
    })

    it.each(FACTS_WITH_NO_RUNG)('%s with NO company record passed still ships the template, for that reason (control)', (_what, fact, reason) => {
      expect(decidePeer({ fact, company: NO_RECORD_PASSED })).toEqual({ tier: 'template', reason })
    })
  })

  describe('the peer rung is the LAST rung: a stored fact that passes still wins', () => {
    const HARD_CLAUSE = 'you provide organisational internationalisation documentation'

    it('a passing fact ships its specific clause, and nothing about a peer rung is recorded (control)', () => {
      const d = decidePeer({ fact: FACT })
      expect(d.tier).toBe('firm_fact')
      if (d.tier !== 'firm_fact') return
      expect(d.detail.rung).toBe('specific')
      expect(d.body).toContain('you run dental clinics.')
      expect(d.body).not.toContain('a software company')
      expect(d.detail.research_result_id).toBe('rr-9')
      expect(d.detail.peer).toBeUndefined()
      expect(d.detail.fact_reason).toBeUndefined()
    })

    it('a fact holding only the kind of firm ships the broad line from their site, not the peer line (control)', () => {
      const d = decidePeer({ fact: { ...FACT, does: null, for_whom: null, kind: 'a dental practice' } })
      expect(d.tier === 'firm_fact' && d.detail.rung).toBe('broad')
      expect(d.tier === 'firm_fact' && d.body).toContain('you run a dental practice.')
    })

    it('PLANTED: when the specific clause breaks a rule with its real words and there is no kind, the peer rung ships and the record keeps why', () => {
      const d = decidePeer({ fact: { ...FACT, does: HARD_CLAUSE, for_whom: null } })
      expect(d.tier).toBe('firm_fact')
      if (d.tier !== 'firm_fact') return
      expect(d.detail.rung).toBe('peer')
      expect(opener(d.body)).toBe('Can see you run a software company.')
      expect(d.body).not.toContain('internationalisation')
      expect(d.detail.specific_dropped?.join(' ')).toContain('opener_clause_grade')
      // The fact itself gave a rung, so the reason is the rung's failure.
      expect(d.detail.fact_reason).toBe('revalidation_failed')
      expect(d.detail.research_result_id).toBeNull()
    })

    it('the same hard clause with NO company record passed ships the template, as it always did (control)', () => {
      const d = decidePeer({ fact: { ...FACT, does: HARD_CLAUSE, for_whom: null }, company: NO_RECORD_PASSED })
      expect(d).toMatchObject({ tier: 'template', reason: 'revalidation_failed' })
      expect(d.tier === 'template' && d.violations?.join(' ')).toContain('opener_clause_grade')
      expect('peer_reason' in d).toBe(false)
    })

    it('PLANTED: the same hard clause WITH a kind falls one rung to the broad line, not two to the peer line', () => {
      const d = decidePeer({ fact: { ...FACT, does: HARD_CLAUSE, for_whom: null, kind: 'a dental practice' } })
      expect(d.tier === 'firm_fact' && d.detail.rung).toBe('broad')
      expect(d.tier === 'firm_fact' && d.detail.specific_dropped?.join(' ')).toContain('opener_clause_grade')
      expect(d.tier === 'firm_fact' && d.detail.peer).toBeUndefined()
    })
  })

  describe('why there is no peer rung is recorded, and only when one was asked for', () => {
    it('PLANTED: no company record passed at all: no peer rung and NO peer_reason key, exactly the old shape', () => {
      const d = decidePeer({ company: NO_RECORD_PASSED })
      expect(d).toEqual({ tier: 'template', reason: 'no_fact' })
      expect('peer_reason' in d).toBe(false)
    })

    it('PLANTED: a record passed as null is a prospect with nothing stored: peer_reason no_record', () => {
      expect(decidePeer({ company: null })).toEqual({ tier: 'template', reason: 'no_fact', peer_reason: 'no_record' })
    })

    it.each<[string, PeerKindRecord, string]>([
      ['the stored industry is not one the static lookup knows', { ...SOFTWARE_EXPORTER, industry: 'underwater basket weaving' }, 'industry_not_in_static_table'],
      ['neither the name nor a keyword says it is this kind of firm', { ...SOFTWARE_EXPORTER, name: 'Kessel Labs' }, 'kind_not_evidenced'],
      ['no industry is stored', { ...SOFTWARE_EXPORTER, industry: null }, 'no_stored_industry'],
      ['the stored industry is blank', { ...SOFTWARE_EXPORTER, industry: '   ' }, 'no_stored_industry'],
      ['the brief holds no kind for the industry', { ...SOFTWARE_EXPORTER, industry: 'Management Consulting' }, 'no_kind_for_industry'],
    ])('PLANTED: %s: the template ships and peer_reason says so', (_why, company, peerReason) => {
      expect(decidePeer({ company })).toEqual({ tier: 'template', reason: 'no_fact', peer_reason: peerReason })
    })

    it('the sound record beside them ships the peer rung (control)', () => {
      const d = decidePeer({ company: SOFTWARE_EXPORTER })
      expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
    })

    it('PLANTED: the fact\'s reason and the peer rung\'s reason travel together, each in its own field', () => {
      const unevidenced = { ...SOFTWARE_EXPORTER, name: 'Kessel Labs' }
      expect(decidePeer({ fact: { ...FACT, source_fetched_at: '2026-06-01T00:00:00Z' }, company: unevidenced }))
        .toEqual({ tier: 'template', reason: 'stale_source', peer_reason: 'kind_not_evidenced' })
      // And when a rung from the fact was tried and failed, its violations are kept beside it.
      const d = decidePeer({ fact: { ...FACT, does: 'you provide organisational internationalisation documentation', for_whom: null }, company: unevidenced })
      expect(d).toMatchObject({ tier: 'template', reason: 'revalidation_failed', peer_reason: 'kind_not_evidenced' })
      expect(d.tier === 'template' && d.violations?.join(' ')).toContain('opener_clause_grade')
    })

    it('PLANTED: the evidence may come from a keyword on the record when the name does not hold it', () => {
      const d = decidePeer({ company: { name: 'Kessel Labs', industry: 'software publishers', tags: ['cloud', 'food exporter'] } })
      expect(d.tier === 'firm_fact' && d.detail.peer).toEqual({ peer_group_id: 'PG1', industry: 'Software Publishers', evidence: { word: 'exporter', found_in: 'tag' } })
      // A keyword that only HOLDS the word, and is about something else, is not evidence
      // (peer-kind.ts, tightened 2026-10-02): until then "export tools" passed here.
      expect(decidePeer({ company: { name: 'Kessel Labs', industry: 'software publishers', tags: ['cloud', 'export tools', 'tools for exporters'] } }))
        .toEqual({ tier: 'template', reason: 'no_fact', peer_reason: 'kind_not_evidenced' })
    })
  })
})

describe('the label under the opener: the group\'s own label, named (2026-10-03; was fifth reading, note 3)', () => {
  // Until 2026-10-03 a label that repeated the opener was REPLACED: by the brief's after-opener
  // label ("Firms like yours") or by the default label. The operator withdrew the stand-in: the
  // pain line names the reader's own group mid-sentence. What remains of note 3 is
  // findConsecutiveRepeats on the opener and the sentence under it: a word they truly share
  // makes the rung try the other pain wording, and then fail.

  it('PLANTED: on the peer rung the pain line names the group\'s OWN label as its source, and nothing is recorded as replaced', () => {
    const d = decidePeer()
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(painLine(d.body)).toMatch(namesSource(PEER_LABEL_APART))
    expect(d.body).not.toContain('Firms like yours')
    expect(d.detail.fills.peer_group).toBe(PEER_LABEL_APART)
    expect('peer_label_replaced' in d.detail).toBe(false)
  })

  it('PLANTED: the shared peer fixture, "software makers" under "you run a software company", ships the peer rung: the label echoing the opener is the point (2026-10-03)', () => {
    // Until 2026-10-03 the shared word "software" failed the rung. The operator asked for the
    // reader's own group named under the opener, so on a rung that names their kind the
    // label's own words are not a repeat.
    const d = decidePeer({ content: peerContent({ brief: inventedPeerBrief() }) })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(painLine(d.body)).toMatch(namesSource('software makers'))
    // The same record under the label apart ships too (control).
    expect(decidePeer().tier).toBe('firm_fact')
  })

  it('PLANTED: a peer label of hard words ships at COMPOSITION: the filled grade masks the label, as the generator\'s validator does (2026-10-03)', () => {
    // "veterinary diagnostic laboratories" put the filled grade over 5 in the pain line, so every
    // prospect of that group got the template, whatever the writer had written.
    const brief = peerBriefApart()
    brief.peer_groups[0].label = 'veterinary diagnostic laboratories'
    const d = decidePeer({ content: peerContent({ brief }) })
    expect(d.tier, JSON.stringify(d)).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(painLine(d.body)).toMatch(namesSource('veterinary diagnostic laboratories'))
  })

  it('an after_opener label an older brief still carries is ignored: the group\'s own label stands', () => {
    const brief = peerBriefApart()
    brief.peer_group_default.after_opener = 'Firms like yours'
    const d = decidePeer({ content: peerContent({ brief }) })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(painLine(d.body)).toMatch(namesSource(PEER_LABEL_APART))
  })

  it('a brief with a kind and no after_opener label is valid at composition: no brief_invalid (control)', () => {
    // Until 2026-10-03 such a brief no longer validated and the template shipped, saying so.
    expect(inventedPeerBrief().peer_group_default.after_opener).toBeUndefined()
    expect(decidePeer({ content: peerContent({ brief: inventedPeerBrief() }) })).not.toMatchObject({ reason: 'brief_invalid' })
  })

  it('PLANTED: on the specific rung, a clause that shares a word with the STORED label fails that rung; no stand-in takes the label\'s place', () => {
    // "you build software for dental clinics" then "When we chat to software makers, ...".
    const d = decide({ fact: { ...FACT, does: 'you build software for dental clinics', for_whom: null } })
    expect(d).toMatchObject({ tier: 'template', reason: 'opener_repeats_next_sentence' })
    expect(d.tier === 'template' && d.violations).toEqual([expect.stringContaining('"software"')])
    // With a kind beside it the ladder moves to the broad line, which keeps the label (control).
    const broad = decide({ fact: { ...FACT, does: 'you build software for dental clinics', for_whom: null, kind: 'a dental practice' } })
    expect(broad.tier === 'firm_fact' && broad.detail.rung).toBe('broad')
    expect(broad.tier === 'firm_fact' && painLine(broad.body)).toMatch(namesSource('software makers'))
    expect(broad.tier === 'firm_fact' && broad.detail.specific_dropped?.join(' ')).toContain('opener_repeats_next_sentence')
  })

  it('PLANTED: on the specific rung, a clause that shares a word with the DEFAULT label fails that rung too', () => {
    // No stored peer group, so the source named is the default label, "exporters".
    const d = decide({ fact: { ...FACT, does: 'you ship cold rooms for exporters', for_whom: null, peer_group_label: null } })
    expect(d).toMatchObject({ tier: 'template', reason: 'opener_repeats_next_sentence' })
    expect(d.tier === 'template' && d.violations).toEqual([expect.stringContaining('"exporters"')])
  })

  it('a clause that shares no word keeps the stored label, or the default one when none is stored (control)', () => {
    const stored = decide({ fact: { ...FACT, for_whom: null } })
    expect(stored.tier).toBe('firm_fact')
    if (stored.tier !== 'firm_fact') return
    expect(painLine(stored.body)).toMatch(namesSource('software makers'))
    expect(stored.detail.fills.peer_group).toBe('software makers')
    expect('peer_label_replaced' in stored.detail).toBe(false)

    const byDefault = decide({ fact: { ...FACT, for_whom: null, peer_group_label: null } })
    expect(byDefault.tier).toBe('firm_fact')
    if (byDefault.tier !== 'firm_fact') return
    expect(painLine(byDefault.body)).toMatch(namesSource('exporters'))
    expect(byDefault.detail.fills.peer_group).toBeNull()
    expect('peer_label_replaced' in byDefault.detail).toBe(false)
  })
})

describe('a service line before a slogan (fifth reading, note 4)', () => {
  const WITH_BOTH = { ...FACT, kind: 'a dental practice' }

  it('PLANTED: a stored fact marked "tagline" that holds a clause and a kind composes on the BROAD rung', () => {
    // The clause came from a slogan. The page's own statement of what kind of firm it is
    // goes first, and the slogan's clause is kept for when there is nothing else.
    const d = decide({ fact: { ...WITH_BOTH, section: 'tagline' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(opener(d.body)).toMatch(/you run a dental practice\.$/)
    expect(d.body).not.toContain('dental clinics')
    // Nothing was tried and dropped to get here: the kind was simply first.
    expect(d.detail.specific_dropped).toBeUndefined()
  })

  it.each(['service', 'niche', 'body', 'title', undefined])('the same fact with section %s composes on the SPECIFIC rung (control)', section => {
    const d = decide({ fact: { ...WITH_BOTH, section } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
    expect(d.tier === 'firm_fact' && opener(d.body)).toMatch(/you run dental clinics\.$/)
  })

  it('PLANTED: a tagline clause is still used when the fact holds no kind: it is last, not refused', () => {
    const d = decide({ fact: { ...FACT, section: 'tagline' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
    expect(d.tier === 'firm_fact' && opener(d.body)).toMatch(/you run dental clinics\.$/)
  })

  it('PLANTED: last means below the peer rung too: with a sound company record the kind built from it goes first', () => {
    // What their record says they run is plainer than what their slogan hopes for.
    const d = decidePeer({ fact: { ...FACT, section: 'tagline' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(opener(d.body)).toBe('Can see you run a software company.')
    expect(d.body).not.toContain('dental clinics')
    // Control: the same record and the same clause from a service line ships the clause.
    const service = decidePeer({ fact: { ...FACT, section: 'service' } })
    expect(service.tier === 'firm_fact' && service.detail.rung).toBe('specific')
  })

  it('the same tagline clause with a record that gives no peer rung still ships: their own words beat the template (control)', () => {
    const d = decidePeer({ fact: { ...FACT, section: 'tagline' }, company: { ...SOFTWARE_EXPORTER, name: 'Kessel Labs' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
    expect(d.tier === 'firm_fact' && opener(d.body)).toMatch(/you run dental clinics\.$/)
    expect(d.tier === 'firm_fact' && d.detail.research_result_id).toBe('rr-9')
  })
})

describe('an acronym in a STORED clause is caught at composition (fifth reading, note 4)', () => {
  // The same clause twice, one word apart: HCM is not on the known list, HR is.
  const UNEXPLAINED = 'you provide HCM support for dental clinics'
  const KNOWN = 'you provide HR support for dental clinics'

  it('PLANTED: the clause is skipped and the kind of firm ships in its place', () => {
    const d = decide({ fact: { ...FACT, does: UNEXPLAINED, for_whom: null, kind: 'a dental practice' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(d.body).not.toContain('HCM')
    // SKIPPED, not tried and failed: the clause never reached the opener at all.
    expect(d.detail.specific_dropped).toBeUndefined()
  })

  it('PLANTED: with no kind either, the peer rung ships', () => {
    const d = decidePeer({ fact: { ...FACT, does: UNEXPLAINED, for_whom: null } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(d.body).not.toContain('HCM')
    // The reason names the fault: the clause is specific, and what is wrong is the acronym.
    expect(d.detail.fact_reason).toBe('fact_holds_an_acronym')
    expect(d.detail.specific_dropped).toBeUndefined()
  })

  it('PLANTED: with no kind and no company record, the template ships', () => {
    expect(decide({ fact: { ...FACT, does: UNEXPLAINED, for_whom: null } })).toEqual({ tier: 'template', reason: 'fact_holds_an_acronym' })
  })

  it('the same clause with a known acronym in its place ships on the specific rung (control)', () => {
    for (const fact of [{ ...FACT, does: KNOWN, for_whom: null }, { ...FACT, does: KNOWN, for_whom: null, kind: 'a dental practice' }]) {
      const d = decide({ fact })
      expect(d.tier === 'firm_fact' && d.detail.rung).toBe('specific')
      expect(d.tier === 'firm_fact' && opener(d.body)).toMatch(/you provide HR support for dental clinics\.$/)
    }
  })

  it('PLANTED: a stored KIND holding an unexplained acronym is skipped too; a known one is the broad line (control)', () => {
    expect(decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'an HCM consultancy' } }))
      .toEqual({ tier: 'template', reason: 'fact_holds_an_acronym' })
    const known = decide({ fact: { ...FACT, does: null, for_whom: null, kind: 'an HR consultancy' } })
    expect(known.tier === 'firm_fact' && known.detail.rung).toBe('broad')
    expect(known.tier === 'firm_fact' && opener(known.body)).toMatch(/you run an HR consultancy\.$/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The review of 2026-10-02: the stored fact as a veto, the two reasons kept apart, and the
// operator's rule 3 held on the email as it is sent.
//
// A SECOND INVENTED CLIENT for the veto, one who writes to consultancies: the fault needs a
// kind of firm that a coarse industry and a name can get wrong ("human resources" is a
// recruiter as readily as an HR consultancy).

function consultingPeerBrief(): OutboundBrief {
  const brief = inventedPeerBrief()
  brief.generic_kind_words = ['consulting', 'consultancy', 'consultant', 'consultants', 'advisory', 'adviser', 'advisor']
  brief.peer_groups = [
    { id: 'PG1', label: 'IT consultants', industry: 'Information Technology Consulting', kind: 'an IT consultancy', source: 'invented' },
    { id: 'PG2', label: 'HR consultants', industry: 'Human Resources Consulting', kind: 'an HR consultancy', source: 'invented' },
  ]
  return brief
}

/** A record the peer rung accepts by its NAME, and which is in truth a recruiter. Invented. */
const RECRUITER_BY_NAME: PeerKindRecord = { name: 'Northtown Recruitment Consultants', industry: 'human resources', tags: [] }

function decideConsulting(overrides: { fact?: unknown; company?: PeerKindRecord; headcount?: number | null } = {}) {
  const c = peerContent({ brief: consultingPeerBrief() })
  return decideFirmFactEmail1({
    messagingContent: c,
    variantId: 'A',
    prospectId: 'prospect-1',
    firmFact: 'fact' in overrides ? withKindQuote(overrides.fact) : null,
    company: overrides.company ?? RECRUITER_BY_NAME,
    templateEmail1Body: c.variants.A.emails[0].body,
    now: NOW,
    ...('headcount' in overrides ? { headcount: overrides.headcount } : {}),
  })
}

describe('the stored fact is a VETO on the line built from the record (review of 2026-10-02)', () => {
  it('the consulting brief is one the validator accepts, and with NO stored fact the record ships "you run an HR consultancy" (control)', () => {
    expect(peerContent({ brief: consultingPeerBrief() }).outbound_brief).toBeDefined()
    const d = decideConsulting()
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(opener(d.body)).toBe('Can see you run an HR consultancy.')
    expect(d.detail.fact_reason).toBe('no_fact')
  })

  // Every one of these shipped "Can see you run an HR consultancy." while the row itself held
  // their own site's words for another kind of firm. Whatever the fact's version, age or
  // pass state: it is not trusted to OPEN an email, and it is trusted to stop one.
  it.each<[string, unknown, string]>([
    ['a kind holding an acronym a reader may not know', { ...FACT, does: null, for_whom: null, kind: 'an HCM software company' }, 'fact_holds_an_acronym'],
    ['a kind on a page older than the age cap', { ...FACT, does: null, for_whom: null, kind: 'a payroll software company', source_fetched_at: '2026-06-01T00:00:00Z' }, 'stale_source'],
    ['a kind judged under an older version of the checks', { ...FACT, version: 1, does: null, for_whom: null, kind: 'a recruitment agency' }, 'fact_from_older_checks'],
    ['a kind on a fact that did not pass', { ...FACT, passed: false, does: null, for_whom: null, kind: 'a recruitment agency' }, 'fact_did_not_pass'],
    // A kind that failed its own checks is not in `kind`: the record keeps it in check_reasons.
    ['a kind the checks DROPPED, kept only in check_reasons', { ...FACT, passed: false, does: null, for_whom: null, kind: null, check_reasons: ['[you place staff] does: names nothing', 'kind dropped [a recruitment agency]: judge: not faithful'] }, 'fact_did_not_pass'],
    ['a dropped kind beside a clause that names nothing', { ...FACT, does: 'you provide professional services for businesses', for_whom: null, check_reasons: ['kind dropped [a staffing agency]: holds a preposition'] }, 'fact_not_specific'],
  ])('PLANTED: %s that names another kind of firm stops the peer rung, and the template ships', (_what, fact, reason) => {
    expect(decideConsulting({ fact })).toEqual({ tier: 'template', reason, peer_reason: 'stored_fact_names_another_kind' })
  })

  it.each<[string, unknown, string]>([
    ['a stale kind that holds one of the evidence words', { ...FACT, does: null, for_whom: null, kind: 'an HR consultancy', source_fetched_at: '2026-06-01T00:00:00Z' }, 'stale_source'],
    ['a kind from older checks that holds one in another form and shares "HR"', { ...FACT, version: 1, does: null, for_whom: null, kind: 'an HR consulting firm' }, 'fact_from_older_checks'],
    ['a DROPPED kind that holds one', { ...FACT, passed: false, does: null, for_whom: null, kind: null, check_reasons: ['kind dropped [an HR advisory]: ends on a word for the work'] }, 'fact_did_not_pass'],
    ['a fact with no kind at all, stored or dropped', { ...FACT, passed: false, does: null, for_whom: null, check_reasons: ['[you place staff] does: names nothing'] }, 'fact_did_not_pass'],
  ])('%s does not: the peer rung ships (control)', (_what, fact, reason) => {
    const d = decideConsulting({ fact })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(d.detail.fact_reason).toBe(reason)
  })

  // ROUND TWO (review of 2026-10-02). A kind of ANOTHER trade that holds an evidence word
  // passed the veto: the recruiter called "... Recruitment Consultants" is the header's own
  // example, and its site most likely calls it "a recruitment consultancy". A stored kind now
  // also stops the line when it shares none of the words that stand before the brief kind's
  // head noun ("HR" in "an HR consultancy"). And a stored clause that IS a kind ("you run a
  // recruitment agency", from checks that had no kind field) is read as one.
  it.each<[string, unknown, string, number?]>([
    ['a stale kind of another trade holding an evidence word', { ...FACT, does: null, for_whom: null, kind: 'a recruitment consultancy', source_fetched_at: '2026-06-01T00:00:00Z' }, 'stale_source'],
    ['a dropped kind of another trade, under another acronym', { ...FACT, passed: false, does: null, for_whom: null, kind: null, check_reasons: ['kind dropped [an IT consultancy]: judge: not faithful'] }, 'fact_did_not_pass'],
    ['a kind from older checks of another trade, "advisory"', { ...FACT, version: 1, does: null, for_whom: null, kind: 'a financial advisory firm' }, 'fact_from_older_checks'],
    ['a kind from older checks of another trade, "adviser"', { ...FACT, version: 1, does: null, for_whom: null, kind: 'an employee benefits adviser' }, 'fact_from_older_checks'],
    // A person noun: since 2026-10-03 "you are a ..." is code's verb only for a firm of one,
    // so the record says one person here, and the fact reaches its stale check as it did.
    ['a stale kind with the evidence word joined to another trade', { ...FACT, does: null, for_whom: null, kind: 'a consulting-led recruiter', source_fetched_at: '2026-06-01T00:00:00Z' }, 'stale_source', 1],
    ['a kind from older checks that holds an evidence word and not "HR"', { ...FACT, version: 1, does: null, for_whom: null, kind: 'a people consulting firm' }, 'fact_from_older_checks'],
    // The facts fixer now records a kind the judge gave no verdict on, in this form.
    ['a kind the judge gave no verdict on', { ...FACT, passed: false, does: null, for_whom: null, kind: null, check_reasons: ['kind dropped [a recruitment consultancy]: judge gave no verdict'] }, 'fact_did_not_pass'],
    ['a stored clause "you run a/an X" from checks with no kind field', { ...FACT, version: 1, does: 'you run a recruitment agency', for_whom: null }, 'fact_from_older_checks'],
    ['a stored clause "you are a/an X"', { ...FACT, version: 1, does: 'You are a recruitment consultancy.', for_whom: null }, 'fact_from_older_checks'],
  ])('PLANTED: %s stops the peer rung, and the template ships', (_what, fact, reason, headcount) => {
    expect(decideConsulting({ fact, ...(headcount === undefined ? {} : { headcount }) })).toEqual({ tier: 'template', reason, peer_reason: 'stored_fact_names_another_kind' })
  })

  it.each<[string, unknown, string]>([
    ['a stored clause "you run an X" naming the same trade', { ...FACT, version: 1, does: 'you run an HR consulting firm', for_whom: null }, 'fact_from_older_checks'],
    ['a stored clause that is not "you run/are a X"', { ...FACT, version: 1, does: 'you help recruitment agencies hire', for_whom: null }, 'fact_from_older_checks'],
    ['a dropped kind with "HR" and an evidence word', { ...FACT, passed: false, does: null, for_whom: null, kind: null, check_reasons: ['kind dropped [a boutique HR consultancy]: judge gave no verdict'] }, 'fact_did_not_pass'],
  ])('%s does not stop it (control)', (_what, fact, reason) => {
    const d = decideConsulting({ fact })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
    expect(d.tier === 'firm_fact' && d.detail.fact_reason).toBe(reason)
  })

  it('PLANTED: under "a management consultancy" a stored "an organisational consultant" stops the line; "a management consulting firm" does not (control)', () => {
    const brief = consultingPeerBrief()
    // A label apart from the kind: "management consultants" under "you run a management
    // consultancy" fails the peer rung on "management" since 2026-10-03, which is not what
    // this test is about.
    brief.peer_groups[1] = { ...brief.peer_groups[1], label: 'strategy consultants', kind: 'a management consultancy' }
    const c = peerContent({ brief })
    const run = (fact: unknown) => decideFirmFactEmail1({
      messagingContent: c, variantId: 'A', prospectId: 'prospect-1', firmFact: withKindQuote(fact),
      company: RECRUITER_BY_NAME, templateEmail1Body: c.variants.A.emails[0].body, now: NOW,
    })
    expect(run({ ...FACT, version: 1, does: null, for_whom: null, kind: 'an organisational consultant' }))
      .toEqual({ tier: 'template', reason: 'fact_from_older_checks', peer_reason: 'stored_fact_names_another_kind' })
    const agrees = run({ ...FACT, version: 1, does: null, for_whom: null, kind: 'a management consulting firm' })
    expect(agrees.tier === 'firm_fact' && opener(agrees.body)).toBe('Can see you run a management consultancy.')
  })

  it('PLANTED: the brief\'s own kind is matched in any case and as a plural, so it agrees and does not stop the line', () => {
    // The invented exporter client's kind holds no evidence word: only the same-kind rule keeps it.
    const d = decidePeer({ fact: { ...FACT, version: 1, does: null, for_whom: null, kind: 'Software Companies' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
    // Another kind of firm with no evidence word beside it still stops it (control).
    expect(decidePeer({ fact: { ...FACT, version: 1, does: null, for_whom: null, kind: 'a software studio' } }))
      .toEqual({ tier: 'template', reason: 'fact_from_older_checks', peer_reason: 'stored_fact_names_another_kind' })
  })

  it('PLANTED: only the stored KIND is a veto. A stored clause says what the firm does for others, not what kind of firm it is', () => {
    // "you help manufacturers cut energy costs" holds none of the evidence words, and says
    // nothing against "an HR consultancy" or for it. From a tagline, so it sits below the peer rung.
    const d = decideConsulting({ fact: { ...FACT, section: 'tagline', does: 'you help manufacturers cut energy costs', for_whom: null } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(d.detail.fact_reason).toBe('only_a_slogan_clause')
    // And a stale clause with no kind (control): still the peer rung.
    const stale = decideConsulting({ fact: { ...FACT, does: 'you help manufacturers cut energy costs', for_whom: null, source_fetched_at: '2026-06-01T00:00:00Z' } })
    expect(stale.tier === 'firm_fact' && stale.detail.rung).toBe('peer')
  })

  it('PLANTED: a stored kind that IS the brief\'s own kind for this record is not "another kind", whatever the evidence words are', () => {
    // The invented exporter client: its evidence words are "export" and its forms, and the
    // kind is "a software company". A site that says "a software company" agrees with the
    // record. Stale, so the site's own line cannot ship and the peer rung is what is left.
    const d = decidePeer({ fact: { ...FACT, does: null, for_whom: null, kind: 'a software company', source_fetched_at: '2026-06-01T00:00:00Z' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
    // The same stale fact naming another kind is a veto (planted beside it).
    expect(decidePeer({ fact: { ...FACT, does: null, for_whom: null, kind: 'a dental practice', source_fetched_at: '2026-06-01T00:00:00Z' } }))
      .toEqual({ tier: 'template', reason: 'stale_source', peer_reason: 'stored_fact_names_another_kind' })
  })

  it('a fact whose own kind PASSES still ships it from their site: the veto only ever removes the rung below (control)', () => {
    const d = decideConsulting({ fact: { ...FACT, does: null, for_whom: null, kind: 'a payroll software company' } })
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('broad')
    expect(d.tier === 'firm_fact' && d.body).toContain('you run a payroll software company.')
  })

  it('with no company record passed nothing about a peer rung is said, veto included (control)', () => {
    const c = peerContent({ brief: consultingPeerBrief() })
    const d = decideFirmFactEmail1({
      messagingContent: c, variantId: 'A', prospectId: 'prospect-1',
      firmFact: withKindQuote({ ...FACT, version: 1, does: null, for_whom: null, kind: 'a recruitment agency' }),
      templateEmail1Body: c.variants.A.emails[0].body, now: NOW,
    })
    expect(d).toEqual({ tier: 'template', reason: 'fact_from_older_checks' })
  })
})

describe('the fact\'s reason and the peer rung\'s reason are kept apart (review of 2026-10-02)', () => {
  // A kind the brief validator accepts and composition refuses with its real words in the
  // opener: the same string of long nouns the specific rung is refused for above.
  const HARD_KIND = 'an independent telecommunications infrastructure consultancy'
  const HARD_CLAUSE = 'you provide organisational internationalisation documentation'
  const hardPeerContent = () => {
    const brief = inventedPeerBrief()
    brief.peer_groups[0].kind = HARD_KIND
    return peerContent({ brief })
  }

  it('the kind is one the brief validator accepts, and the same record ships the peer rung with a plain kind (control)', () => {
    expect(hardPeerContent().outbound_brief.peer_groups[0].kind).toBe(HARD_KIND)
    expect(decidePeer({ content: hardPeerContent(), company: NO_RECORD_PASSED })).toEqual({ tier: 'template', reason: 'no_fact' })
    const d = decidePeer()
    expect(d.tier === 'firm_fact' && d.detail.rung).toBe('peer')
  })

  it.each<[string, unknown, string]>([
    ['no stored fact', null, 'no_fact'],
    ['a fact that did not pass', { ...FACT, passed: false }, 'fact_did_not_pass'],
    ['a stale fact', { ...FACT, source_fetched_at: '2026-06-01T00:00:00Z' }, 'stale_source'],
  ])('PLANTED: %s and a peer attempt that FAILS: reason is the fact\'s own, and peer_reason says the attempt was made and what it broke', (_what, fact, reason) => {
    // All three used to return { reason: 'revalidation_failed' } with no peer_reason: a
    // prospect that never had a fact was recorded as a fact that failed re-validation.
    const d = decidePeer({ content: hardPeerContent(), fact })
    expect(d).toMatchObject({ tier: 'template', reason, peer_reason: 'revalidation_failed' })
    if (d.tier !== 'template') return
    expect(d.violations).toBeUndefined()
    expect(d.peer_violations?.join(' ')).toContain('opener_clause_grade')
  })

  it('PLANTED: a fact rung that fails AND a peer attempt that fails are told apart from the same fact with no record at all', () => {
    const fact = { ...FACT, does: HARD_CLAUSE, for_whom: null }
    const both = decidePeer({ content: hardPeerContent(), fact })
    const noRecord = decidePeer({ content: hardPeerContent(), fact, company: NO_RECORD_PASSED })
    // Until 2026-10-02 these two were the same bytes.
    expect(both).not.toEqual(noRecord)
    expect(noRecord).toMatchObject({ tier: 'template', reason: 'revalidation_failed' })
    expect('peer_reason' in noRecord).toBe(false)
    expect('peer_violations' in noRecord).toBe(false)
    expect(both).toMatchObject({ tier: 'template', reason: 'revalidation_failed', peer_reason: 'revalidation_failed' })
    if (both.tier !== 'template') return
    // Each failure's own words, in its own field.
    expect(both.violations?.join(' ')).toContain('opener_clause_grade')
    expect(both.peer_violations?.join(' ')).toContain('opener_clause_grade')
    expect(both.violations).not.toEqual(both.peer_violations)
  })

  it('PLANTED: on a SHIPPED peer rung, what the failed rung above it broke is kept beside fact_reason', () => {
    // A tagline fact whose kind breaks a rule with its real words: the broad rung is tried
    // first and fails, the peer rung ships. The violations used to be thrown away.
    // The kind holds one of the client's own words ("export"), the word before the brief
    // kind's head noun ("software"), and otherwise only words that say nothing about a trade
    // ("multinational", "privately owned"), so it is no veto on the rung below.
    const d = decidePeer({ fact: { ...FACT, section: 'tagline', kind: 'a multinational privately owned professional specialised incorporated export software company' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('peer')
    expect(d.detail.fact_reason).toBe('revalidation_failed')
    expect(d.detail.fact_violations?.join(' ')).toContain('opener_clause_grade')
    // When the fact gave no rung at all there is nothing to keep (control).
    const none = decidePeer()
    expect(none.tier === 'firm_fact' && none.detail.fact_reason).toBe('no_fact')
    expect(none.tier === 'firm_fact' && 'fact_violations' in none.detail).toBe(false)
  })
})

describe('the kind read from their site, under a label for firms of that kind (review of 2026-10-02; replacement withdrawn 2026-10-03)', () => {
  const lawBrief = () => {
    const brief = inventedPeerBrief()
    brief.peer_groups = [
      { id: 'PG1', label: 'law firms', industry: 'Legal Services', kind: 'a law firm', source: 'invented' },
      { id: 'PG2', label: 'furniture makers and importers', industry: 'Furniture Manufacturing', source: 'invented' },
    ]
    return brief
  }
  const decideLaw = (fact: unknown) => decidePeer({ content: peerContent({ brief: lawBrief() }), fact, company: NO_RECORD_PASSED })

  // Until 2026-10-03 each label below was REPLACED when the opener named the kind of firm or
  // echoed the label (peerLabelUnderOpener, peerLabelEchoes). Both are withdrawn: the
  // reader's own group is named. Only findConsecutiveRepeats is still read, and it does not
  // count "law", "IT" or "tax", nor "consulting" against "consultants", so each of these now
  // ships with the label as stored.

  it('on the BROAD rung a stored label whose group has a kind of its own now stays: "you run a legal practice" then "law firms" (2026-10-03)', () => {
    const d = decideLaw({ ...FACT, does: null, for_whom: null, kind: 'a legal practice', peer_group_label: 'law firms' })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(opener(d.body)).toMatch(/you run a legal practice\.$/)
    expect(painLine(d.body)).toMatch(namesSource('law firms'))
    expect('peer_label_replaced' in d.detail).toBe(false)
  })

  it('the same label under a SPECIFIC clause that shares no word with it stays (control)', () => {
    const d = decideLaw({ ...FACT, does: 'you draft wills for families', for_whom: null, peer_group_label: 'law firms' })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('specific')
    expect(painLine(d.body)).toMatch(namesSource('law firms'))
    expect('peer_label_replaced' in d.detail).toBe(false)
  })

  it('on the broad rung a stored label whose group has NO kind stays, when the two share no word (control)', () => {
    const d = decideLaw({ ...FACT, does: null, for_whom: null, kind: 'a legal practice', peer_group_label: 'furniture makers and importers' })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(painLine(d.body)).toMatch(namesSource('furniture makers and importers'))
    expect('peer_label_replaced' in d.detail).toBe(false)
  })

  it('on the SPECIFIC rung an acronym, a three-letter word, or one stem with two endings no longer replaces the label (2026-10-03)', () => {
    const brief = lawBrief()
    brief.peer_groups.push({ id: 'PG3', label: 'IT consultants', industry: 'Information Technology Consulting', source: 'invented' })
    const c = peerContent({ brief })
    for (const [does, label] of [
      ['you manage IT for dental clinics', 'IT consultants'],
      ['you advise on consulting contracts', 'IT consultants'],
      ['you handle law for start-ups', 'law firms'],
    ]) {
      const d = decidePeer({ content: c, fact: { ...FACT, does, for_whom: null, peer_group_label: label }, company: NO_RECORD_PASSED })
      expect(d.tier, `${does}: ${JSON.stringify(d)}`).toBe('firm_fact')
      if (d.tier !== 'firm_fact') continue
      expect(painLine(d.body)).toMatch(namesSource(label))
      expect('peer_label_replaced' in d.detail).toBe(false)
    }
  })

  it('PLANTED: on the peer rung a word the opener shares with the label ships ("you run a legal practice", "legal practices") (2026-10-03)', () => {
    // Until 2026-10-03 "legal" failed the rung. It is the label's own word, under an opener
    // that names the reader's kind, so it is the echo the operator asked for.
    const brief = lawBrief()
    brief.peer_groups[0] = { ...brief.peer_groups[0], label: 'legal practices' }
    const d = decidePeer({ content: peerContent({ brief }), fact: { ...FACT, does: null, for_whom: null, kind: 'a legal practice', peer_group_label: 'legal practices' }, company: NO_RECORD_PASSED })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(painLine(d.body)).toMatch(namesSource('legal practices'))
  })
})

describe('a brief with no kinds and no after-opener label: the echo the shared-word test cannot see (review of 2026-10-02, round two; withdrawn 2026-10-03)', () => {
  // Such a brief validates, and has no label written for the place under an opener. Until
  // round two "Your site says you run a law firm. Law firms often tell us ..." shipped:
  // peerLabelEchoes saw "law", nothing could replace the label, and the rule-3 check reads
  // words of four letters or more, so it could not see "law" or "tax" either.
  const plainBrief = (defaultLabel = 'exporters') => {
    const brief = inventedBrief()
    brief.peer_groups = [
      { id: 'PG1', label: 'law firms', industry: 'Legal Services', source: 'invented' },
      { id: 'PG2', label: 'tax advisers', industry: 'Accounting', source: 'invented' },
    ]
    brief.peer_group_default = { label: defaultLabel, source: 'invented' }
    return brief
  }
  const decidePlain = (fact: unknown, defaultLabel?: string) =>
    decidePeer({ content: peerContent({ brief: plainBrief(defaultLabel), frames: INVENTED_OPENER_FRAMES }), fact, company: NO_RECORD_PASSED })

  // Until 2026-10-03 the echoes below were caught by peerLabelEchoes, and the default label
  // stood in for the stored one, or the rung failed. Composition no longer calls it: the
  // label stays, and findConsecutiveRepeats does not count a word of three letters.

  it('"you run a law firm" over the stored label "law firms" now keeps that label (2026-10-03)', () => {
    const d = decidePlain({ ...FACT, does: null, for_whom: null, kind: 'a law firm', peer_group_label: 'law firms' })
    expect(d.tier, JSON.stringify(d)).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(opener(d.body)).toMatch(/you run a law firm\.$/)
    expect(painLine(d.body)).toMatch(namesSource('law firms'))
    expect('peer_label_replaced' in d.detail).toBe(false)
    expect(d.detail.fills.peer_group).toBe('law firms')
  })

  it('"you run a tax advisory firm" under a default label "tax advisers" now ships on that default (2026-10-03)', () => {
    const d = decidePlain({ ...FACT, does: null, for_whom: null, kind: 'a tax advisory firm', peer_group_label: null }, 'tax advisers')
    expect(d.tier, JSON.stringify(d)).toBe('firm_fact')
    expect(d.tier === 'firm_fact' && painLine(d.body)).toMatch(namesSource('tax advisers'))
  })

  it('a clause that shares no word with the stored label keeps it (control)', () => {
    const d = decidePlain({ ...FACT, does: 'you draft wills for families', for_whom: null, peer_group_label: 'law firms' })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(painLine(d.body)).toMatch(namesSource('law firms'))
    expect('peer_label_replaced' in d.detail).toBe(false)
  })
})

describe('no word in the opener and again in the sentence under it, on the email as it is SENT (operator rule 3)', () => {
  // The template validator reads the slot-free email and invented fills. Only composition
  // holds the reader's real clause, so only composition can hold the rule on what is sent.
  //
  // The document here says "new clients" in its pain line. Wording 0 says it, the alternate
  // does not, unless a test says otherwise. The frame names no word the pain lines hold.
  const PAIN_NEW_CLIENTS = '{peer_group} often tell us new clients are hard to win abroad. As a result, sales can stall.'
  const PAIN_PLAIN = "{peer_group} say buyers in new places often leave pages they can't read. So deals can be lost."
  const docWith = (pain: string, alt: string | null) => {
    const c = content()
    c.opener_frames = ['Can see {does}.']
    const line = c.variants.A.lines.email1.pain
    line.text = pain
    if (alt === null) delete line.alt
    else line.alt.text = alt
    return c
  }
  const REPEATS = { ...FACT, does: 'you help founders win new clients', for_whom: null, peer_group_label: null }
  const CLEAN = { ...FACT, does: 'you fit kitchens for landlords', for_whom: null, peer_group_label: null }
  const firstPainSentence = (body: string) => painLine(body).split('. ')[0]

  it('PLANTED: "you help founders win new clients" is never followed by a pain line that says "new clients": the other wording ships, and the record says which word', () => {
    const c = docWith(PAIN_NEW_CLIENTS, PAIN_PLAIN)
    let moved = 0
    for (let i = 0; i < 40; i++) {
      const d = decide({ content: c, prospect: `prospect-${i}`, fact: REPEATS })
      expect(d.tier, `prospect-${i}: ${JSON.stringify(d)}`).toBe('firm_fact')
      if (d.tier !== 'firm_fact') continue
      expect(opener(d.body)).toBe('Can see you help founders win new clients.')
      expect(firstPainSentence(d.body)).not.toContain('clients')
      // The record holds the wording that SHIPPED, and why it is not the prospect's own.
      expect(d.detail.wording.pain).toBe(1)
      if (d.detail.opener_repeat_avoided) {
        moved++
        expect(d.detail.opener_repeat_avoided).toEqual(['clients'])
      }
    }
    // Some of the forty drew wording 0 and were moved; the rest drew the alternate anyway.
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThan(40)
  })

  it('a clause that shares no word ships on the prospect\'s own wording, both wordings in use, and nothing is recorded as avoided (control)', () => {
    const c = docWith(PAIN_NEW_CLIENTS, PAIN_PLAIN)
    const seen = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const d = decide({ content: c, prospect: `prospect-${i}`, fact: CLEAN })
      if (d.tier !== 'firm_fact') throw new Error(`prospect-${i}: ${JSON.stringify(d)}`)
      seen.add(d.detail.wording.pain)
      expect('opener_repeat_avoided' in d.detail).toBe(false)
    }
    expect([...seen].sort()).toEqual([0, 1])
  })

  it('PLANTED: when EVERY wording repeats, the rung fails with opener_repeats_next_sentence and the word, and the template ships', () => {
    const both = docWith(PAIN_NEW_CLIENTS, '{peer_group} say new clients are slow to come from abroad. So deals can be lost.')
    const one = docWith(PAIN_NEW_CLIENTS, null)
    for (const c of [both, one]) {
      const d = decide({ content: c, fact: REPEATS })
      expect(d).toMatchObject({ tier: 'template', reason: 'opener_repeats_next_sentence' })
      expect(d.tier === 'template' && d.violations).toEqual([expect.stringContaining('"clients"')])
      // The same documents with the clean clause ship (control).
      expect(decide({ content: c, fact: CLEAN }).tier).toBe('firm_fact')
    }
  })

  it('PLANTED: a rung that fails this way is a rung that failed: the ladder moves to the kind of firm, and the record keeps why', () => {
    const c = docWith(PAIN_NEW_CLIENTS, null)
    const d = decide({ content: c, fact: { ...REPEATS, kind: 'a dental practice' } })
    expect(d.tier).toBe('firm_fact')
    if (d.tier !== 'firm_fact') return
    expect(d.detail.rung).toBe('broad')
    expect(opener(d.body)).toBe('Can see you run a dental practice.')
    expect(d.detail.specific_dropped?.join(' ')).toContain('opener_repeats_next_sentence')
  })

  it('PLANTED: the FRAME is part of the opener sentence: "Your site says ..." is never followed by a pain line about "the site"', () => {
    // The shared fixture as it stood until 2026-10-02, rebuilt here: both frames said "your
    // site" and wording 0 of variant A's pain line ended "leave the site". Every tier 2
    // reader on wording 0 got the word twice in two sentences, and every rule passed.
    const c = content()
    c.opener_frames = ['Your site says {does}.']
    c.variants.A.lines.email1.pain.text = '{peer_group} often tell us buyers abroad leave the site. As a result, sales can stall.'
    for (let i = 0; i < 40; i++) {
      const d = decide({ content: c, prospect: `prospect-${i}`, fact: CLEAN })
      expect(d.tier).toBe('firm_fact')
      if (d.tier !== 'firm_fact') continue
      expect(opener(d.body)).toBe('Your site says you fit kitchens for landlords.')
      expect(firstPainSentence(d.body)).not.toMatch(/\bsite\b/)
    }
  })

  it('PLANTED: the peer rung is held to it too', () => {
    // An unvalidated document: both wordings of the pain line say "software" under "Can see
    // you run a software company." Generation refuses this document; composition must too.
    const c = peerContent()
    c.variants.A.lines.email1.pain.text = '{peer_group} often tell us their software sells slowly abroad. As a result, sales can stall.'
    c.variants.A.lines.email1.pain.alt.text = '{peer_group} say software buyers in new places often leave. So deals can be lost.'
    const d = decidePeer({ content: c })
    expect(d).toMatchObject({ tier: 'template', reason: 'no_fact', peer_reason: 'opener_repeats_next_sentence' })
    expect(d.tier === 'template' && d.peer_violations).toEqual([expect.stringContaining('"software"')])
    // One wording clean: the peer rung ships on it.
    const oneClean = peerContent()
    oneClean.variants.A.lines.email1.pain.text = '{peer_group} often tell us their software sells slowly abroad. As a result, sales can stall.'
    const shipped = decidePeer({ content: oneClean })
    expect(shipped.tier === 'firm_fact' && shipped.detail.rung).toBe('peer')
    expect(shipped.tier === 'firm_fact' && shipped.detail.wording.pain).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Operator decisions of 2026-10-03: the reader's firm named in Email 1's lead-in, on every
// tier, and the reader's own peer group naming the source in a template follow-up.

describe('decideEmail1LeadIn: "If Kessel is seeing this too, we ..." (2026-10-03)', () => {
  const NAME = 'Kessel Labs'
  const leadIn = (overrides: { content?: Record<string, any>; body?: string; companyName?: string | null; maxWords?: number; variant?: string } = {}) => {
    const c = overrides.content ?? content()
    const variant = overrides.variant ?? 'A'
    return decideEmail1LeadIn({
      messagingContent: c,
      variantId: variant,
      body: overrides.body ?? c.variants[variant].emails[0].body,
      companyName: 'companyName' in overrides ? overrides.companyName! : NAME,
      reader: { firstName: 'Ada', lastName: 'Quill' },
      maxWords: overrides.maxWords ?? 85,
    })
  }
  const words = (text: string) => text.trim().split(/\s+/).length

  it('PLANTED: names the firm in the lead-in of the stored Email 1, and changes nothing else', () => {
    const c = content()
    const stored: string = c.variants.A.emails[0].body
    expect(stored).toContain("\n\nIf you're seeing this too, we translate your pages")
    const d = leadIn({ content: c })
    expect(d.named).toBe(true)
    if (!d.named) return
    expect(d.company).toMatch(/Kessel/)
    const before = stored.split('\n\n'), after = d.body.split('\n\n')
    expect(after[2]).toBe(`If ${d.company} is seeing this too, we translate your pages and a native speaker checks each one, so your buyers can read your site.`)
    // Every other paragraph byte for byte.
    expect(after.filter((_, i) => i !== 2)).toEqual(before.filter((_, i) => i !== 2))
    expect(d.word_count).toBe(words(d.body.replace('{{first_name}}', 'x')))
  })

  it('PLANTED: each variant\'s own lead-in is used: variant B says "sees"', () => {
    const d = leadIn({ variant: 'B' })
    expect(d.named && d.body.split('\n\n')[2]).toMatch(/^If Kessel[^,]* sees this too, we turn your key pages/)
  })

  it('PLANTED: a firm-fact Email 1 is named too: the lead-in is found wherever the offer paragraph stands', () => {
    const c = content()
    const fact = decide({ content: c })
    expect(fact.tier).toBe('firm_fact')
    if (fact.tier !== 'firm_fact') return
    const d = leadIn({ content: c, body: fact.body, maxWords: 85 })
    expect(d.named).toBe(true)
    expect(d.named && d.body.split('\n\n')[3]).toMatch(/^If Kessel[^,]* is seeing this too, we /)
  })

  it.each<[string, Parameters<typeof leadIn>[0], string]>([
    ['no name is held', { companyName: null }, 'nothing_held'],
    ['the variant has no lead-in (a document written before it existed)', { content: (() => { const c = content(); delete c.variants.A.lines.email1.lead_in; return c })() }, 'no_lead_in'],
    ['the body does not hold the slot-free lead-in (a researched Email 1, say)', { body: content().variants.A.emails[0].body.replace("If you're seeing this too, we", 'We') }, 'no_slot_free_lead_in_in_body'],
    ['the variant has no lines', { content: (() => { const c = content(); delete c.variants.A.lines; return c })() }, 'no_lines'],
    ['there is no brief', { content: (() => { const c = content(); delete c.outbound_brief; return c })() }, 'no_brief'],
    ['the brief no longer validates', { content: (() => { const c = content(); delete c.outbound_brief.avoid_wording; return c })() }, 'brief_invalid'],
  ])('PLANTED: when %s, the slot-free clause ships and the reason says why', (_name, overrides, reason) => {
    expect(leadIn(overrides)).toEqual({ named: false, reason })
  })

  it('PLANTED: a name that takes the email over its word cap is not used', () => {
    const stored: string = content().variants.A.emails[0].body
    const storedWords = words(stored)
    // The cap at exactly the stored body: the name adds at least one word, so it is over.
    expect(leadIn({ maxWords: storedWords })).toEqual({ named: false, reason: 'named_body_over_band' })
    // With room for it, it is named (control).
    expect(leadIn({ maxWords: storedWords + 10 }).named).toBe(true)
  })
})

describe('decideFollowupFills: the reader\'s own peer group names the source in a follow-up (2026-10-03)', () => {
  const email2 = (c = content()) => c.variants.A.emails.find((e: { sequence_position: number }) => e.sequence_position === 2).body as string
  const fill = (peerGroup: string | null, companyName: string | null = null) => {
    const c = content()
    return decideFollowupFills({ messagingContent: c, body: email2(c), position: 2, companyName, forWhom: null, peerGroup })
  }

  it('the stored Email 2 names the default label, slot-free (the premise)', () => {
    expect(email2()).toContain('In our chats with exporters, a lot of them say a new market starts slower than hoped.')
  })
  it('PLANTED: with the reader\'s group held and nothing else, {peer_group} is filled from it', () => {
    const d = fill('software makers')
    expect(d.filled).toBe(true)
    if (!d.filled) return
    expect(d.body).toContain('In our chats with software makers, a lot of them say a new market starts slower than hoped.')
    expect(d.body).not.toContain('chats with exporters')
    expect(d.slotted).toEqual([true, false, false])
  })
  it('with no group, no name and no customer group held, nothing is filled (control)', () => {
    expect(fill(null)).toEqual({ filled: false, reason: 'nothing_held' })
    expect(fill('   ')).toEqual({ filled: false, reason: 'nothing_held' })
  })
  it('PLANTED: the group and the firm are filled together, each in its own paragraph', () => {
    const d = fill('software makers', 'Kessel Labs')
    expect(d.filled).toBe(true)
    if (!d.filled) return
    expect(d.body).toContain('In our chats with software makers,')
    expect(d.body).toMatch(/Does that match what Kessel[^?]* sees\?/)
    expect(d.slotted).toEqual([true, false, true])
  })
})
