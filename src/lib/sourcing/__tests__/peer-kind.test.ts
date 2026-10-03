// The broadest opener rung: "you run <kind>", BUILT from stored data with no model and no
// judge (operator note 1 on the fifth reading, 2026-10-02: "build, don't check").
//
// WHY EVERY REFUSAL IS PLANTED. The rungs above this one have a second model and a page of
// form rules between a wrong sentence and a reader. This one has a lookup. So each thing
// that can make the sentence untrue is planted here, one at a time, against a record that
// is otherwise sound, with a control beside it that gets the sentence. A planted case that
// was refused for some other reason would show as a control that also fails.
//
// THE CLIENT IS INVENTED (the repository is public). Its generic words are exporter,
// export and exporting, its default label is "exporters", and one peer group carries the
// kind "a software company" on the canonical industry "Software Publishers".
//
// LIMIT, stated so this file is not over-trusted: it proves what the function does with a
// record. It does not prove what records the provider stores. Whether a live cohort's names
// and keywords hold the client's words is a measurement, and is made against the database.

import { describe, it, expect } from 'vitest'
import { peerEvidenceWords, peerKindFor, peerKindRecordFromRow, storedKindContradicts, unreachablePeerKinds, type PeerKindRecord } from '../peer-kind'
import { validateOutboundBrief, type OutboundBrief, type PeerGroup } from '@/lib/outbound-brief/brief'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { inventedBrief, inventedPeerBrief } from '@/lib/outbound-templates/__tests__/fixtures/invented-client'

/** A record that gets the sentence from the invented peer brief. Each test changes ONE thing. */
const record = (over: Partial<PeerKindRecord> = {}): PeerKindRecord =>
  ({ name: 'Kessel Exporters', industry: 'Software Publishers', tags: [], ...over })

/**
 * The invented peer brief with one thing changed, and STILL A BRIEF THE VALIDATOR ACCEPTS.
 * Checked here because a refusal from a brief that could never be stored proves nothing
 * about a prospect: only call this inside a test.
 */
const briefWith = (mutate: (brief: OutboundBrief) => void): OutboundBrief => {
  const brief = inventedPeerBrief()
  mutate(brief)
  expect(validateOutboundBrief(brief)).toEqual([])
  return brief
}

/** The first peer group, given another kind and the same industry. */
const withKind = (kind: string) => briefWith(brief => { brief.peer_groups[0].kind = kind })

/** A peer group for a second market, so the head noun of the kind is one that says something. */
const IMPORTER_GROUP: PeerGroup = { id: 'PG1', label: 'furniture importers', industry: 'Wholesale Trade', kind: 'a furniture importer', source: 'invented' }
const importerBrief = () => briefWith(brief => { brief.peer_groups[0] = { ...IMPORTER_GROUP } })

const reasonOf = (decision: ReturnType<typeof peerKindFor>): string => (decision.ok ? 'ok' : decision.reason)

describe('peerKindFor: the sentence and what it rests on', () => {
  it('PLANTED: an exact industry and one of the client\'s generic words in the NAME give "you run <kind>", with the group, the label, the industry and the evidence', () => {
    expect(peerKindFor(inventedPeerBrief(), record())).toEqual({
      ok: true,
      does: 'you run a software company',
      peer_group_id: 'PG1',
      label: 'software makers',
      kind: 'a software company',
      industry: 'Software Publishers',
      evidence: { word: 'exporters', found_in: 'name' },
    })
  })

  it('the same record against the brief with NO kinds gets no sentence: the kind is the client\'s wording or it is nothing (control)', () => {
    expect(peerKindFor(inventedBrief(), record())).toEqual({ ok: false, reason: 'no_kind_for_industry' })
  })

  it('PLANTED: when the name holds none, the evidence is read from a KEYWORD and the decision says so', () => {
    const decision = peerKindFor(inventedPeerBrief(), record({ name: 'Kessel Systems', tags: ['cloud software', 'food exporter'] }))
    expect(decision).toMatchObject({ ok: true, does: 'you run a software company', evidence: { word: 'exporter', found_in: 'tag' } })
  })

  it('a record with no name at all can still be evidenced by a keyword (control)', () => {
    const decision = peerKindFor(inventedPeerBrief(), record({ name: null, tags: ['exporting'] }))
    expect(decision).toMatchObject({ ok: true, evidence: { word: 'exporting', found_in: 'tag' } })
  })

  it('PLANTED: the name is read FIRST, so a record with the word in both says "name"', () => {
    // What is recorded is what a person would be shown when asked why this firm was told it
    // runs a software company. The firm's own name is the stronger answer.
    const decision = peerKindFor(inventedPeerBrief(), record({ tags: ['food exporter'] }))
    expect(decision).toMatchObject({ ok: true, evidence: { word: 'exporters', found_in: 'name' } })
    // The keyword is evidence on its own (control), so the name was a choice between two.
    expect(peerKindFor(inventedPeerBrief(), record({ name: 'Kessel', tags: ['food exporter'] }))).toMatchObject({ ok: true, evidence: { found_in: 'tag' } })
  })

  it('PLANTED: the same keywords with no generic word among them are not evidence', () => {
    expect(reasonOf(peerKindFor(inventedPeerBrief(), record({ name: 'Kessel Systems', tags: ['cloud software', 'tooling'] })))).toBe('kind_not_evidenced')
  })
})

describe('peerKindFor: every reason there is no sentence', () => {
  it('the record every refusal below starts from is one that gets the sentence (control)', () => {
    expect(reasonOf(peerKindFor(inventedPeerBrief(), record()))).toBe('ok')
  })

  it.each([[null], [undefined]])('PLANTED: no record at all (%s) is no_record', missing => {
    expect(peerKindFor(inventedPeerBrief(), missing)).toEqual({ ok: false, reason: 'no_record' })
  })

  it.each<[string, string | null]>([
    ['null', null],
    ['an empty string', ''],
    ['only spaces', '   '],
  ])('PLANTED: a stored industry that is %s is no_stored_industry', (_name, industry) => {
    expect(peerKindFor(inventedPeerBrief(), record({ industry }))).toEqual({ ok: false, reason: 'no_stored_industry' })
  })

  it.each<[string, string]>([
    ['a provider name that is neither canonical nor a known alias', 'Computer Software'],
    // NO SUBSTRING STEP. The stored name CONTAINS the group's industry and is still not it.
    ['a longer name that only contains the canonical one', 'software publishers and more'],
    // The fixture's second peer group stands on this name, and it is not a canonical one.
    ['a name a peer group uses that is not canonical', 'Furniture Manufacturing'],
  ])('PLANTED: %s is industry_not_in_static_table', (_name, industry) => {
    expect(peerKindFor(inventedPeerBrief(), record({ industry }))).toEqual({ ok: false, reason: 'industry_not_in_static_table' })
  })

  it('PLANTED: a canonical industry whose peer group has NO kind is no_kind_for_industry', () => {
    // The second group is moved onto a canonical name, so this is refused for the missing
    // kind and not because the industry could not be read.
    const brief = briefWith(b => { b.peer_groups[1].industry = 'Wholesale Trade' })
    expect(peerKindFor(brief, record({ industry: 'Wholesale Trade' }))).toEqual({ ok: false, reason: 'no_kind_for_industry' })
    // The same brief, the industry that does carry a kind (control).
    expect(reasonOf(peerKindFor(brief, record()))).toBe('ok')
  })

  it('PLANTED: a canonical industry with no peer group at all is no_kind_for_industry', () => {
    expect(peerKindFor(inventedPeerBrief(), record({ industry: 'Legal Services' }))).toEqual({ ok: false, reason: 'no_kind_for_industry' })
  })

  it('PLANTED: a kind that is only spaces is no kind', () => {
    // Not built through briefWith: the validator refuses this brief ("must be a non-empty
    // phrase when it is given"). Composition reads a stored brief, so it is held here too.
    const brief = inventedPeerBrief()
    brief.peer_groups[0].kind = '   '
    expect(validateOutboundBrief(brief).join(' | ')).toContain('PG1: kind must be a non-empty phrase when it is given')
    expect(peerKindFor(brief, record())).toEqual({ ok: false, reason: 'no_kind_for_industry' })
  })

  it('PLANTED: an industry that resolves, a kind for it, and nothing that says it is that kind of firm is kind_not_evidenced', () => {
    expect(peerKindFor(inventedPeerBrief(), record({ name: 'Kessel Labs', tags: ['cloud', 'platform'] }))).toEqual({ ok: false, reason: 'kind_not_evidenced' })
  })
})

describe('peerKindFor: what counts as evidence that it is this kind of firm', () => {
  it('PLANTED: the words BEFORE the head noun are never evidence: "Kessel Software" is not told it runs a software company', () => {
    // The industry has already supplied the field. A name that only repeats the field says
    // nothing about what KIND of firm it is.
    expect(reasonOf(peerKindFor(inventedPeerBrief(), record({ name: 'Kessel Software' })))).toBe('kind_not_evidenced')
    expect(reasonOf(peerKindFor(inventedPeerBrief(), record({ name: 'Kessel Labs', tags: ['software'] })))).toBe('kind_not_evidenced')
  })

  it('the same name with one of the client\'s generic words beside it is evidenced, and by THAT word (control)', () => {
    const decision = peerKindFor(inventedPeerBrief(), record({ name: 'Kessel Software Exporters' }))
    expect(decision).toMatchObject({ ok: true, evidence: { word: 'exporters', found_in: 'name' } })
  })

  it.each<[string, string]>([
    ['a software company', 'Kessel Company'],
    ['a software business', 'Kessel Business'],
    ['a software firm', 'Kessel Firm'],
    ['a software group', 'Kessel Group'],
    ['a software provider', 'Kessel Providers'],
  ])('PLANTED: a head noun that is only a word for "a firm" is not evidence: the kind "%s" is not said to "%s"', (kind, name) => {
    // Every company is a company. Were the head noun evidence here, any firm with
    // "Company" or "Group" in its name would be told what it runs on the industry alone.
    const brief = withKind(kind)
    expect(reasonOf(peerKindFor(brief, record({ name })))).toBe('kind_not_evidenced')
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel', tags: [kind.replace(/^an? /, '')] })))).toBe('kind_not_evidenced')
    // The same kind, a name holding one of the client's words (control).
    expect(peerKindFor(brief, record({ name: `${name} Exporters` }))).toMatchObject({ ok: true, does: `you run ${kind}` })
  })

  it('PLANTED: a head noun that says something IS evidence, by inflection: "Kessel Importers" is told it runs a furniture importer', () => {
    expect(peerKindFor(importerBrief(), record({ name: 'Kessel Importers', industry: 'Wholesale Trade' }))).toEqual({
      ok: true,
      does: 'you run a furniture importer',
      peer_group_id: 'PG1',
      label: 'furniture importers',
      kind: 'a furniture importer',
      industry: 'Wholesale Trade',
      evidence: { word: 'importers', found_in: 'name' },
    })
  })

  it('the head noun is found in a keyword too, and the singular matches as written (controls)', () => {
    const brief = importerBrief()
    expect(peerKindFor(brief, record({ name: null, industry: 'Wholesale Trade', tags: ['flat-pack', 'furniture importer'] })))
      .toMatchObject({ ok: true, evidence: { word: 'importer', found_in: 'tag' } })
    expect(peerKindFor(brief, record({ name: 'Kessel Importer', industry: 'Wholesale Trade' })))
      .toMatchObject({ ok: true, evidence: { word: 'importer', found_in: 'name' } })
  })

  it('PLANTED: with a head noun that says something, the word before it is still not evidence: "Kessel Furniture" is refused', () => {
    expect(reasonOf(peerKindFor(importerBrief(), record({ name: 'Kessel Furniture', industry: 'Wholesale Trade' })))).toBe('kind_not_evidenced')
  })

  it.each<[string, string]>([
    ['a software studio', 'Kessel Studio'],
    ['a software agency', 'Kessel Agency'],
  ])('a weak head noun that is still a kind of firm counts: "%s" is said to "%s" (control)', (kind, name) => {
    // "Studio" and "agency" are not words for a firm in every market, so a reader told
    // "you run an agency" has been told something. Decided where the kind check was written.
    const head = kind.split(' ').pop()
    expect(peerKindFor(withKind(kind), record({ name }))).toMatchObject({ ok: true, evidence: { word: head, found_in: 'name' } })
  })

  it('PLANTED: the measured case. A coarse industry alone would tell a software company it runs an IT consultancy, and the name stops it', () => {
    // The provider's "information technology & services" is a software company as readily
    // as an IT consultancy (the header of peer-kind.ts). This alias is the only route to
    // show it by, because every alias the lookup holds is from that one market.
    const brief = briefWith(b => {
      b.peer_groups.push({ id: 'PG3', label: 'IT consultants', industry: 'Information Technology Consulting', kind: 'an IT consultancy', source: 'invented' })
    })
    const stored = 'information technology & services'
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Software', industry: stored, tags: ['software', 'it'] })))).toBe('kind_not_evidenced')
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel IT', industry: stored })))).toBe('kind_not_evidenced')
    // The same industry, a name that says what kind of firm it is (control).
    expect(peerKindFor(brief, record({ name: 'Kessel Consultancy', industry: stored }))).toEqual({
      ok: true,
      does: 'you run an IT consultancy',
      peer_group_id: 'PG3',
      label: 'IT consultants',
      kind: 'an IT consultancy',
      industry: 'Information Technology Consulting',
      evidence: { word: 'consultancy', found_in: 'name' },
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A KEYWORD THAT NAMES THE FIRM'S CUSTOMERS OR ITS PRODUCT IS NOT EVIDENCE (review of
// 2026-10-02). Until then any evidence word inside any keyword passed, and a provider holds
// dozens of keywords per company: "software for consultants" told a software maker it runs
// an IT consultancy. A keyword now counts only when it is itself a description of the kind
// of firm. The client below is a second invented one, who writes to consultancies.
const consultingBrief = (): OutboundBrief => briefWith(brief => {
  brief.generic_kind_words = ['consulting', 'consultancy', 'consultant', 'consultants', 'advisory', 'adviser', 'advisor']
  brief.peer_groups = [
    { id: 'PG1', label: 'IT consultants', industry: 'Information Technology Consulting', kind: 'an IT consultancy', source: 'invented' },
    { id: 'PG2', label: 'HR consultants', industry: 'Human Resources Consulting', kind: 'an HR consultancy', source: 'invented' },
  ]
})
const IT = 'information technology & services'
const HR = 'human resources'

describe('peerKindFor: a keyword is evidence only when it is itself a description of the kind of firm', () => {
  it('a real consultancy is still told so, by its name or by a keyword that is the kind (controls)', () => {
    expect(peerKindFor(consultingBrief(), record({ name: 'Kessel Consultancy', industry: IT })))
      .toMatchObject({ ok: true, does: 'you run an IT consultancy', evidence: { word: 'consultancy', found_in: 'name' } })
    expect(peerKindFor(consultingBrief(), record({ name: 'Kessel', industry: IT, tags: ['cloud', 'it consultancy'] })))
      .toMatchObject({ ok: true, does: 'you run an IT consultancy', evidence: { word: 'consultancy', found_in: 'tag' } })
    expect(peerKindFor(consultingBrief(), record({ name: 'Marlow People', industry: HR, tags: ['management consulting'] })))
      .toMatchObject({ ok: true, does: 'you run an HR consultancy', evidence: { word: 'consulting', found_in: 'tag' } })
  })

  it.each<[string, string, string, string[]]>([
    ['a keyword naming who the product is FOR', 'Pellwick Systems', IT, ['saas', 'practice management software', 'software for consultants']],
    ['a keyword naming the customers of a product', 'Vantor Ledger', IT, ['crm for financial advisors', 'wealth management software']],
    ['an evidence word that is not the LAST word of its keyword', 'Northtown Cloud', IT, ['saas', 'consulting services', 'billing software', 'api', 'devops', 'analytics']],
    ['a longer keyword with the word inside it', 'Marlow People', HR, ['hr software', 'payroll', 'tools for hr consultants']],
    ['a keyword of four words', 'Kessel Labs', IT, ['independent senior it consultants']],
    ['a keyword joined by "and"', 'Kessel Labs', IT, ['training and consulting']],
    ['a keyword joined by an ampersand', 'Kessel Labs', IT, ['training & consulting']],
    ['a keyword joined by an ampersand with no spaces', 'Kessel Labs', IT, ['training&consulting']],
    ['a keyword holding "to"', 'Kessel Labs', IT, ['alternative to consulting']],
    ['a keyword holding "of"', 'Kessel Labs', IT, ['future of consulting']],
    ['a keyword holding "with"', 'Kessel Labs', IT, ['software with consulting']],
  ])('PLANTED: %s is not evidence, and no sentence is written', (_what, name, industry, tags) => {
    expect(reasonOf(peerKindFor(consultingBrief(), record({ name, industry, tags })))).toBe('kind_not_evidenced')
  })

  it.each<[string, string]>([
    ['one word', 'consulting'],
    ['two words', 'it consultancy'],
    ['three words', 'boutique hr consultancy'],
    ['in capitals, with outer spaces', '  IT Consultancy '],
    ['joined by a hyphen', 'it-consulting'],
  ])('a keyword of %s that ends on the evidence word counts (control)', (_what, tag) => {
    expect(peerKindFor(consultingBrief(), record({ name: 'Kessel Labs', industry: IT, tags: ['cloud', tag] })))
      .toMatchObject({ ok: true, evidence: { found_in: 'tag' } })
  })

  it('KNOWN LIMIT, pinned so the header of peer-kind.ts stays true: a recruiter or broker whose own NAME holds the word, a singular product noun, and a three-word singular keyword still pass', () => {
    // None of them is a consultancy. Nothing in a name or a short singular keyword says so,
    // and the two other layers are what stand behind this: the stored fact's veto at
    // composition (firm-fact-email1.ts) and the operator's read of the list.
    expect(reasonOf(peerKindFor(consultingBrief(), record({ name: 'Northtown Recruitment Consultants', industry: HR })))).toBe('ok')
    expect(reasonOf(peerKindFor(consultingBrief(), record({ name: 'Vantor Benefits Advisory', industry: HR })))).toBe('ok')
    expect(reasonOf(peerKindFor(consultingBrief(), record({ name: 'Pellwick Systems', industry: IT, tags: ['robo advisor'] })))).toBe('ok')
    expect(reasonOf(peerKindFor(consultingBrief(), record({ name: 'Marlow Staffing', industry: IT, tags: ['contract it consultant'] })))).toBe('ok')
  })
})

// THE SECOND TIGHTENING (review of 2026-10-02, round two). Every shape below still told a
// software maker or a staffing firm it runs a consultancy under the first rule: a keyword
// ending on a PLURAL (which usually names the firm's customers or users, not the firm), a
// joining word that was not on the list, or a mark that joins two things.
describe('peerKindFor: a keyword ending on a plural, joined by any joining word or mark, is not evidence', () => {
  it.each<[string, string]>([
    // A plural last word.
    ['a bare customer plural on an HR software record', 'hr consultants'],
    ['a customer plural beside a product keyword', 'financial advisors'],
    ['a plural in the other spelling', 'tax advisers'],
    ['a plural of the "-ies" form', 'it consultancies'],
    ['an adjective and a plural', 'freelance consultants'],
    ['another adjective and a plural', 'independent consultants'],
    ['a verb and a plural', 'hire it consultants'],
    ['another verb and a plural', 'find hr consultants'],
    ['a product and a participle and a plural', 'platform connecting consultants'],
    ['the old known limit, a three-word plural', 'contract it consultants'],
    // A joining word.
    ['"by"', 'software by consultant'],
    ['"in"', 'specialists in consulting'],
    ['"via"', 'billing via consultant'],
    ['"from"', 'apps from advisor'],
    ['"on"', 'advice on consulting'],
    ['"at"', 'help at consultancy'],
    ['"4"', 'tools 4 consultant'],
    ['"For" in capitals', 'Software For Consultant'],
    // A joining mark.
    ['a slash', 'crm/consultant'],
    ['a slash with spaces', 'crm / consultant'],
    ['a plus', 'crm + consultant'],
    ['a bar', 'saas | consultant'],
    ['a comma', 'crm, consultant'],
    ['a word ending in a hyphen', 'crm- consultant'],
    ['a hyphenated plural', 'crm-consultants'],
  ])('PLANTED: %s ("%s") is not evidence, and no sentence is written', (_what, tag) => {
    expect(reasonOf(peerKindFor(consultingBrief(), record({ name: 'Pellwick Systems', industry: IT, tags: ['saas', tag] })))).toBe('kind_not_evidenced')
  })

  it.each<[string]>([
    ['it consultancy'],
    ['management consulting'],
    ['boutique hr consultancy'],
    ['IT Consulting'],
    ['hr advisory'],
    ['it-consulting'],
  ])('a singular keyword with no joining word, "%s", still counts (control)', tag => {
    expect(peerKindFor(consultingBrief(), record({ name: 'Pellwick Systems', industry: IT, tags: ['saas', tag] })))
      .toMatchObject({ ok: true, evidence: { found_in: 'tag' } })
  })

  it('a NAME ending on a plural still counts: the rule is for keywords only (control)', () => {
    expect(peerKindFor(consultingBrief(), record({ name: 'Kessel Consultants', industry: IT })))
      .toMatchObject({ ok: true, evidence: { word: 'consultants', found_in: 'name' } })
  })
})

describe('peerEvidenceWords: the one list of words that say "this kind of firm"', () => {
  it('holds the client\'s own words and a head noun that says something, and never a plain word for "a firm"', () => {
    expect([...peerEvidenceWords(inventedPeerBrief(), 'a software company')].sort()).toEqual(['export', 'exporter', 'exporting'])
    expect([...peerEvidenceWords(importerBrief(), 'a furniture importer')].sort()).toEqual(['export', 'exporter', 'exporting', 'importer'])
    expect([...peerEvidenceWords(consultingBrief(), 'an IT consultancy')]).toContain('consultancy')
  })

  it('PLANTED: is empty for a kind ending on a word for "a firm" when the brief lists no word, or only such words', () => {
    const none = inventedPeerBrief()
    none.generic_kind_words = []
    expect(peerEvidenceWords(none, 'a software company').size).toBe(0)
    const firmWords = inventedPeerBrief()
    firmWords.generic_kind_words = ['company', 'firms']
    expect(peerEvidenceWords(firmWords, 'a software company').size).toBe(0)
    // The same empty list with a head noun that says something (control).
    expect([...peerEvidenceWords(none, 'a software studio')]).toEqual(['studio'])
  })
})

describe('peerKindFor: a generic word is matched by INFLECTION, never as a substring', () => {
  // A client whose list says "ship". The default label's word ("exporters") is still on the
  // list, and no name below holds it.
  const shipBrief = () => briefWith(brief => { brief.generic_kind_words = ['ship'] })

  it.each<[string, string]>([
    ['Kessel Ship', 'ship'],
    ['Kessel Ships', 'ships'],
    ['Kessel Shipping', 'shipping'],
  ])('"%s" holds the word: the plural and the -ing form are the same word (control)', (name, word) => {
    expect(peerKindFor(shipBrief(), record({ name }))).toMatchObject({ ok: true, evidence: { word, found_in: 'name' } })
  })

  it.each<[string]>([
    ['Kessel Township'],
    ['Marlow Partnership'],
    ['Kessel Shipment'],
    ['Kessel Shipper'],
  ])('PLANTED: "%s" does not: the letters of the word inside a longer word are not the word', name => {
    // A substring match would call every "Partnership" a shipping firm. "Shipment" and
    // "shipper" are derivations, and the brief has to list a derivation it means.
    expect(reasonOf(peerKindFor(shipBrief(), record({ name })))).toBe('kind_not_evidenced')
  })

  it('PLANTED: the same holds in a keyword', () => {
    expect(reasonOf(peerKindFor(shipBrief(), record({ name: 'Kessel', tags: ['township planning', 'partnerships'] })))).toBe('kind_not_evidenced')
    // The singular, as a keyword (control). The plural "ships" is not evidence in a keyword
    // since round two of the 2026-10-02 review: a keyword ending on a plural usually names
    // the firm's customers.
    expect(peerKindFor(shipBrief(), record({ name: 'Kessel', tags: ['township planning', 'ship'] })))
      .toMatchObject({ ok: true, evidence: { word: 'ship', found_in: 'tag' } })
    expect(reasonOf(peerKindFor(shipBrief(), record({ name: 'Kessel', tags: ['township planning', 'ships'] })))).toBe('kind_not_evidenced')
  })

  it('PLANTED: a related word with a different ending is a different word: "consulting" on the list does not cover "Consultancy"', () => {
    // The rule the brief states for generic_kind_words: inflection only, and both are listed
    // by a client who means both.
    const brief = briefWith(b => { b.generic_kind_words = ['consulting'] })
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Consultancy' })))).toBe('kind_not_evidenced')
    expect(peerKindFor(brief, record({ name: 'Kessel Consulting' }))).toMatchObject({ ok: true, evidence: { word: 'consulting', found_in: 'name' } })
  })

  it('PLANTED: the head noun is held to the same rule: "Kessel Imports" and "Kessel Importing" are not "importer"', () => {
    const brief = importerBrief()
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Imports', industry: 'Wholesale Trade' })))).toBe('kind_not_evidenced')
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Importing', industry: 'Wholesale Trade' })))).toBe('kind_not_evidenced')
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Importers', industry: 'Wholesale Trade' })))).toBe('ok')
  })
})

describe('peerKindFor: the industry match ignores case and outer spaces, on both sides', () => {
  it('PLANTED: the STORED industry in another case and padded with spaces still resolves, and the canonical spelling is what is returned', () => {
    const decision = peerKindFor(inventedPeerBrief(), record({ industry: '  SOFTWARE publishers  ' }))
    expect(decision).toMatchObject({ ok: true, peer_group_id: 'PG1', industry: 'Software Publishers' })
  })

  it('PLANTED: the BRIEF\'s industry in another case and padded with spaces still matches', () => {
    const brief = briefWith(b => { b.peer_groups[0].industry = '  software PUBLISHERS ' })
    expect(peerKindFor(brief, record())).toMatchObject({ ok: true, peer_group_id: 'PG1', industry: 'Software Publishers' })
    expect(peerKindFor(brief, record({ industry: ' Software Publishers' }))).toMatchObject({ ok: true, peer_group_id: 'PG1' })
  })

  it('PLANTED: a kind padded with spaces is said without them', () => {
    const brief = briefWith(b => { b.peer_groups[0].kind = '  a software company ' })
    expect(peerKindFor(brief, record())).toMatchObject({ ok: true, does: 'you run a software company', kind: 'a software company' })
  })

  it('a different industry is still a different industry (control)', () => {
    expect(reasonOf(peerKindFor(inventedPeerBrief(), record({ industry: '  LEGAL services  ' })))).toBe('no_kind_for_industry')
  })
})

describe('peerKindRecordFromRow: the record, read from a stored prospect row', () => {
  it('PLANTED: reads the name, the industry and organization.keywords, each without its outer spaces', () => {
    expect(peerKindRecordFromRow({
      company_name: ' Kessel Exporters ',
      company_industry: ' Software Publishers ',
      enrichment: { organization: { keywords: ['export tooling', ' freight '] } },
    })).toEqual({ name: 'Kessel Exporters', industry: 'Software Publishers', tags: ['export tooling', 'freight'] })
  })

  it('PLANTED: keywords that are not text, or are empty, are dropped and the rest are kept in order', () => {
    const row = {
      company_name: 'Kessel',
      company_industry: 'Software Publishers',
      enrichment: { organization: { keywords: ['export tooling', 7, null, '', '   ', { word: 'export' }, ['export'], 'freight'] } },
    }
    expect(peerKindRecordFromRow(row)?.tags).toEqual(['export tooling', 'freight'])
  })

  it.each<[string, { company_name?: string | null; company_industry?: string | null; enrichment?: unknown }]>([
    ['both null', { company_name: null, company_industry: null }],
    ['both absent', {}],
    ['both only spaces', { company_name: '  ', company_industry: ' ' }],
    // Keywords alone are nothing to build from: there is no industry to look a kind up by.
    ['keywords and nothing else', { company_name: null, company_industry: '', enrichment: { organization: { keywords: ['export'] } } }],
  ])('PLANTED: a row with neither a name nor an industry (%s) gives null', (_name, row) => {
    expect(peerKindRecordFromRow(row)).toBeNull()
  })

  it('a row with only one of the two still gives a record, with null for the other (control)', () => {
    expect(peerKindRecordFromRow({ company_name: 'Kessel Exporters', company_industry: null })).toEqual({ name: 'Kessel Exporters', industry: null, tags: [] })
    expect(peerKindRecordFromRow({ company_name: ' ', company_industry: 'Software Publishers' })).toEqual({ name: null, industry: 'Software Publishers', tags: [] })
  })

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['null', null],
    ['text', 'not an object'],
    ['a number', 42],
    ['a list', []],
    ['an empty object', {}],
    ['an organization that is null', { organization: null }],
    ['an organization that is text', { organization: 'Kessel' }],
    ['an organization that is a number', { organization: 5 }],
    ['an organization that is a list', { organization: [] }],
    ['keywords that are one string', { organization: { keywords: 'export, freight' } }],
    ['keywords that are null', { organization: { keywords: null } }],
    ['keywords that are an object', { organization: { keywords: { 0: 'export' } } }],
  ])('PLANTED: an enrichment that is %s gives no tags and does not throw', (_name, enrichment) => {
    // Composition builds this record for every prospect before it knows whether the peer
    // rung is even on. A throw here would take composition down for that prospect.
    const row = { company_name: 'Kessel Exporters', company_industry: 'Software Publishers', enrichment }
    expect(() => peerKindRecordFromRow(row)).not.toThrow()
    expect(peerKindRecordFromRow(row)).toEqual({ name: 'Kessel Exporters', industry: 'Software Publishers', tags: [] })
  })

  it('PLANTED: the row and the decision join. A row whose only evidence is a stored keyword gets the sentence', () => {
    // Each half has its own tests above. This is the handoff: the shape one writes is the
    // shape the other reads.
    const row = {
      company_name: 'Kessel Systems',
      company_industry: 'software publishers',
      enrichment: { organization: { keywords: ['cloud software', 'Exporting'] } },
    }
    expect(peerKindFor(inventedPeerBrief(), peerKindRecordFromRow(row)))
      .toMatchObject({ ok: true, does: 'you run a software company', evidence: { word: 'exporting', found_in: 'tag' } })
    // The same row with no stored enrichment (control), and a row with nothing to build from.
    expect(reasonOf(peerKindFor(inventedPeerBrief(), peerKindRecordFromRow({ ...row, enrichment: null })))).toBe('kind_not_evidenced')
    expect(reasonOf(peerKindFor(inventedPeerBrief(), peerKindRecordFromRow({ enrichment: row.enrichment })))).toBe('no_record')
  })
})

describe('unreachablePeerKinds: a kind no prospect could ever be given', () => {
  // NOT built through briefWith: since 2026-10-02 the brief validator calls this function,
  // so a brief with an unreachable kind is refused there. The function is still asked
  // directly here, because composition reads a stored brief that may predate the rule.
  const stored = (mutate: (brief: OutboundBrief) => void): OutboundBrief => {
    const brief = inventedPeerBrief()
    mutate(brief)
    return brief
  }

  it('has a canonical list to compare against at all', () => {
    // Every assertion below that expects "not reported" passes over an empty list too.
    expect(CANONICAL_INDUSTRIES.length).toBeGreaterThan(50)
    expect(CANONICAL_INDUSTRIES).toContain('Software Publishers')
    expect(CANONICAL_INDUSTRIES).not.toContain('Furniture Manufacturing')
  })

  it('PLANTED: a kind on an industry that is not a canonical name is reported, with the group\'s id and the name', () => {
    const brief = stored(b => { b.peer_groups[1].kind = 'a furniture maker' })
    expect(unreachablePeerKinds(brief, CANONICAL_INDUSTRIES)).toEqual([
      'PG2: its kind can never be used, because "Furniture Manufacturing" is not a canonical industry name a stored industry can resolve to',
    ])
    // And the brief validator, which runs free, says the same thing where a person can fix it.
    expect(validateOutboundBrief(brief)).toEqual([
      'PG2: its kind can never be used, because "Furniture Manufacturing" is not a canonical industry name a stored industry can resolve to',
    ])
  })

  it('a kind on a canonical industry is not reported (control)', () => {
    expect(unreachablePeerKinds(inventedPeerBrief(), CANONICAL_INDUSTRIES)).toEqual([])
    expect(unreachablePeerKinds(importerBrief(), CANONICAL_INDUSTRIES)).toEqual([])
  })

  it('PLANTED: what it reports unreachable really is: the same group gets no sentence from a record that names its industry exactly', () => {
    // The report and the lookup are two functions. This holds them to one answer.
    const brief = stored(b => { b.peer_groups[1].kind = 'a furniture maker' })
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Makers Exporters', industry: 'Furniture Manufacturing' })))).toBe('industry_not_in_static_table')
    // Moved onto a canonical name, it is no longer reported and the sentence is written (control).
    const moved = briefWith(b => { b.peer_groups[1].kind = 'a furniture maker'; b.peer_groups[1].industry = 'Wholesale Trade' })
    expect(unreachablePeerKinds(moved, CANONICAL_INDUSTRIES)).toEqual([])
    expect(peerKindFor(moved, record({ name: 'Kessel Makers Exporters', industry: 'Wholesale Trade' }))).toMatchObject({ ok: true, does: 'you run a furniture maker', peer_group_id: 'PG2' })
  })

  it('PLANTED: a group with NO kind is never reported, whatever its industry', () => {
    // The fixture's second group stands on a name that is not canonical and carries no
    // kind. It has no line to be born dark, so there is nothing to report.
    expect(inventedPeerBrief().peer_groups[1]).toMatchObject({ industry: 'Furniture Manufacturing' })
    expect(inventedPeerBrief().peer_groups[1].kind).toBeUndefined()
    expect(unreachablePeerKinds(inventedPeerBrief(), CANONICAL_INDUSTRIES)).toEqual([])
    expect(unreachablePeerKinds(inventedBrief(), CANONICAL_INDUSTRIES)).toEqual([])
    // Against a list that knows NO industry, only the group with a kind is reported.
    expect(unreachablePeerKinds(inventedPeerBrief(), [])).toHaveLength(1)
    expect(unreachablePeerKinds(inventedPeerBrief(), [])[0]).toMatch(/^PG1: /)
    expect(unreachablePeerKinds(inventedBrief(), [])).toEqual([])
  })

  it('PLANTED: the comparison ignores case and outer spaces, as the lookup does', () => {
    const brief = briefWith(b => { b.peer_groups[0].industry = '  software PUBLISHERS ' })
    expect(unreachablePeerKinds(brief, CANONICAL_INDUSTRIES)).toEqual([])
    expect(unreachablePeerKinds(inventedPeerBrief(), ['SOFTWARE PUBLISHERS'])).toEqual([])
    // A different name in the list is still a different name (control).
    expect(unreachablePeerKinds(inventedPeerBrief(), ['Software'])).toHaveLength(1)
  })

  it('PLANTED: a kind with no industry at all is reported, not skipped', () => {
    // The validator refuses this brief. A stored one that predates the rule is still read.
    const brief = inventedPeerBrief()
    delete (brief.peer_groups[0] as { industry?: string }).industry
    const reported = unreachablePeerKinds(brief, CANONICAL_INDUSTRIES)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatch(/^PG1: its kind can never be used/)
  })

  // BORN DARK A SECOND WAY (review of 2026-10-02). The industry resolves, the kind's form is
  // sound, and no word exists that could ever say a firm is this kind: the brief lists none,
  // and the kind ends on a plain word for "a firm". Every prospect was refused as
  // kind_not_evidenced, and nothing anywhere said the line could never be sent.
  it.each<[string, string[]]>([
    ['no generic word at all', []],
    ['only words that are true of any firm', ['company', 'firms']],
  ])('PLANTED: a kind ending on a word for "a firm", in a brief with %s, is reported: nothing could ever evidence it', (_what, words) => {
    const brief = stored(b => { b.generic_kind_words = words })
    const reported = unreachablePeerKinds(brief, CANONICAL_INDUSTRIES)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatch(/^PG1: its kind can never be used, because no word could say a firm is "a software company"/)
    expect(reported[0]).toContain('generic_kind_words')
    // What it reports really is unreachable: a record whose name and keywords hold every
    // word on hand gets no sentence.
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Software Company', tags: ['software company', 'export', 'saas', 'firms'] })))).toBe('kind_not_evidenced')
    // And the brief validator says it too.
    expect(validateOutboundBrief(brief).join(' | ')).toContain('PG1: its kind can never be used, because no word could say a firm is "a software company"')
  })

  it('the same empty list with a kind whose own noun says something is not reported (control)', () => {
    const brief = stored(b => { b.generic_kind_words = []; b.peer_groups[0].kind = 'a software studio' })
    expect(unreachablePeerKinds(brief, CANONICAL_INDUSTRIES)).toEqual([])
    expect(validateOutboundBrief(brief)).toEqual([])
    expect(reasonOf(peerKindFor(brief, record({ name: 'Kessel Studio' })))).toBe('ok')
  })
})

describe('storedKindContradicts: a word of another trade beside the shared one vetoes (merge review, 2026-10-02)', () => {
  const words = { generic_kind_words: ['consulting', 'consultancy', 'consultant', 'advisory'] }
  it.each([
    ['an HR consultancy', 'an HR recruitment consultancy'],
    ['an IT consultancy', 'an IT recruitment consultancy'],
    ['an IT consultancy', 'an IT staffing consultancy'],
    ['a management consultancy', 'a property management consultancy'],
    ['an HR consultancy', 'an HR and payroll consultancy'],
  ])('PLANTED: under "%s", the site\'s "%s" vetoes', (briefKind, stored) => {
    expect(storedKindContradicts(words, briefKind, stored)).toBe(true)
  })
  it.each([
    ['an HR consultancy', 'a boutique HR consultancy'],
    ['an HR consultancy', 'an independent HR consultancy'],
    ['an HR consultancy', 'an HR consulting firm'],
    ['a management consultancy', 'a management consulting firm'],
    ['an HR consultancy', 'HR consultancies'],
    // A kind that names nothing names no other trade either.
    ['a management consultancy', 'a professional firm'],
    ['an HR consultancy', 'an independent company'],
  ])('under "%s", the site\'s "%s" agrees (control)', (briefKind, stored) => {
    expect(storedKindContradicts(words, briefKind, stored)).toBe(false)
  })
})
