// The outbound brief's structural rules. The control is the invented brief passing clean;
// every rule is then planted and must be reported.

import { describe, it, expect } from 'vitest'
import {
  clientGenericWords,
  conflictedAngleIds,
  forbiddenPhrases,
  neutralOutcomeIds,
  isLeadDifferentiator,
  peerKindFormProblems,
  peerLabelUnderOpener,
  proofIds,
  readBrief,
  usableAngles,
  validateOutboundBrief,
  type OutboundBrief,
} from '../brief'
import { inventedBrief, inventedPeerBrief } from '@/lib/outbound-templates/__tests__/fixtures/invented-client'

const problemsAfter = (mutate: (b: OutboundBrief) => void): string => {
  const b = inventedBrief()
  mutate(b)
  return validateOutboundBrief(b).join(' | ')
}

describe('validateOutboundBrief', () => {
  it('passes the invented brief (the control)', () => {
    expect(validateOutboundBrief(inventedBrief())).toEqual([])
  })

  it.each<[string, (b: OutboundBrief) => void, string]>([
    ['a pain angle with no symptom (rule 5)', b => { b.pain_angles[0].symptom = ' ' }, 'symptom is required'],
    ['a conflict naming nothing (rule 11)', b => { b.pain_angles[3].conflicts_with = ['X9'] }, 'not a must_not_exclude item'],
    ['a lead angle that conflicts with an in-scope buyer (rule 11)', b => { b.pain_angles[0].conflicts_with = ['X1'] }, 'most_buyers angle cannot conflict'],
    ['a lead differentiator that is not a proof point (rule 4)', b => { b.lead_differentiator = 'D1' }, 'is not a proof point'],
    ['a lead differentiator that is not top-ranked (rule 4)', b => { b.lead_differentiator = 'PR2' }, 'not the top-ranked proof point'],
    ['no lead differentiator field at all (rule 4)', b => { delete (b as { lead_differentiator?: unknown }).lead_differentiator }, 'lead_differentiator must be'],
    ['a default peer label that excludes an in-scope buyer (rule 7)', b => { b.must_not_exclude[0].phrases.push('owners'); b.peer_group_default.label = 'export owners' }, 'must be true for any in-scope buyer'],
    ['a peer group label carrying avoided wording (rule 7)', b => { b.peer_groups[0].label = 'hiring managers' }, 'must be true for any in-scope buyer'],
    ['a default peer label carrying a never_claims phrase', b => { b.peer_group_default.label = 'instant exporters' }, 'contains the never_claims phrase "instant"'],
    // ── The second reading's notes (2026-10-01) ──
    ['no generic_kind_words list: an absent list is not a decision', b => { delete (b as { generic_kind_words?: unknown }).generic_kind_words }, 'generic_kind_words must be an array'],
    ['a generic_kind_words entry that is a phrase', b => { b.generic_kind_words = ['export firm'] }, 'generic_kind_words: every entry is one lower-case word'],
    ['a generic_kind_words entry in capitals', b => { b.generic_kind_words = ['Export'] }, 'generic_kind_words: every entry is one lower-case word'],
    // The check splits a hyphenated word into parts, so an entry with a hyphen matched nothing.
    ['a generic_kind_words entry with a hyphen', b => { b.generic_kind_words = ['e-commerce'] }, 'generic_kind_words: every entry is one lower-case word'],
    ['a generic_kind_words entry of one character', b => { b.generic_kind_words = ['x'] }, 'generic_kind_words: every entry is one lower-case word'],
    ['a generic_kind_words entry that is not text', b => { b.generic_kind_words = [null as unknown as string] }, 'generic_kind_words: every entry is one lower-case word'],
    ['an outcome that holds a phrase the brief forbids in copy', b => { b.scope.never_claims[0].phrases.push('read your pages') }, 'O1.statement: holds "read your pages", which N1 forbids in copy'],
    ['a symptom that holds a phrase the brief forbids in copy', b => { b.avoid_wording[0].phrases.push('leave the site') }, 'PA1.symptom: holds "leave the site", which W1 forbids in copy'],
    ['no outcome that answers every lead angle: the neutral offer has nothing to sell', b => { b.pain_angles[1].resolved_by = ['O2'] }, 'no outcome answers every lead angle (PA1: O3, O1; PA2: O2)'],
    ['no outcomes list (note 1)', b => { delete (b as { outcomes?: unknown }).outcomes }, 'outcomes must be an array'],
    ['an empty outcomes list (note 1)', b => { b.outcomes = [] }, 'outcomes is empty'],
    ['a usable angle with no outcome that answers it (note 2)', b => { b.pain_angles[0].resolved_by = [] }, 'PA1: resolved_by is required'],
    ['an angle answered by something that is not an outcome (note 2)', b => { b.pain_angles[0].resolved_by = ['D1'] }, 'resolved_by D1, which is not an outcome'],
    ['a phrase in the brief that can be read two ways (note 3)', b => { b.pain_angles[0].consequence = 'Sales can go to someone else.' }, 'PA1.consequence: "someone else" can be read two ways'],
    ['no competitor_categories list (note 7)', b => { delete (b as { competitor_categories?: unknown }).competitor_categories }, 'competitor_categories must be an array'],
    ['a competitor category with nothing to find it by (note 7)', b => { b.competitor_categories[0].phrases = [] }, 'C1: phrases must be a non-empty list'],
    ['no avoid_wording list', b => { delete (b as { avoid_wording?: unknown }).avoid_wording }, 'avoid_wording must be an array'],
    ['an avoid_wording rule with no phrases', b => { b.avoid_wording[0].phrases = [] }, 'phrases must be a non-empty list'],
  ])('reports %s (planted)', (_name, mutate, expected) => {
    expect(problemsAfter(mutate)).toContain(expected)
  })

  it('allows a client with no competitor categories, and a conflicting angle with no outcome', () => {
    expect(problemsAfter(b => { b.competitor_categories = [] })).toBe('')
    // PA4 declares a conflict and is never used, so it needs no outcome (the fixture has none).
    expect(inventedBrief().pain_angles[3].resolved_by).toEqual([])
  })
  it('allows a null lead differentiator: a client may have none', () => {
    expect(problemsAfter(b => { b.lead_differentiator = null })).toBe('')
  })
})

describe('the neutral offer and the client\'s generic words', () => {
  it('neutralOutcomeIds: the outcomes that answer EVERY lead angle, and no others', () => {
    // PA1 is answered by O3 and O1; PA2 by O1 and O2. Only O1 answers both.
    expect(neutralOutcomeIds(inventedBrief())).toEqual(['O1'])
    const none = inventedBrief()
    none.pain_angles[1].resolved_by = ['O2']
    expect(neutralOutcomeIds(none)).toEqual([])
  })
  it('a some_buyers angle does not narrow it: the neutral line sits under lead pains only', () => {
    const b = inventedBrief()
    b.pain_angles[2].resolved_by = ['O2']
    expect(neutralOutcomeIds(b)).toEqual(['O1'])
    expect(validateOutboundBrief(b)).toEqual([])
  })
  it('a client with ONE lead angle has no neutral line, so the rule asks nothing of it', () => {
    const b = inventedBrief()
    b.pain_angles[1].reach = 'some_buyers'
    b.pain_angles[1].resolved_by = ['O2']
    expect(validateOutboundBrief(b)).toEqual([])
  })
  it('PLANTED: a brief with NO lead angle is told that once, not twice', () => {
    // The guard this pins is `lead.length >= 2`. Without it a brief with no lead angle is
    // also told that no outcome answers every lead angle, which is true of nothing.
    const b = inventedBrief()
    for (const angle of b.pain_angles) angle.reach = 'some_buyers'
    const problems = validateOutboundBrief(b)
    expect(problems.filter(p => p.includes('no pain angle has reach = most_buyers'))).toHaveLength(1)
    expect(problems.filter(p => p.includes('no outcome answers every lead angle'))).toEqual([])
  })
  it('generic_kind_words takes a two-letter word and a word with a digit (controls)', () => {
    const b = inventedBrief()
    b.generic_kind_words = ['it', 'b2b', 'export']
    expect(validateOutboundBrief(b)).toEqual([])
    // And the default label's two-letter words count too: "it" comes from the LABEL here,
    // not from the list.
    b.generic_kind_words = ['export']
    b.peer_group_default.label = 'IT firms'
    expect([...clientGenericWords(b)].sort()).toEqual(['export', 'firms', 'it'])
  })
  it('clientGenericWords: the brief\'s list plus the words of the default peer label', () => {
    expect([...clientGenericWords(inventedBrief())].sort()).toEqual(['export', 'exporter', 'exporters', 'exporting'])
    const empty = inventedBrief()
    empty.generic_kind_words = []
    expect([...clientGenericWords(empty)]).toEqual(['exporters'])
    expect(validateOutboundBrief(empty)).toEqual([])
  })
})

describe('brief helpers', () => {
  it('usableAngles drops any angle with a declared conflict, in rank order', () => {
    expect(usableAngles(inventedBrief()).map(a => a.id)).toEqual(['PA1', 'PA2', 'PA3'])
  })
  it('proofIds covers proof points and proof-only scope items', () => {
    expect([...proofIds(inventedBrief())].sort()).toEqual(['D2', 'PR1', 'PR2'])
  })
  it('only the named proof point is the lead differentiator', () => {
    const b = inventedBrief()
    expect(isLeadDifferentiator(b, 'PR1')).toBe(true)
    expect(isLeadDifferentiator(b, 'PR2')).toBe(false)
    expect(isLeadDifferentiator({ ...b, lead_differentiator: null }, 'PR1')).toBe(false)
  })
  it('the client\'s avoid_wording joins the forbidden phrases', () => {
    expect(forbiddenPhrases(inventedBrief()).map(f => f.phrase)).toContain('hiring')
  })
})

describe('readBrief: why there is no brief', () => {
  it('returns the brief when it is valid', () => {
    expect(readBrief({ outbound_brief: inventedBrief() })).toMatchObject({ present: true, problems: [] })
    expect(readBrief({ outbound_brief: inventedBrief() }).brief).not.toBeNull()
  })
  it('tells an absent brief from one that no longer validates', () => {
    expect(readBrief({ variants: {} })).toEqual({ brief: null, present: false, problems: [] })
    expect(readBrief(null)).toEqual({ brief: null, present: false, problems: [] })
    const older = inventedBrief() as unknown as Record<string, unknown>
    delete older.avoid_wording
    const read = readBrief({ outbound_brief: older })
    expect(read.brief).toBeNull()
    expect(read.present).toBe(true)
    expect(read.problems).toEqual(['avoid_wording must be an array'])
  })
})

describe('peer labels', () => {
  it('refuses a label over four words: every length rule is computed from that cap', () => {
    const brief = inventedBrief()
    brief.peer_groups[1].label = 'furniture makers and importers of oak'
    expect(validateOutboundBrief(brief).join(' ')).toContain('is over 4 words')
    brief.peer_groups[1].label = 'furniture makers and importers'
    brief.peer_group_default.label = 'firms that sell goods abroad'
    expect(validateOutboundBrief(brief).join(' ')).toContain('peer_group_default: label "firms that sell goods abroad" is over 4 words')
  })
  it('conflictedAngleIds names exactly the angles that declare a conflict', () => {
    expect([...conflictedAngleIds(inventedBrief())]).toEqual(['PA4'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PEER KINDS AND THE LABEL UNDER AN OPENER (operator notes 1 and 3 on the fifth reading,
// 2026-10-02).
//
// A kind is the one thing in the brief that is said to a stranger as a fact about THEIR
// firm with no model and no judge between the brief and the reader: "Can see you run an HR
// consultancy." So its form is held here, where a person can fix it, and every reason it
// can be refused is planted below with a kind beside it that passes.
//
// The invented client's generic words are exporter, export and exporting, and its default
// label is "exporters". inventedPeerBrief gives its first peer group the kind "a software
// company". Since 2026-10-03 it has no after-opener label: the reader's own group is named
// in the pain line ("When we chat to software makers, ..."), and the field is ignored.

const peerProblemsAfter = (mutate: (b: OutboundBrief) => void): string => {
  const b = inventedPeerBrief()
  mutate(b)
  return validateOutboundBrief(b).join(' | ')
}

// The three dashes a kind may not hold, BUILT so this file holds none of them itself.
const EM_DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)
const DOUBLE_HYPHEN = '-'.repeat(2)

describe('peerKindFormProblems: the form of a kind of firm', () => {
  const generic = clientGenericWords(inventedBrief())

  it.each<[string, string, string, string]>([
    ['no article', 'software company', 'must start with "a" or "an"', 'a software company'],
    // The kind is dropped into the middle of a sentence after "you run".
    ['a capital on the article', 'A software company', 'must start with "a" or "an"', 'an HR consultancy'],
    ['"the" for an article', 'the software company', 'must start with "a" or "an"', 'a software company'],
    // Seven words, against six that pass: the length budget of Email 1 is built on the cap.
    ['too many words', 'a small independent cold room engineering firm', 'plus one to 5 words', 'a cold room engineering design firm'],
    ['a full stop', 'a software company.', 'holds punctuation, a slash, a dash or an ampersand', 'a software company'],
    ['a comma', 'a software, hardware company', 'holds punctuation, a slash, a dash or an ampersand', 'a software and hardware company'],
    // A hyphen that joins one word is not a dash.
    ['an em dash', `a software ${EM_DASH} hardware company`, 'holds punctuation, a slash, a dash or an ampersand', 'a cold-room engineering firm'],
    ['an en dash', `a software ${EN_DASH} hardware company`, 'holds punctuation, a slash, a dash or an ampersand', 'a cold-room engineering firm'],
    ['a double hyphen', `a software ${DOUBLE_HYPHEN} hardware company`, 'holds punctuation, a slash, a dash or an ampersand', 'a cold-room engineering firm'],
    ['a hyphen standing alone', 'a software - hardware company', 'holds punctuation, a slash, a dash or an ampersand', 'a cold-room engineering firm'],
    ['an ampersand', 'a research & design firm', 'holds punctuation, a slash, a dash or an ampersand', 'a research and design firm'],
    // A slash joins two words, and the acronym check reads each side: before it was
    // named here a kind written with one validated and would have shipped on the peer rung.
    ['a slash', 'a research/design firm', 'holds punctuation, a slash, a dash or an ampersand', 'a research and design firm'],
    // "you run a supplier of your software" turns the reader into their own customer. The
    // control holds the same letters inside a longer word.
    ['"your"', 'a supplier of your software', 'holds "you" or "your"', 'a youth charity'],
    // "you run an IT consulting" is the front of a phrase with its noun left off.
    ['a last word that names the work', 'an IT consulting', 'must end on the noun for the firm', 'an IT consultancy'],
    ['a joining word last', 'a consultancy and', 'must end on the noun for the firm', 'a design consultancy'],
    // A capital mid-sentence reads as a place or a brand. A known acronym does not. (A
    // mixed-case short form such as "SaaS" is an unexplained acronym since checks version 23.)
    ['a capitalised word', 'a Northtown consultancy', 'a capitalised word reads as a name', 'an AI consultancy'],
    ['an acronym a reader may not know', 'a CRM consultancy', 'holds the acronym "CRM"', 'an HR consultancy'],
    ['the same acronym as a plural', 'a CRMs consultancy', 'holds the acronym "CRMs"', 'an IT consultancy'],
    // "You run an export business" could be sent to every firm on this client's list.
    ['only the client\'s generic words', 'an export business', 'names nothing specific', 'a furniture exporter'],
    ['the client\'s generic word in another form', 'an exporters group', 'names nothing specific', 'a software exporter'],
    ['only a plain word for a firm', 'a company', 'names nothing specific', 'a bakery'],
  ])('PLANTED: a kind with %s is refused for that and nothing else, and the kind beside it passes', (_name, planted, reason, control) => {
    const problems = peerKindFormProblems(planted, generic)
    // Exactly one reason: a kind refused for two things would hide which rule caught it.
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(reason)
    expect(problems[0]).toContain(`"${planted}"`)
    expect(peerKindFormProblems(control, generic)).toEqual([])
  })

  it('PLANTED: the article alone is refused for its length', () => {
    expect(peerKindFormProblems('a', generic).join(' | ')).toContain('"a" must be "a" or "an" plus one to 5 words')
    // The shortest kind there is: the article and one word (control).
    expect(peerKindFormProblems('a bakery', generic)).toEqual([])
  })

  it('PLANTED: two acronyms joined by a hyphen are each named', () => {
    expect(peerKindFormProblems('an ERP-CRM consultancy', generic)).toEqual([
      '"an ERP-CRM consultancy" holds the acronym "ERP", which a reader may not know',
      '"an ERP-CRM consultancy" holds the acronym "CRM", which a reader may not know',
    ])
    // Short forms every business reader knows (controls).
    for (const known of ['an HR consultancy', 'an IT consultancy', 'a B2B agency']) {
      expect(peerKindFormProblems(known, generic), known).toEqual([])
    }
  })

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a number', 5],
    ['null', null],
  ])('PLANTED: a kind that is %s is refused as not a phrase', (_name, kind) => {
    expect(peerKindFormProblems(kind, generic)).toEqual(['must be a non-empty phrase when it is given'])
  })

  it('PLANTED: WHICH words are generic is the client\'s own list: the same kind passes for a client who did not list them', () => {
    // Rule Zero. "An export business" names nothing to a client who sells only to
    // exporters, and is the most specific thing that can be said for a client who does not.
    expect(peerKindFormProblems('an export business', generic).join(' | ')).toContain('names nothing specific')
    expect(peerKindFormProblems('an export business', new Set())).toEqual([])
    // A plain word for a firm is generic for every client, list or no list (control).
    expect(peerKindFormProblems('a company', new Set()).join(' | ')).toContain('names nothing specific')
  })

  it('a kind padded with spaces is read without them (control)', () => {
    expect(peerKindFormProblems('  a software company ', generic)).toEqual([])
  })
})

describe('validateOutboundBrief: peer kinds and the label under an opener', () => {
  it('passes the invented brief with a kind and no after-opener label (the control)', () => {
    expect(validateOutboundBrief(inventedPeerBrief())).toEqual([])
  })

  it('a brief with no kinds and no after-opener label is exactly as valid as before (control)', () => {
    const plain = inventedBrief()
    expect(plain.peer_groups.every(pg => pg.kind === undefined)).toBe(true)
    expect(plain.peer_group_default.after_opener).toBeUndefined()
    expect(validateOutboundBrief(plain)).toEqual([])
  })

  it.each<[string, (b: OutboundBrief) => void]>([
    ['an empty industry', b => { b.peer_groups[0].industry = '' }],
    ['an industry of only spaces', b => { b.peer_groups[0].industry = '   ' }],
    ['no industry field', b => { delete (b.peer_groups[0] as { industry?: string }).industry }],
  ])('PLANTED: a peer group with a kind and %s is refused', (_name, mutate) => {
    // The industry is what a prospect is matched on. A kind with none is a line no
    // prospect can ever be given, stored as if it were live.
    expect(peerProblemsAfter(mutate)).toBe('PG1: a peer group with a kind names its industry: that is what a prospect is matched on')
  })

  it('a peer group with NO kind may have no industry: the rule is about the kind (control)', () => {
    expect(peerProblemsAfter(b => { b.peer_groups[1].industry = '' })).toBe('')
  })

  it('PLANTED: two peer groups with kinds on the same industry are refused, whatever the case or spacing', () => {
    // One stored industry, two kinds: which sentence a prospect got would depend on the
    // order of a list.
    expect(peerProblemsAfter(b => {
      b.peer_groups[1].kind = 'a software studio'
      b.peer_groups[1].industry = ' software PUBLISHERS '
    })).toBe('PG2: its industry " software PUBLISHERS " already has a kind on PG1; one kind per industry')
    expect(peerProblemsAfter(b => {
      b.peer_groups[1].kind = 'a software studio'
      b.peer_groups[1].industry = 'Software Publishers'
    })).toContain('already has a kind on PG1; one kind per industry')
  })

  it('two kinds on different industries pass, and so do two groups on one industry when only one has a kind (controls)', () => {
    // On a canonical industry: since 2026-10-02 a kind on any other name is refused here
    // (see "faults only the brief can fix" below), and the fixture's second group stands on
    // one that is not canonical.
    expect(peerProblemsAfter(b => { b.peer_groups[1].kind = 'a furniture maker'; b.peer_groups[1].industry = 'Wholesale Trade' })).toBe('')
    expect(peerProblemsAfter(b => { b.peer_groups[1].industry = 'Software Publishers' })).toBe('')
  })

  it.each<[string, string, string]>([
    ['no article', 'software company', 'PG1: kind "software company" must start with "a" or "an"'],
    ['an empty string', '', 'PG1: kind must be a non-empty phrase when it is given'],
    ['only spaces', '   ', 'PG1: kind must be a non-empty phrase when it is given'],
    ['an acronym a reader may not know', 'a CRM consultancy', 'PG1: kind "a CRM consultancy" holds the acronym "CRM"'],
    // The generic words the validator holds a kind to are THIS brief's.
    ['only the client\'s generic words', 'an export business', 'PG1: kind "an export business" names nothing specific'],
  ])('PLANTED: a kind with %s is reported against its peer group', (_name, kind, expected) => {
    expect(peerProblemsAfter(b => { b.peer_groups[0].kind = kind })).toContain(expected)
  })

  it('PLANTED: the default label\'s words count as generic for a kind, with nothing on the list', () => {
    // clientGenericWords adds them. The label "exporters" says every reader is one, so "an
    // exporters group" names nothing even for a brief whose list is empty.
    expect(peerProblemsAfter(b => { b.generic_kind_words = []; b.peer_groups[0].kind = 'an exporters group' })).toContain('names nothing specific')
    // The same empty list with a kind whose own noun says something (control). Until
    // 2026-10-02 the control was the fixture's "a software company", which passed here and
    // could never be evidenced by any record: that is now reported, see below.
    expect(peerProblemsAfter(b => { b.generic_kind_words = []; b.peer_groups[0].kind = 'a software studio' })).toBe('')
  })

  it('PLANTED: a kind with a bad form AND no industry is told both', () => {
    const problems = peerProblemsAfter(b => { b.peer_groups[0].kind = 'a CRM consulting'; b.peer_groups[0].industry = '' })
    expect(problems).toContain('must end on the noun for the firm')
    expect(problems).toContain('holds the acronym "CRM"')
    expect(problems).toContain('a peer group with a kind names its industry')
  })

  it('PLANTED: an after-opener label over the label word cap is refused', () => {
    // It fills {peer_group}, and every length rule downstream is computed from a label of
    // at most four words.
    expect(peerProblemsAfter(b => { b.peer_group_default.after_opener = 'Firms a lot like yours' }))
      .toBe('peer_group_default.after_opener: label "Firms a lot like yours" is over 4 words')
    // Four words exactly (control).
    expect(peerProblemsAfter(b => { b.peer_group_default.after_opener = 'Firms much like yours' })).toBe('')
  })

  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a number', 5],
    ['null', null],
  ])('PLANTED: an after-opener label that is %s is refused: given means non-empty', (_name, value) => {
    expect(peerProblemsAfter(b => { (b.peer_group_default as { after_opener?: unknown }).after_opener = value }))
      .toBe('peer_group_default.after_opener must be a non-empty phrase when it is given')
  })

  it('an after-opener label on a brief with no kinds is allowed (control)', () => {
    expect(problemsAfter(b => { b.peer_group_default.after_opener = 'Firms like yours' })).toBe('')
  })

  // ── Faults only the brief can fix are found HERE, where it costs nothing (2026-10-02) ──
  //
  // Each of these used to pass this validator and fail the template validator instead. The
  // generator then handed the fault to the writer, which cannot change a label, a kind or
  // an industry, and paid for repair calls until the spend cap stopped it.

  // ── WITHDRAWN 2026-10-03: the after-opener label ──
  //
  // Until then a brief with a kind had to give peer_group_default.after_opener ("Firms like
  // yours"), and that label could not repeat a kind. The operator asked for the reader's own
  // group by name, mid-sentence, so the stand-in is no longer used and neither rule holds.
  // A word the opener and the sentence under it truly share is caught at composition.

  it('a brief with a kind and NO after-opener label validates: the group\'s own label is named (2026-10-03)', () => {
    expect(peerProblemsAfter(b => { delete b.peer_group_default.after_opener })).toBe('')
    // The pair that once had to be refused here, "you run a law firm" and "law firms": it is
    // the brief's own label for that group, and the brief is valid with it.
    const law = (b: OutboundBrief) => { b.peer_groups = [{ id: 'PG1', label: 'law firms', industry: 'Legal Services', kind: 'a law firm', source: 'invented' }] }
    expect(peerProblemsAfter(b => { law(b); delete b.peer_group_default.after_opener })).toBe('')
    // Neither the retired requirement nor the retired repeat report appears in any form.
    const problems = peerProblemsAfter(b => { delete b.peer_group_default.after_opener })
    expect(problems).not.toContain('after_opener is required')
    expect(problems).not.toContain('is said by the opener')
  })

  it('an after-opener label that repeats a kind is not reported: the field is ignored (2026-10-03)', () => {
    // "Software firms like yours" under "you run a software company" was refused against PG1
    // until this date. Nothing places it now, so nothing is said about it.
    expect(peerProblemsAfter(b => { b.peer_group_default.after_opener = 'Software firms like yours' })).toBe('')
    // A given after-opener label is still held to the form of any label, because an older
    // brief may carry one (control, and see the planted cases above).
    expect(peerProblemsAfter(b => { b.peer_group_default.after_opener = 'Software firms a lot like yours' }))
      .toBe('peer_group_default.after_opener: label "Software firms a lot like yours" is over 4 words')
  })

  it('PLANTED: a kind on an industry that is not a canonical name is refused here, not left for generation', () => {
    expect(peerProblemsAfter(b => { b.peer_groups[0].industry = 'Software' }))
      .toBe('PG1: its kind can never be used, because "Software" is not a canonical industry name a stored industry can resolve to')
    // In another case and padded, it is the same canonical name (control).
    expect(peerProblemsAfter(b => { b.peer_groups[0].industry = ' software PUBLISHERS ' })).toBe('')
  })

  it('PLANTED: a kind no record could ever evidence is refused here: no word on the list, and the kind ends on a word for "a firm"', () => {
    for (const words of [[], ['services', 'solutions'], ['company', 'firms']]) {
      expect(peerProblemsAfter(b => { b.generic_kind_words = words }))
        .toContain('PG1: its kind can never be used, because no word could say a firm is "a software company"')
    }
  })

  it('a missing industry is reported once, by the rule that names it, and not a second time as "not canonical" (control)', () => {
    expect(peerProblemsAfter(b => { b.peer_groups[0].industry = '' }))
      .toBe('PG1: a peer group with a kind names its industry: that is what a prospect is matched on')
  })
})

// peerLabelUnderOpener and the echo test under it (peerLabelEchoes) still exist and are
// exported, but since 2026-10-03 composition and the validators no longer call them: the
// reader's own group is named, and no after-opener label is placed. These tests pin the
// function as it stands for as long as it is exported, against a brief that still gives
// the old field. Delete them with the function.
const withAfterOpener = (): OutboundBrief => {
  const brief = inventedPeerBrief()
  brief.peer_group_default.after_opener = 'Firms like yours'
  return brief
}

describe('peerLabelUnderOpener (no longer called by composition): no word in two sentences in a row', () => {
  it('PLANTED: when the opener and the label share a word, the after-opener label is returned with what it replaced', () => {
    // "Can see you run a software company. Software makers tell us ..." says it twice.
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run a software company', 'software makers'))
      .toEqual({ label: 'Firms like yours', replaced: 'software makers' })
  })

  it('PLANTED: two FORMS of one word are a shared word: "consultancy" then "consultants"', () => {
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run an HR consultancy', 'HR consultants'))
      .toEqual({ label: 'Firms like yours', replaced: 'HR consultants' })
  })

  // The seven pairs the review of 2026-10-02 found standing: the opener and the label plainly
  // say the same thing, and the shared-word test saw nothing. That test (wordsInCommon) reads
  // words of four letters or more, and counts two words as one when they share their opening
  // letters: at least four, and within two of the shorter word's length. So "consulting" and
  // "consultants" (seven letters shared, three short of the shorter), "HR", "IT", "law" and
  // "tax" all went past it. An eighth pair is added for a plural of a three-letter word.
  it.each<[string, string, string]>([
    ['the same acronym, and one stem', 'you run an IT consulting firm', 'IT consultants'],
    ['the same acronym in a clause about the work', 'you provide HR consulting to schools', 'HR consultants'],
    ['the same acronym and nothing else', 'you manage IT for dental clinics', 'IT consultants'],
    ['a three-letter word', 'you run a law firm', 'law firms'],
    ['a three-letter word beside a different ending', 'you run a tax advisory firm', 'tax advisers'],
    ['one stem, two endings', 'you run a recruitment agency', 'recruiters'],
    ['one stem, two endings', 'you run a marketing agency', 'marketers'],
    ['a three-letter word and its plural', 'you handle tax for dentists', 'taxes specialists'],
  ])('PLANTED: %s is an echo: "%s" is not followed by "%s"', (_what, does, label) => {
    expect(peerLabelUnderOpener(withAfterOpener(), does, label)).toEqual({ label: 'Firms like yours', replaced: label })
  })

  it.each<[string, string, string]>([
    // "it" the pronoun is not "IT" the trade: an acronym is matched in capitals only.
    ['a lower-case pronoun spelt like an acronym', 'you make it easy to ship abroad', 'IT consultants'],
    ['only small joining words in common', 'you sell to schools', 'suppliers to hotels'],
    // "firm" stands where a pronoun would, as the repetition rule already holds.
    ['only the word "firm" in common', 'you run a law firm', 'accounting firms'],
    ['words that start alike for fewer than six letters', 'you run a market stall', 'marine engineers'],
  ])('%s is not an echo: the label stays (control)', (_what, does, label) => {
    expect(peerLabelUnderOpener(withAfterOpener(), does, label)).toEqual({ label, replaced: null })
  })

  it('when they share nothing the label is returned unchanged and nothing is replaced (control)', () => {
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run a software company', 'furniture makers and importers'))
      .toEqual({ label: 'furniture makers and importers', replaced: null })
  })

  it('PLANTED: a brief with no after-opener label never replaces, shared word or not', () => {
    const plain = inventedBrief()
    expect(peerLabelUnderOpener(plain, 'you run a software company', 'software makers')).toEqual({ label: 'software makers', replaced: null })
    expect(peerLabelUnderOpener(plain, 'you run an export house', null)).toEqual({ label: null, replaced: null })
    // The same two calls against the brief that has one (control): both are replaced.
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run a software company', 'software makers').replaced).toBe('software makers')
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run an export house', null).replaced).toBe('exporters')
  })

  it('PLANTED: an after-opener label of only spaces is no label: nothing is replaced', () => {
    // The validator refuses it. Composition reads a stored brief, and must not open a pain
    // line on nothing.
    const brief = withAfterOpener()
    brief.peer_group_default.after_opener = '   '
    expect(peerLabelUnderOpener(brief, 'you run a software company', 'software makers')).toEqual({ label: 'software makers', replaced: null })
  })

  it('PLANTED: a null label means the DEFAULT label is what is compared, and what is reported as replaced', () => {
    // A prospect in no peer group gets the default label, "exporters", in the pain line.
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run an export house', null))
      .toEqual({ label: 'Firms like yours', replaced: 'exporters' })
  })

  it('a null label that shares nothing with the opener stays null: the caller still fills the default (control)', () => {
    expect(peerLabelUnderOpener(withAfterOpener(), 'you run a software company', null)).toEqual({ label: null, replaced: null })
  })

  it('PLANTED: the after-opener label is returned without its outer spaces', () => {
    const brief = withAfterOpener()
    brief.peer_group_default.after_opener = '  Firms like yours '
    expect(peerLabelUnderOpener(brief, 'you run a software company', 'software makers').label).toBe('Firms like yours')
  })

  it('the brief is not changed by the call (control)', () => {
    const brief = withAfterOpener()
    peerLabelUnderOpener(brief, 'you run a software company', 'software makers')
    expect(brief).toEqual(withAfterOpener())
  })

  it('the peer fixture as it stands gives no after-opener label, so the function never replaces on it (control)', () => {
    expect(inventedPeerBrief().peer_group_default.after_opener).toBeUndefined()
    expect(peerLabelUnderOpener(inventedPeerBrief(), 'you run a software company', 'software makers')).toEqual({ label: 'software makers', replaced: null })
  })
})

// ── The client's colloquialisms (operator, 2026-10-03) ──
//
// Plain everyday phrases from the client's tone-of-voice document, which the copy may use
// and the idiom list then lets through for that client alone (idiomsFor). Short phrases,
// never sentences: a sentence here would be copy the brief writes for the writer.
describe('validateOutboundBrief: colloquialisms', () => {
  it('a brief with none, or with a short list, validates (control)', () => {
    expect(problemsAfter(b => { delete b.colloquialisms })).toBe('')
    expect(problemsAfter(b => { b.colloquialisms = [] })).toBe('')
    expect(problemsAfter(b => { b.colloquialisms = ['no worries', 'a lot of', 'the right fit for you'] })).toBe('')
  })
  it.each<[string, unknown, string]>([
    ['not a list', 'no worries', 'colloquialisms must be a list of short phrases'],
    ['an empty entry', ['no worries', '  '], 'colloquialisms: every entry is a non-empty phrase'],
    ['an entry that is not text', [5], 'colloquialisms: every entry is a non-empty phrase'],
    ['an entry of six words', ['the right fit for you today'], 'colloquialisms: "the right fit for you today" is a phrase of up to five words, not a sentence'],
    ['an entry with a full stop', ['no worries.'], 'colloquialisms: "no worries." is a phrase of up to five words, not a sentence'],
    ['an entry that is a question', ['all good?'], 'colloquialisms: "all good?" is a phrase of up to five words, not a sentence'],
  ])('PLANTED: colloquialisms that is %s is refused', (_name, value, expected) => {
    expect(problemsAfter(b => { (b as { colloquialisms?: unknown }).colloquialisms = value })).toBe(expected)
  })
})
