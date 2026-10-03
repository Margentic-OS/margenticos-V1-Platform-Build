// The deterministic half of the firm-fact tier, including the build-time cost ceiling.
// Every check has a planted failure and a passing control. All page text is invented.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { FIRM_FACT_JUDGE_PROMPT, FIRM_FACT_EXTRACTION_PROMPT } from '../firm-fact'
import {
  FIRM_FACT_CEILING_USD,
  actualFirmFactCostUsd,
  checkDoesClause,
  checkForWhom,
  decodePageText,
  broadClause,
  checkFirmKind,
  clauseIsGeneric,
  findWordsAbsentFromQuote,
  CARRIER_VERBS,
  identityMatches,
  quoteIsVerbatim,
  unusablePageReason,
  worstCaseFirmFactCostUsd,
  EXTRACTION_MAX_INPUT_TOKENS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  JUDGE_MAX_INPUT_TOKENS,
  JUDGE_MAX_OUTPUT_TOKENS,
  kindIsGeneric,
  SHARED_GENERIC_WORDS,
  sentenceCaseKind,
  kindEndsOnItsNoun,
  kindHoldsAName,
  kindFormReasons,
  kindInQuote,
  ampersandAsAnd,
  clauseForms,
  cutToWordCap,
  firstItemOfList,
  kindHoldsAPreposition,
  sentenceCaseClause,
  specificWordCount,
  isKindVerb,
  kindVerbFor,
  findUnexplainedAcronyms,
  KNOWN_ACRONYM_LIST,
  FIRM_FACT_CHECKS_VERSION,
  type ClauseRepair,
} from '../firm-fact-checks'

const PAGE = decodePageText(
  'Coldharbour Rooms &amp; Storage | Home Services About Contact ' +
  'We design and fit cold rooms for regional food wholesalers and bakeries across the north. ' +
  'Our engineers handle survey, build and servicing. Get a quote today. '.repeat(3),
)

describe('the $0.02 ceiling, enforced by construction (build-time layer)', () => {
  it('the worst case of both calls at their caps, at FULL price, is under $0.02', () => {
    const worst = worstCaseFirmFactCostUsd()
    expect(worst).toBeLessThanOrEqual(FIRM_FACT_CEILING_USD)
    expect(worst).toBeGreaterThan(0.015)   // control: the sum really includes both calls
  })
  it('the reconciliation price matches the construction at the caps', () => {
    const atCaps = actualFirmFactCostUsd(
      { input_tokens: EXTRACTION_MAX_INPUT_TOKENS, output_tokens: EXTRACTION_MAX_OUTPUT_TOKENS },
      { input_tokens: JUDGE_MAX_INPUT_TOKENS, output_tokens: JUDGE_MAX_OUTPUT_TOKENS },
    )
    expect(atCaps).toBeCloseTo(worstCaseFirmFactCostUsd(), 10)
  })
  it('reconciliation sees an over-ceiling call (planted)', () => {
    expect(actualFirmFactCostUsd({ input_tokens: 9000, output_tokens: 300 }, null)).toBeGreaterThan(FIRM_FACT_CEILING_USD)
  })
})

describe('decodePageText', () => {
  it('decodes the entities stored page text carries', () => {
    expect(decodePageText('A &amp; B &#8211; C&#8217;s &nbsp; D')).toBe("A & B - C's D")
  })
})

describe('unusablePageReason', () => {
  it('passes an ordinary page', () => expect(unusablePageReason(PAGE)).toBeNull())
  it('rejects a bot-check page (planted)', () => {
    expect(unusablePageReason('Just a moment... Checking your browser before accessing. ' + 'x '.repeat(200))).toBe('bot_check_page')
  })
  it('rejects page code (planted)', () => {
    expect(unusablePageReason('function a(){var b={};return b;} '.repeat(30))).toBe('page_code_not_text')
  })
  it('rejects a near-empty page (planted)', () => expect(unusablePageReason('Home About')).toBe('page_too_short'))
})

describe('identityMatches', () => {
  it('matches the company on its own page', () => {
    expect(identityMatches('Coldharbour Rooms Ltd', PAGE, 'coldharbourrooms.co.uk')).toBe(true)
  })
  it('matches through the domain alone', () => {
    expect(identityMatches('Coldharbour Rooms Ltd', 'Welcome to our site ' + 'x '.repeat(200), 'https://coldharbourrooms.com')).toBe(true)
  })
  it('rejects a page showing a different company (planted)', () => {
    expect(identityMatches('Brightwater Advisory', PAGE, 'coldharbourrooms.co.uk')).toBe(false)
  })
  // The four real misses of the first live sample, with invented names of the same shape.
  it.each([
    ['an accented name', 'Fêtelle Consulting', 'Fêtelle Consulting | Strategy firm Home About', 'fetelleconsulting.com'],
    ['a site branded with the initials', 'Marlow Harte Partners Inc.', 'MHP Who We Are Our Team What We Do', 'one-mhp.com'],
    ['a two-character name with a digit', 'K7 Consulting', 'K7 Consulting | Leaders through change', 'k7consulting.com'],
    ['a distinctive word that looks generic', 'Collective Payroll Partners', 'Payroll consulting Skip to main content', 'collectivepayroll.com'],
    ['a name with no distinctive token, whole in the domain', 'KT & Associates, Inc.', 'Consulting Home About Contact', 'ktandassociates.com'],
  ])('matches %s', (_n, name, head, url) => {
    expect(identityMatches(name, head + ' ' + 'x '.repeat(100), url)).toBe(true)
  })
  it('does not match on two-letter initials alone (planted)', () => {
    expect(identityMatches('Marlow Harte', 'MH Home About', 'other.com')).toBe(false)
  })
  it('rejects a name with nothing distinctive (fails closed)', () => {
    expect(identityMatches('Consulting Group LLC', PAGE, 'coldharbourrooms.co.uk')).toBe(false)
  })
})

describe('checkDoesClause', () => {
  it('checks a hyphenated compound part by part, not as one invented name', () => {
    const page = PAGE + ' We build AI agent tools.'
    expect(checkDoesClause('you build AI-agent tools for food wholesalers', page).reasons.join(' ')).not.toContain('proper noun')
  })
  it('allows "transformation" as a service name but not "transform" as a verb', () => {
    expect(checkDoesClause('you run transformation projects for food wholesalers', PAGE).reasons.join(' ')).not.toContain('marketing')
    expect(checkDoesClause('you transform cold rooms for food wholesalers', PAGE).reasons.join(' ')).toContain('marketing')
  })
  it('does not read B2B as a number', () => {
    expect(checkDoesClause('you run B2B marketing for food wholesalers', PAGE).reasons).not.toContain('contains a number')
  })
  it('accepts a present-tense verb that merely ends in -ed or -ing', () => {
    // "shred" and "bring" are base forms. Read by ending alone they were "not present tense",
    // and rule 10 forbids writing any other verb in their place.
    for (const clause of ['you shred cold rooms for food wholesalers', 'you bring cold rooms to food wholesalers', 'you feed cold rooms']) {
      expect(checkDoesClause(clause, PAGE).reasons.join(' ')).not.toContain('present-tense')
    }
    // Control: a real past tense or -ing form still fails.
    expect(checkDoesClause('you designed cold rooms', PAGE).reasons.join(' ')).toContain('present-tense')
    expect(checkDoesClause('you designing cold rooms', PAGE).reasons.join(' ')).toContain('present-tense')
  })
  it('passes a plain second-person clause (control)', () => {
    expect(checkDoesClause('you design and fit cold rooms for food wholesalers', PAGE)).toEqual({ ok: true, reasons: [] })
  })
  it.each([
    ['not "you"', 'they design cold rooms for food wholesalers', 'does not start'],
    ['not a verb', 'you are part of a larger engineering group', 'not a present-tense verb'],
    ['too long', 'you design and fit and service and repair cold rooms for food wholesalers today', 'over 12'],
    ['number', 'you design cold rooms for 40 food wholesalers', 'number'],
    ['number word', 'you design cold rooms in three regions', 'number'],
    ['praise', 'you design award-winning cold rooms for food wholesalers', 'praise'],
    ['absence', 'you only design cold rooms for food wholesalers', 'absence'],
    ['time', 'you have designed cold rooms since the eighties', 'not a present-tense verb'],
    ['time word', 'you design cold rooms for newly opened food wholesalers', 'time'],
    ['hedge', 'you design cold rooms for wholesalers, it seems', 'hedge'],
    ['two clauses', 'you design cold rooms, and you service them', 'clause'],
    ['invented name', 'you design cold rooms for Tesco stores', 'proper noun'],
    ['full stop', 'you design cold rooms for food wholesalers.', 'punctuation'],
    ['marketing verb', 'you help food wholesalers navigate cold storage problems', 'marketing'],
    ['marketing noun', 'you provide cold room solutions for food wholesalers', 'marketing'],
    // All three shipped in ONE real clause under checks version 6.
    ['"your" turned round', 'you run your entire cold room operation', 'holds "your"'],
    ['a comma list', 'you design cold rooms, freezers and chillers', 'holds a comma'],
    ['a spaced hyphen', 'you design cold rooms - for food wholesalers', 'dash or ampersand'],
  ])('rejects %s (planted)', (_name, clause, expected) => {
    const v = checkDoesClause(clause, PAGE)
    expect(v.ok).toBe(false)
    expect(v.reasons.join(' | ')).toContain(expected)
  })
})

describe('checkForWhom', () => {
  it('accepts a group that is plural at its head, and AI as a category word', () => {
    expect(checkForWhom('wholesalers adopting AI storage', PAGE + ' AI storage').reasons).toEqual([])
  })
  it('passes a plural category on the page (control)', () => {
    expect(checkForWhom('regional food wholesalers', PAGE).ok).toBe(true)
  })
  it.each([
    ['bare vague', 'businesses', 'bare vague'],
    ['vague in several words', 'corporations and organizations', 'bare vague'],
    ['a range that means everyone', 'small wholesalers to multinational wholesalers', 'a range'],
    ['named organisation', 'Tesco stores', 'named organisation'],
    ['singular', 'food wholesaler', 'not plural'],
    ['too long', 'small and medium regional food wholesalers', 'over 5'],
    ['not on the page', 'dental clinics', 'is on the page'],
  ])('rejects %s (planted)', (_name, phrase, expected) => {
    const v = checkForWhom(phrase, PAGE)
    expect(v.ok).toBe(false)
    expect(v.reasons.join(' | ')).toContain(expected)
  })
})

// What is generic for ONE CLIENT'S list comes from that client's brief. An invented client
// who sells to hauliers: "haulage" is true of every firm it writes to. RULE ZERO: no real
// market's words are in the shared list, so these words mean nothing without CLIENT.
const CLIENT = new Set(['haulage', 'haulier', 'hauliers'])

describe('clauseIsGeneric: an opener must name something', () => {
  it.each([
    'you offer a full range of professional services',
    'you help clients and organisations',
    'you provide services for small businesses',
    'you run a family business',
  ])('"%s" names nothing specific, for any client', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
    expect(checkDoesClause(clause, PAGE + ' ' + clause).reasons.join(' ')).toContain('names nothing specific')
  })
  it.each([
    'you provide procurement and contracting advice',
    'you design and fit cold rooms for food wholesalers',
    'you provide payroll services for care homes',
  ])('"%s" names something (control)', clause => {
    expect(clauseIsGeneric(clause)).toBe(false)
    expect(clauseIsGeneric(clause, CLIENT)).toBe(false)
  })
  it('PLANTED: a clause made of THIS client\'s generic words names nothing, and only for this client', () => {
    const clause = 'you provide haulage services for businesses'
    expect(clauseIsGeneric(clause, CLIENT)).toBe(true)
    expect(checkDoesClause(clause, PAGE + ' ' + clause, CLIENT).reasons.join(' ')).toContain('names nothing specific')
    // The same clause for a client who does not sell to hauliers is the most specific
    // thing on the page. This is the half the old shared list got wrong.
    expect(clauseIsGeneric(clause)).toBe(false)
    expect(checkDoesClause(clause, PAGE + ' ' + clause).reasons.join(' ')).not.toContain('names nothing specific')
  })
  it('a named product or method in the SPECIFIC clause still counts as content', () => {
    expect(clauseIsGeneric('you provide Northwind haulage', CLIENT)).toBe(false)
  })
})

describe('kindIsGeneric: a word about size, ownership, legal form, age or place does not make a kind specific', () => {
  // Every one of these passed at some point: first because the check asked only that ONE
  // word be off the generic list, then because the descriptor list was matched token by
  // token and "mid-size" split into "mid" and a "size" nobody had listed.
  it.each([
    'a small business', 'a limited company', 'a private company', 'a new company', 'a family business',
    'a family-owned firm', 'a family-run business', 'a global firm', 'an independent business', 'a boutique firm',
    'a UK company', 'a Northtown firm',
    'a mid-size company', 'a mid-market company', 'a start-up', 'a startup', 'a limited liability company',
    'a multinational company', 'an SME', 'a B2B company', 'a nonprofit organisation', 'a woman-owned business',
    'a fast-growing firm', 'a privately-held company',
  ])('PLANTED: "%s" names nothing', kind => {
    expect(kindIsGeneric(kind)).toBe(true)
  })
  it.each([
    'a small haulage firm', 'an independent haulier', 'a Northtown haulage business', 'a boutique haulage firm',
    'a haulier', 'a family-run haulage company',
  ])('PLANTED: "%s" names nothing on a list where every firm is one', kind => {
    expect(kindIsGeneric(kind, CLIENT)).toBe(true)
    // Control: for another client the same kind says what the firm does.
    expect(kindIsGeneric(kind)).toBe(false)
  })
  it.each([
    'a dental practice', 'a cold room engineering firm', 'an HR haulage firm', 'a refrigerated haulage firm',
    // A descriptor word that here describes the WORK, not the firm.
    'a family practice', 'a family law firm', 'a private equity firm', 'a public relations agency',
    'a market research company', 'a fast food business',
    // Acronyms for a field of work, as the extraction prompt writes them.
    'a SaaS company', 'an IoT company', 'an IT company', 'an HR practice',
    // ALL-CAPS straight before a firm noun: a field of work, never the lower-case word it
    // happens to spell ("led" as in founder-led, "plc" as in a legal form).
    'an LED company', 'a PLC firm',
    // Weak, and still a kind of firm: these are not words for "a firm" in every market.
    'an agency', 'a studio',
  ])('"%s" names something (control)', kind => {
    expect(kindIsGeneric(kind, CLIENT)).toBe(false)
  })
})

describe('kindEndsOnItsNoun: a kind ends on what the firm IS', () => {
  it.each(['an IT consulting', 'an organizational development consulting', 'a professional IT consulting', 'an environmental consulting', 'a marketing'])(
    'PLANTED: "%s" is the front of a kind with its noun left off', kind => {
      expect(kindEndsOnItsNoun(kind)).toBe(false)
    })
  it.each(['an IT consulting firm', 'an HR consultancy', 'a dental practice', 'a digital marketing agency', 'an art advisory', 'a ring maker', 'a king'])(
    '"%s" ends on its noun (control)', kind => {
      expect(kindEndsOnItsNoun(kind)).toBe(true)
    })
  it('PLANTED: checkFirmKind refuses it, in words that say what is missing', () => {
    const quote = 'We are an IT consulting firm for cold room engineering.'
    const v = checkFirmKind('an IT consulting', quote, PAGE + ' ' + quote)
    expect(v.ok).toBe(false)
    expect(v.reasons.join(' | ')).toContain('ends on a word for the work')
    // Control: with its noun the same kind passes.
    expect(checkFirmKind('an IT consulting firm', quote, PAGE + ' ' + quote).ok).toBe(true)
  })
})

describe('broadClause: the verb is GIVEN, never guessed', () => {
  it.each([
    ['an HR consultancy', 'run', 'you run an HR consultancy'],
    ['a dental practice', 'run', 'you run a dental practice'],
    ['an organisational consultant', 'are', 'you are an organisational consultant'],
    ['a pension adviser', 'are', 'you are a pension adviser'],
  ] as const)('"%s" with "%s"', (kind, verb, clause) => {
    expect(broadClause(kind, verb)).toBe(clause)
  })
  // The second version of this function picked the verb from the ending of the last word
  // (-ant, -er, -or, -ist, -ian). Every kind below names a person and has no such ending,
  // so each shipped as "you run ...". No ending and no list covers every market: the
  // extraction says which verb fits, and the clause carries exactly that.
  it.each(['an executive coach', 'an architect', 'a letting agent', 'a patent attorney', 'an analyst', 'a notary', 'a fractional CFO'])(
    'PLANTED: "%s" takes the verb it is given, whatever its last word ends in', kind => {
      expect(broadClause(kind, 'are')).toBe(`you are ${kind}`)
    })
  it.each(['a restaurant', 'a data center', 'a print shop', 'an engineering contractor'])(
    'PLANTED: an organisation whose word ends like a person\'s ("%s") still takes "run" when told so', kind => {
      expect(broadClause(kind, 'run')).toBe(`you run ${kind}`)
    })
  it('PLANTED: only the two verbs are a verb; anything else is no verb, and no broad line', () => {
    expect(isKindVerb('run')).toBe(true)
    expect(isKindVerb('are')).toBe(true)
    for (const not of ['is', 'Run', 'own', '', null, undefined, true, ['run']]) expect(isKindVerb(not)).toBe(false)
  })
  it('the judge is told about both verbs, in the same words the clause uses', () => {
    expect(FIRM_FACT_JUDGE_PROMPT).toContain('"run" or "are" straight after "you"')
    expect(FIRM_FACT_JUDGE_PROMPT).toContain('"you are a pension adviser"')
  })
  it('the extraction is asked for the verb, and told what the code holds about where a kind ends', () => {
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('"verb":"run" or "are"')
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('It ends on the noun for what the company is, as the page writes it after "a" or "an".')
  })
  it('prompt and check agree about names in a kind: neither allows one', () => {
    // The prompt said "lower case except a name or an acronym" and banned only place names,
    // while the check refused every capitalised word. A rule the model is told it may
    // break and the code then refuses is a paid refusal each time.
    const kindRule = FIRM_FACT_EXTRACTION_PROMPT.split('\n').find(line => line.startsWith('firm_kind:')) ?? ''
    // Not every acronym: the allowed list is stated in this paragraph too (see the acronym
    // tests). Reworded in checks version 23: a short form keeps the page's capitals.
    expect(kindRule).toContain('Write it in lower case, but keep any short form exactly as the page writes it. The only short forms allowed are')
    expect(kindRule).not.toContain('lower case except an acronym')
    expect(kindRule).toContain('no names of places, people, brands or products')
    expect(kindRule).not.toContain('except a name')
    expect(kindHoldsAName('a Northtown bakery')).toBe(true)
  })
  it('WITHDRAWN, and held withdrawn: no "reads as a sentence" question, and no procedure that makes the model answer twice', () => {
    // Both were added under checks version 12 and measured on 77 real prospects the same
    // day. The judge failed "you run a dental practice" against "We are a dental practice".
    // The procedure ("never stop at ... give null") made the extraction write an answer,
    // then "Wait, let me fix", then a second one, and answers were cut off.
    expect(FIRM_FACT_JUDGE_PROMPT).not.toContain('reads_as_a_sentence')
    expect(FIRM_FACT_EXTRACTION_PROMPT).not.toContain('COMPLETE noun phrase')
  })
})

// THE OPERATOR, 2026-10-03: "'you run' for a company, 'you are' only for a person". The verb
// is now decided from the kind's head noun and the record's headcount, not taken from the
// extraction. Every kind here is invented or a plain English noun phrase.
describe('kindVerbFor: "you are" only for a person, "you run" for a company', () => {
  it.each([
    // Endings that make a noun of a person who does something.
    ['an organisational consultant', 1],
    ['an accountant', 1],
    ['a letting agent', 0],
    ['a dentist', 1],
    ['a physician', 1],
    ['a freelance copywriter', 1],
    ['a private tutor', 1],
    // Person nouns with no such ending: the second version said "you run" in front of each.
    ['an executive coach', 1],
    ['a pension adviser', 1],
    ['an architect', 1],
    ['an analyst', 0],
    ['a patent attorney', 1],
    ['a notary', 1],
    ['a fractional CFO', 1],
    ['A Business Coach', 1],
    // The head noun is the word before a preposition.
    ['a coach for founders', 1],
    // A hyphenated head is read by its last part.
    ['a co-founder', 1],
    ['a life-coach', 1],
  ] as const)('PLANTED: "%s" with a headcount of %s is "are"', (kind, headcount) => {
    expect(kindVerbFor(kind, headcount)).toBe('are')
  })

  it.each([
    ['an executive coach', 2],
    ['an organisational consultant', 12],
    ['an analyst', null],
    ['a letting agent', 40],
  ] as const)('PLANTED: a person noun with a headcount of %s ("%s") has no sound verb, so null', (kind, headcount) => {
    // "you are an executive coach" said to a firm of two is wrong, and so is "you run an
    // executive coach". The caller drops the rung.
    expect(kindVerbFor(kind, headcount)).toBeNull()
  })

  it.each([
    ['an HR consultancy'],
    ['a dental practice'],
    ['a print shop'],
    ['an engineering firm'],
    // Nouns that end like a person's and name a firm: the firm list wins over the ending.
    ['a software publisher'],
    ['a restaurant'],
    ['a data center'],
    ['a contract manufacturer'],
    ['a logistics provider'],
    ['a craft brewer'],
    ['a property developer'],
    ['a building supplier'],
    ['a specialist insurer'],
    ['a tier-one supplier'],
    ['a co-packer'],
    ['a provider of cold rooms'],
  ] as const)('PLANTED: "%s" is "run", whatever the headcount', kind => {
    for (const headcount of [0, 1, 2, 50, null]) expect(kindVerbFor(kind, headcount), `${kind} @ ${headcount}`).toBe('run')
  })

  it('an unsound headcount is not one person (control)', () => {
    expect(kindVerbFor('an executive coach', -1)).toBeNull()
    expect(kindVerbFor('an executive coach', Number.NaN)).toBeNull()
    expect(kindVerbFor('an executive coach', 1)).toBe('are')
  })

  it('a contractor is a person by its ending: "are" for one, nothing for a firm of several (control)', () => {
    expect(kindVerbFor('an engineering contractor', 1)).toBe('are')
    expect(kindVerbFor('an engineering contractor', 8)).toBeNull()
  })

  it('the result is a verb broadClause takes (control)', () => {
    const verb = kindVerbFor('a pension adviser', 1)
    expect(verb !== null && isKindVerb(verb)).toBe(true)
    expect(broadClause('a pension adviser', verb ?? 'run')).toBe('you are a pension adviser')
  })
})

describe('a kind must read after its verb: the form checks', () => {
  it.each(['a consultancy and', 'an agency for', 'a firm of', 'a practice with', 'a studio that'])(
    'PLANTED: "%s" ends on a joining word', kind => {
      expect(kindEndsOnItsNoun(kind)).toBe(false)
      expect(kindFormReasons(kind, null).join(' | ')).toContain('joining word')
    })

  // THE QUOTE MUST SAY THE KIND: its words together, in order, with "a", "an", "the" or a
  // form of "be" in front, and the noun phrase ending where the kind ends.
  it.each([
    ['a web design', 'We are a web design studio in Northtown.'],
    ['a wealth management', 'Northtown is a wealth management firm for families.'],
    ['a recruitment', 'We are a recruitment agency.'],
    // Title Case on the page: the kind was lowered, its quote was not.
    ['a web design', 'Northtown: A Web Design Studio'],
    // Said twice, once as a heading and once carried on: neither says the kind.
    ['a pest control', 'Pest control. We are a pest control company.'],
    // An -ing word after the kind, closing on a noun for a firm: the phrase ran on. Under
    // version 12 this was a known limit left to the judge.
    ['a cold room', 'We are a cold room engineering firm.'],
    ['an HR', 'Northtown is an HR consulting firm for charities.'],
    // A JOINING WORD OR A LIST MARK IS NOT AN ENDING BY ITSELF. Each of these passed under
    // version 14, and for a kind too long for the word cap the cut-short form was the only
    // one that passed. Found by an attack on the rule, 2026-10-01.
    ['a web design', 'We are a web design and digital marketing agency.'],
    ['a recruitment', 'We are a recruitment and training company.'],
    ['a logistics', 'We are a logistics or freight forwarding company.'],
    ['a design', 'We are a design, build and fit-out contractor.'],
    ['a design', 'We are a design/build firm.'],
    ['a haulage', 'We are a haulage (and storage) company.'],
    // An all-caps word carries the phrase on.
    ['a digital', 'We are a digital PR agency.'],
    ['a commercial', 'We are a commercial HVAC contractor.'],
    // -ing words and then ONE singular word: the noun phrase, not a verb and its object.
    ['a commercial', 'We are a commercial lending broker.'],
    ['a cold room', 'We are a cold room engineering contractor.'],
    // ...and a longer run that closes on a noun for a firm, with a plain word in the middle.
    ['a cold room', 'We are a cold room building services company.'],
    // THE COST, accepted: code cannot tell two kinds joined from one kind with two fields,
    // nor a mass noun from a head noun. Both fail to the template.
    ['a bakery', 'We are a bakery and cafe.'],
    ['a charity', 'We are a charity providing support.'],
  ])('PLANTED: "%s" stops before its noun, and its quote shows it', (kind, quote) => {
    expect(kindInQuote(kind, quote)).toBe('carried_on')
    expect(kindFormReasons(kind, quote).join(' | ')).toContain('stops before its noun')
  })
  it.each([
    // A heading, or the firm's own name: the words stand together and nothing says the firm
    // IS that. This is where a kind with its noun left off comes from when its quote stops
    // short too: one real stored kind under version 11 was exactly this.
    ['a board search', 'Northtown Board Search'],
    ['an art advisory', 'Art advisory'],
    ['a print shop', 'Award-winning print shop.'],
    // About the field, not a statement that the firm is one.
    ['a safety consultancy', 'We are the industry leaders in safety consultancy, training and development.'],
    ['a print shop', 'We sell to every print shop in Northtown.'],
    // A form of "be" close by, with a preposition between it and the kind: the firm is
    // "leaders IN" the field, which is not the firm being one.
    ['a safety consultancy', 'We are leaders in safety consultancy.'],
    // A form of "be" too far back to be introducing the kind: it belongs to another clause.
    ['a print shop', 'It is what every good local print shop in Northtown wants.'],
    // The introducer is in another sentence.
    ['a print shop', 'This is what we are. Print shop for small presses.'],
  ])('PLANTED: "%s" is in its quote and the quote does not say the firm is one', (kind, quote) => {
    expect(kindInQuote(kind, quote)).toBe('not_introduced')
    expect(kindFormReasons(kind, quote).join(' | ')).toContain('a heading or a name')
  })
  it.each([
    ['a design studio', 'Our studio does design.'],
    ['an HR consultancy', 'We are a leading HR and payroll consultancy.'],
    // Glued to a hyphenated prefix that changes what it means.
    ['an executive search firm', 'We are a non-executive search firm.'],
    ['a fraud consultancy', 'We are an anti-fraud consultancy.'],
  ])('PLANTED: "%s" is a recomposition: its words are in the quote and not together', (kind, quote) => {
    expect(kindInQuote(kind, quote)).toBe('absent')
    expect(kindFormReasons(kind, quote).join(' | ')).toContain('in those words, in that order')
  })
  it.each([
    ['a web design studio', 'We are a web design studio in Northtown.'],
    ['a dental practice', 'We are a dental practice serving local families.'],
    ['a dental practice', 'We are a dental practice serving local firms and schools.'],
    ['a law firm', 'A law firm dedicated to small charities.'],
    ['a print shop', 'We are a print shop, and we bind books too.'],
    ['a print shop', 'We are a print shop'],
    // Punctuation alone ends the phrase: what follows is a plain lower-case noun, which
    // would otherwise read as the kind carrying on.
    ['a print shop', 'We are a print shop; books are bound here.'],
    ['a print shop', 'A print shop | books and bindings'],
    ['a print shop', 'We are a print shop (open six days).'],
    ['a dental practice', 'We are a dental practice, open six days a week.'],
    // Any number of describing words code can see between the introducer and the kind.
    ['a bakery', 'We are a small, friendly, family-run bakery.'],
    ['a bakery', 'We are an award-winning, independent, employee-owned bakery.'],
    ['a haulage company', 'We are a leading independent family-owned haulage company.'],
    // Ordinary words that open what is said next.
    ['a bakery', 'We are a bakery just outside Northtown.'],
    ['a law firm', 'We are a law firm proud to serve small charities.'],
    // A verb and its object: the object is plural, or other words sit between.
    ['a courier company', 'We are a courier company serving local shops.'],
    ['a consultancy', 'We are a consultancy helping charities grow.'],
    ['a haulage company', 'A haulage company that moves chilled food.'],
    ['a design studio', 'We are a design studio proudly owned by its staff.'],
    ['a bakery', 'A bakery run by three sisters.'],
    // A new name starting after a lower-case kind is not the kind carrying on.
    ['a digital agency', 'We are a digital agency Northtown trusts.'],
    // The praise the kind left out sits between the introducer and the kind.
    ['an HR consultancy', 'Northtown is a leading HR consultancy dedicated to charities.'],
    ['a talent firm', 'Northtown is a boutique, independent talent firm.'],
    // Introduced by a form of "be" with no article: the page's slip, and still a statement.
    ['a sustainability consultant', 'We are award-winning sustainability consultant helping charities.'],
    ['a print shop', "We're a print shop."],
    ['a print shop', 'Northtown, the print shop for small presses.'],
    // Said twice: one occurrence that says it is enough.
    ['a design agency', 'We are a design agency. Our design agency team is small.'],
  ])('"%s" is said by its quote (control)', (kind, quote) => {
    expect(kindInQuote(kind, quote)).toBe('said')
    expect(kindFormReasons(kind, quote)).toEqual([])
  })

  it('PLANTED: a word the page only ever capitalises is left in the kind and the kind is refused', () => {
    // sentenceCaseKind lowers what the page writes in lower case. What is left is a name,
    // or a heading's word, and either way the opener would carry a capital mid-sentence.
    expect(kindHoldsAName('a design Consultancy')).toBe(true)
    expect(kindHoldsAName('a Northtown dental practice')).toBe(true)
    expect(kindHoldsAName('a Northtown-based practice')).toBe(true)
    expect(kindFormReasons('a design Consultancy', null).join(' | ')).toContain('only ever capitalises')
  })
  it.each(['a design consultancy', 'an HR consultancy', 'a SaaS company', 'an IT firm', 'a B2B agency', 'an AI-led studio'])(
    '"%s" holds no name (control)', kind => {
      expect(kindHoldsAName(kind)).toBe(false)
    })

  it('PLANTED: checkFirmKind refuses each form fault, and passes the same kind once it is whole', () => {
    const quote = 'We are a web design studio in Northtown.'
    const source = PAGE + ' ' + quote
    expect(checkFirmKind('a web design', quote, source).reasons.join(' | ')).toContain('stops before its noun')
    expect(checkFirmKind('a Northtown web design studio', quote, source).reasons.join(' | ')).toContain('only ever capitalises')
    expect(checkFirmKind('a web design studio', quote, source)).toEqual({ ok: true, reasons: [] })
  })
})

describe('a kind made only of words for "a firm" names nothing', () => {
  it.each([
    'a limited liability partnership', 'an independent provider', 'a local provider', 'an independent group',
    'a small team', 'a private partnership', 'a group', 'a provider', 'a new venture', 'a family-run operation',
    // A legal form closing the kind describes the firm and nothing else.
    'an LLP', 'a PLC', 'a limited liability LLP',
  ])('PLANTED: "%s"', kind => {
    expect(kindIsGeneric(kind)).toBe(true)
  })
  it.each([
    // The same acronyms as a field of work, with something after them.
    'a PLC programming firm', 'an LP pressing plant',
    // The same nouns with a word that says what the firm does.
    'a haulage group', 'a broadband provider', 'a design partnership',
  ])('"%s" names something (control)', kind => {
    expect(kindIsGeneric(kind)).toBe(false)
  })
  it('a firm noun is generic in a KIND only: in a specific clause it is an ordinary word (control)', () => {
    expect(clauseIsGeneric('you train provider teams')).toBe(false)
  })
})

describe('sentenceCaseKind: a kind in the case of running prose', () => {
  const PAGE_TEXT = 'Northtown Design Consultancy. We are a Design Consultancy based in Northtown. Good design changes how people work. Our consultancy has an HR arm and a SaaS product.'
  it('PLANTED: a Title Case kind is lowered where the page uses the word in lower case', () => {
    expect(sentenceCaseKind('a Design Consultancy', PAGE_TEXT)).toBe('a design consultancy')
    expect(sentenceCaseKind('A Design Consultancy', PAGE_TEXT)).toBe('a design consultancy')
  })
  it('PLANTED: a name keeps its capital, because the page never writes it in lower case', () => {
    expect(sentenceCaseKind('a Northtown Design Consultancy', PAGE_TEXT)).toBe('a Northtown design consultancy')
  })
  it('leaves acronyms and lower-case words as they are (control)', () => {
    expect(sentenceCaseKind('an HR Consultancy', PAGE_TEXT)).toBe('an HR consultancy')
    expect(sentenceCaseKind('a SaaS consultancy', PAGE_TEXT)).toBe('a SaaS consultancy')
    expect(sentenceCaseKind('a design consultancy', PAGE_TEXT)).toBe('a design consultancy')
  })
  it('a word the page only ever capitalises stays capitalised', () => {
    expect(sentenceCaseKind('a Logistics Consultancy', PAGE_TEXT)).toBe('a Logistics consultancy')
  })
  it('PLANTED: an email address or a link is not the page using the word in lower case', () => {
    // The first version looked anywhere in the text. A firm's own name sits in lower case
    // in its address and its links, so the name was lowered and then no longer read as one.
    const withAddresses = 'Northtown Consultancy. Write to hello@northtown-design.example or see www.northtown.example/about and https://northtown.example. Our consultancy is small.'
    expect(sentenceCaseKind('a Northtown Consultancy', withAddresses)).toBe('a Northtown consultancy')
    // Control: the same word in a sentence does lower it.
    expect(sentenceCaseKind('a Northtown Consultancy', withAddresses + ' We love northtown.')).toBe('a northtown consultancy')
  })
  it('PLANTED: lowered, a real kind is no longer read as a name and refused', () => {
    const client = new Set(['consultancy', 'consulting'])
    // As the page wrote it, every word that says what the firm does is taken for a name.
    expect(kindIsGeneric('a Design Consultancy', client)).toBe(true)
    expect(kindIsGeneric(sentenceCaseKind('a Design Consultancy', PAGE_TEXT), client)).toBe(false)
    // Control: the place is still a name, so a kind that is only a place still names nothing.
    expect(kindIsGeneric(sentenceCaseKind('a Northtown Consultancy', PAGE_TEXT), client)).toBe(true)
  })
})

describe('a descriptor is set aside only where it describes the FIRM', () => {
  it.each([
    'you provide private client services', 'you provide family support services', 'you support young people',
    'you support women', 'you provide employee support', 'you build new homes',
    // All-caps is a field of work, never read as the lower-case legal form or ownership word.
    'you provide PLC support', 'you provide LED services',
  ])('"%s" names something (the first version read these as naming nothing)', clause => {
    expect(clauseIsGeneric(clause)).toBe(false)
  })
  it.each([
    'you provide services for small businesses', 'you run a family business', 'you help large organisations',
  ])('PLANTED: "%s" still names nothing', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
  })
})

describe('the client\'s generic words match by inflection, and only by inflection', () => {
  it('PLANTED: the plural a person writes covers the singular a page uses', () => {
    const label = new Set(['exporters'])
    expect(kindIsGeneric('an exporter', label)).toBe(true)
    expect(clauseIsGeneric('you help exporters', label)).toBe(true)
    // "exporting" is built on a different stem ("export", not "exporter"): not an
    // inflection, so it is not covered and has to be listed in the brief.
    expect(kindIsGeneric('an exporting business', label)).toBe(false)
    expect(kindIsGeneric('an exporting business', new Set(['exporters', 'export']))).toBe(true)
    // Control: with no client words the same kind is the most specific thing on the page.
    expect(kindIsGeneric('an exporter')).toBe(false)
  })
  it('a related word with a different ending is a different word and must be listed', () => {
    expect(kindIsGeneric('a haulage firm', new Set(['haulier']))).toBe(false)
    expect(kindIsGeneric('a haulage firm', new Set(['haulier', 'haulage']))).toBe(true)
  })
})

describe('Rule Zero on the shared generic list', () => {
  // The shared list held one market's words until 2026-10-01. Stems, so no form comes back.
  const MARKET_STEMS = ['consult', 'advis', 'advic', 'coach', 'agenc', 'referral']
  it('PLANTED: holds no market\'s words', () => {
    const found = [...SHARED_GENERIC_WORDS].filter(word => MARKET_STEMS.some(stem => word.includes(stem)))
    expect(found).toEqual([])
  })
  it('the check can see one (control)', () => {
    expect(MARKET_STEMS.some(stem => 'advisory'.includes(stem))).toBe(true)
    expect(SHARED_GENERIC_WORDS.has('services')).toBe(true)
  })
})

describe('checkFirmKind: the broad line of the ladder', () => {
  const QUOTE = 'We are a cold room engineering firm for food wholesalers.'
  const SOURCE = PAGE + ' ' + QUOTE
  it('passes a kind built from its quote (control), and reads as a clause the opener can carry', () => {
    expect(checkFirmKind('a cold room engineering firm', QUOTE, SOURCE)).toEqual({ ok: true, reasons: [] })
    expect(broadClause('a cold room engineering firm', 'run')).toBe('you run a cold room engineering firm')
  })
  it.each([
    ['no article', 'cold room engineering firm', 'does not start with "a" or "an"'],
    ['nothing after the article', 'a', 'names no kind of firm'],
    ['too long', 'a cold room engineering firm for food wholesalers', 'over 6'],
    ['a word its quote does not hold', 'a cold room design firm', 'not in the quote: design'],
    ['praise', 'a leading cold room engineering firm', 'praise word'],
    ['a number', 'a top 10 engineering firm', 'contains a number'],
    ['a comma', 'a cold room, engineering firm', 'punctuation'],
    ['an invented name', 'a Tesco engineering firm', 'proper noun'],
    ['nothing specific', 'a firm', 'names nothing specific'],
    ['nothing specific, with a word about its size', 'a small firm', 'names nothing specific'],
    ['nothing specific on this client\'s list', 'a haulage firm', 'names nothing specific'],
    ['"your"', 'a firm for your rooms', 'holds "you" or "your"'],
  ])('refuses %s (planted)', (_name, kind, expected) => {
    // The quote also holds the generic kinds, so those cases fail for naming nothing and
    // not for a word missing from their quote.
    const v = checkFirmKind(kind, `${QUOTE} We are a small haulage firm.`, SOURCE, CLIENT)
    expect(v.ok).toBe(false)
    expect(v.reasons.join(' | ')).toContain(expected)
  })
  it('the client\'s generic words reach the kind check: without them the same kind passes', () => {
    const quote = `${QUOTE} We are a haulage firm.`
    expect(checkFirmKind('a haulage firm', quote, SOURCE + ' ' + quote, CLIENT).ok).toBe(false)
    expect(checkFirmKind('a haulage firm', quote, SOURCE + ' ' + quote).ok).toBe(true)
  })
})

describe('checkForWhom: only a SPECIFIC customer group (rule 9)', () => {
  it.each([
    ['a determiner in front of a bare category', 'our clients'],
    ['the reader as the determiner', 'your customers'],
    ['two bare category nouns, one in the singular', 'business owners'],
  ])('rejects %s as vague', (_name, phrase) => {
    // "our clients" passed as specific, and in the sender's offer it reads as the SENDER's.
    expect(checkForWhom(phrase, PAGE + ` ${phrase}`).reasons.join(' ')).toContain('bare vague category')
  })
  it('still passes a qualified group (control)', () => {
    expect(checkForWhom('regional food wholesalers', PAGE).reasons).toEqual([])
  })
  it.each(['food & beverage brands', 'bakers, grocers and caterers', 'cafes -- and bakeries'])('rejects "%s": it would break a style rule inside the offer', phrase => {
    expect(checkForWhom(phrase, PAGE + ` ${phrase}`).reasons.join(' ')).toContain('ampersand, a dash or a comma')
  })
})

describe('quoteIsVerbatim', () => {
  it('accepts a span of the page, entity-decoded and case-insensitive', () => {
    expect(quoteIsVerbatim('We design and fit cold rooms for regional food wholesalers', PAGE)).toBe(true)
  })
  it('rejects a paraphrase (planted)', () => {
    expect(quoteIsVerbatim('We build cold rooms for food wholesalers', PAGE)).toBe(false)
  })
})

describe('findWordsAbsentFromQuote (operator rule 10)', () => {
  // The two must-fail controls, as invented clauses of the same shape as the real ones:
  // an added noun where the quote names something plainer, and an added verb.
  it('fails an added noun: "automation systems" where the quote says "systems"', () => {
    const absent = findWordsAbsentFromQuote(
      'you design and implement storage strategy and automation systems',
      'We build storage strategy and systems to help small teams grow.',
    )
    expect(absent).toContain('automation')
  })
  it('fails an added verb: "select and implement" where the quote says "streamline" and "implement"', () => {
    const absent = findWordsAbsentFromQuote(
      'you help wholesalers select and implement stock management technology',
      'we partner with you to streamline your stock processes and implement stock management technology',
    )
    expect(absent).toContain('select')
    expect(absent).not.toContain('implement')
    expect(absent).not.toContain('help')   // a carrier verb straight after "you"
  })
  it('passes a clause built from the quote\'s own words (control)', () => {
    expect(findWordsAbsentFromQuote(
      'you provide cold storage design and servicing for regional bakeries',
      'We help regional bakeries with cold storage design and servicing.',
    )).toEqual([])
  })
  // INFLECTION ONLY: a plural, a tense, an -ing form. Each pair is checked both ways round.
  it.each([
    ['bakeries', 'bakery'], ['organise', 'organize'], ['make', 'making'], ['plan', 'planning'],
    ['run', 'running'], ['fit', 'fitted'], ['hire', 'hiring'], ['use', 'using'], ['use', 'used'],
    ['supply', 'supplied'], ['manage', 'manages'], ['design', 'designing'], ['box', 'boxes'],
    ['build', 'built'], ['sell', 'sold'], ['model', 'modelling'], ['shred', 'shreds'],
  ])('treats %s and %s as one word', (a, b) => {
    expect(findWordsAbsentFromQuote(`you help ${a}`, `we help ${b}`)).toEqual([])
    expect(findWordsAbsentFromQuote(`you help ${b}`, `we help ${a}`)).toEqual([])
  })
  // DIFFERENT WORDS ON ONE STEM. The first matcher accepted any pair of endings, the
  // derivational ones included, and called every pair from "leadership" down one word
  // (found by review, 2026-10-01). The second group are the short-stem collisions an
  // ending rule produces when it has no minimum stem.
  it.each([
    ['employees', 'employers'], ['executive', 'execution'], ['succession', 'success'],
    ['health', 'healthcare'], ['founder', 'foundation'], ['interim', 'international'],
    ['leadership', 'leaders'], ['general', 'generation'], ['police', 'policy'], ['medical', 'medication'],
    ['form', 'formal'], ['person', 'personal'], ['intern', 'internal'], ['place', 'placement'],
    ['accounts', 'accountancy'], ['part', 'party'], ['sign', 'signal'], ['class', 'classic'],
    ['install', 'installation'], ['grow', 'growth'], ['strategy', 'strategic'],
    ['cars', 'care'], ['cares', 'cars'], ['buses', 'busy'], ['taps', 'tape'], ['feed', 'fees'], ['plan', 'plane'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(findWordsAbsentFromQuote(`you help ${a}`, `we help ${b}`)).toEqual([a])
    expect(findWordsAbsentFromQuote(`you help ${b}`, `we help ${a}`)).toEqual([b])
  })
  it('never reads a word ending in -ing as a short word plus an ending', () => {
    // "thing" is not "the" plus -ing: the quote holds "the", and "thing" is still absent.
    expect(findWordsAbsentFromQuote('you make one thing', 'We make the best of one')).toEqual(['thing'])
  })
  it('KNOWN LIMIT: an -ing noun and its verb are one word here (the judge is the second gate)', () => {
    expect(findWordsAbsentFromQuote('you help firms with marketing', 'We help firms enter a market')).toEqual([])
  })
  it('does not skip a lower-case "it": a clause that says "it support" needs it in the quote', () => {
    expect(findWordsAbsentFromQuote('you provide it support for schools', 'We support schools')).toEqual(['it'])
  })
  it('requires an acronym in capitals, so IT never matches the pronoun', () => {
    expect(findWordsAbsentFromQuote('you provide IT support', 'it is our job to support you')).toEqual(['IT'])
    expect(findWordsAbsentFromQuote('you provide IT support', 'Our IT support keeps you running')).toEqual([])
  })
  it('exempts a carrier verb only straight after "you"', () => {
    expect(findWordsAbsentFromQuote('you design and provide cold rooms', 'We design cold rooms')).toEqual(['provide'])
    expect(findWordsAbsentFromQuote('you provide cold rooms', 'We design cold rooms')).toEqual([])
  })
  it('exempts only "help" and "provide": deliver, offer and support are real services', () => {
    expect(CARRIER_VERBS).toEqual(['help', 'provide'])
    expect(findWordsAbsentFromQuote('you deliver parcels for couriers', 'We build software that tracks parcels for couriers.')).toEqual(['deliver'])
    expect(findWordsAbsentFromQuote('you support school systems', 'We sell school systems.')).toEqual(['support'])
    expect(findWordsAbsentFromQuote('you offer cold rooms', 'We design cold rooms')).toEqual(['offer'])
  })
  it('checks a customer group with no carrier exemption', () => {
    expect(findWordsAbsentFromQuote('regional food wholesalers', 'We design cold rooms for wholesalers.', { carrierAfterYou: false }))
      .toEqual(['regional', 'food'])
    expect(findWordsAbsentFromQuote('food wholesalers', 'We design cold rooms for food wholesalers.', { carrierAfterYou: false })).toEqual([])
    // "provide" as the second word of a group is content, not a carrier.
    expect(findWordsAbsentFromQuote('firms provide care', 'We work with care firms.', { carrierAfterYou: false })).toEqual(['provide'])
  })
})

describe('repair by removal (checks version 16): a clause is cut before it is refused', () => {
  describe('firstItemOfList', () => {
    it.each([
      ['you provide digital marketing, website design, and creative brand development', 'you provide digital marketing'],
      ['you deliver executive coaching, leadership assessments, and conflict resolution', 'you deliver executive coaching'],
      ['you provide interim CIO leadership, technology consulting, and business process improvement', 'you provide interim CIO leadership'],
      // A list of verb phrases: the first stands on its own.
      ['you provide fractional CIO leadership to stabilize operations, align teams, and drive execution', 'you provide fractional CIO leadership to stabilize operations'],
      // Single-word items, and the last is a single word too: no noun at the end is shared.
      ['you provide talent optimization, change management, facilitation, and coaching', 'you provide talent optimization'],
      ['you specialise in business exits, disposals, acquisitions and fundraising', 'you specialise in business exits'],
    ])('PLANTED: "%s" -> "%s"', (clause, first) => {
      expect(firstItemOfList(clause)).toBe(first)
    })
    it.each([
      // DESCRIBING WORDS that share the noun at the end: cut at the comma they are not a phrase.
      'you help organizations create committed, effective, and sustainable cultures',
      'you provide accounting, financial, and transaction advisory',
      'you provide training, coaching, and HR consulting',
      // The first item is one word after its verb: too little to stand as a clause.
      'you help leaders, teams, and organizations get aligned and moving forward',
      // DESCRIBING PHRASES of two words each: every item is a phrase, and the cut still
      // reads "you help organisations build fair". The first item does not end on a noun.
      'you help organisations build fair, market aligned, and motivating reward structures',
      // A noun with no noun's ending is not cut either: code cannot tell it from the above.
      'you provide website design, brand strategy, and content writing',
      // No list at all.
      'you design and fit cold rooms for food wholesalers',
      // VERSION 20. A first item ending -ing or -ure that is a DESCRIBING word: each of
      // these was cut to a clause ending on it ("you help schools run engaging").
      'you help schools run engaging, inclusive and well attended events',
      'you help housing associations build secure, simple to use and low cost tenant portals',
      'you help leadership teams create lasting, measurable change programmes',
      // A head that needs both sides of what follows it.
      'you bridge the gap between finance teams, IT and operations',
      'you handle everything from planning applications, to building control and handover',
      'you offer a mix of site surveys, drone mapping and soil testing',
    ])('PLANTED: "%s" is not cut (it would not stand, or there is nothing to cut)', clause => {
      expect(firstItemOfList(clause)).toBeNull()
    })
  })

  describe('cutToWordCap', () => {
    it.each([
      // "a pragmatic roadmap" has no noun's form, so the cut before it is taken (version 20).
      ['you partner with investors and management teams to create a pragmatic roadmap for future success', 'you partner with investors and management teams'],
      ['you work with senior executives and investors to accelerate operational effectiveness through performance improvement and transformational leadership', 'you work with senior executives and investors to accelerate operational effectiveness'],
      ['you manage the IT for small accountancy practices so that partners can spend time with clients', 'you manage the IT for small accountancy practices'],
      ['you supply and install commercial kitchens for a wide range of hotels and restaurants today', 'you supply and install commercial kitchens'],
      ['you help engineering firms recruit apprentices and graduates by working with local colleges and schools', 'you help engineering firms recruit apprentices and graduates'],
      ['you help care homes that want to recruit and keep nurses and support staff', 'you help care homes'],
      // "charities working [with ...]": an -ing word after a plural is what those people do.
      ['you write grant applications for small charities working with young people in coastal towns today', 'you write grant applications'],
      // Control: after a describing word or a singular, an -ing word names a service.
      ['you provide dental equipment servicing in order to keep practices compliant with current regulations', 'you provide dental equipment servicing'],
    ])('PLANTED: "%s" is cut at the last trailing phrase that leaves it ending on a noun', (clause, cut) => {
      const out = cutToWordCap(clause)
      expect(out).toBe(cut)
      expect(out!.split(/\s+/).length).toBeLessThanOrEqual(12)
    })
    it('leaves a clause at or under the cap alone, and returns null where no cut stands (controls)', () => {
      expect(cutToWordCap('you design and fit cold rooms for regional food wholesalers and bakeries')).toBeNull()
      // Thirteen words and no trailing phrase to cut at.
      expect(cutToWordCap('you design build test ship install repair service clean paint polish wrap deliver')).toBeNull()
      // A cut that would leave fewer than four words is not a clause.
      expect(cutToWordCap('you help with everything a growing regional haulage business might ever possibly need today')).toBeNull()
    })
    it.each([
      // Each of these was cut by version 19 to a clause that stops mid-phrase, and passed.
      ['you help landlords deal with late paying tenants and complicated deposit disputes every single month', 'a verb left hanging: "you help landlords deal"'],
      ['you provide health and safety advice to building contractors due to start on site soon', '"contractors due" is not an ending, and "advice" has no noun form'],
      ['you guide companies through the implementation and startup process of new and upgraded facilities', 'the price: "process" has no noun form'],
    ])('PLANTED: "%s" is not cut (%s)', clause => {
      expect(clause.split(/\s+/).length).toBeGreaterThan(12)
      expect(cutToWordCap(clause)).toBeNull()
    })
    it.each([
      'you help rural councils stop housing developers from building on flood plains near existing towns today',
      'you campaign against the use of animals in testing for cosmetics and household cleaning products',
      'you provide legal advice only to firms that cannot afford to keep their own counsel',
      'you replace human translators with machine translation for retailers selling to buyers in other countries',
    ])('PLANTED: "%s" fences its claim in and is never cut', clause => {
      expect(clause.split(/\s+/).length).toBeGreaterThan(12)
      expect(cutToWordCap(clause)).toBeNull()
    })
  })

  it('PLANTED: an ampersand is written "and", in a clause and in a kind, and the quote that wrote "&" still says the kind', () => {
    expect(ampersandAsAnd('you provide Category Management & Strategic Sourcing')).toBe('you provide Category Management and Strategic Sourcing')
    expect(ampersandAsAnd('a pay&reward consultancy')).toBe('a pay and reward consultancy')
    // A letter-ampersand-letter token is a trade's own term and is left alone, so the
    // clause is refused for its ampersand as it was before repairs existed.
    for (const term of ['M&A', 'R&D', 'L&D', 'P&L']) {
      expect(ampersandAsAnd(`you provide ${term} advisory for manufacturers`)).toBe(`you provide ${term} advisory for manufacturers`)
      expect(checkDoesClause(`you provide ${term} advisory for manufacturers`, PAGE + ` We provide ${term} advisory for manufacturers.`, new Set<string>()).reasons.join(' | ')).toContain('dash or ampersand')
    }
    expect(kindInQuote('a pay and reward consultancy', 'We are a pay & reward consultancy.')).toBe('said')
    const quote = 'We are a pay & reward consultancy.'
    expect(checkFirmKind('a pay and reward consultancy', quote, PAGE + ' ' + quote)).toEqual({ ok: true, reasons: [] })
  })

  it('clauseForms: as written first, then each repair, and every repair only removes words', () => {
    const written = 'you provide digital marketing, website design, and creative brand development for regional food wholesalers'
    const forms = clauseForms(written)
    expect(forms[0]).toEqual({ does: written, repair: 'none' })
    expect(forms.map(f => f.repair)).toContain('first_item')
    const originalWords = new Set(written.replace(/[,]/g, '').split(/\s+/))
    for (const form of forms) for (const word of form.does.replace(/[,]/g, '').split(/\s+/)) expect(originalWords.has(word), `${form.repair}: ${word}`).toBe(true)
    // A clause with nothing to repair has one form.
    expect(clauseForms('you run dental clinics')).toEqual([{ does: 'you run dental clinics', repair: 'none' }])
  })

  it('the judge is told that saying less is not saying something different, and what still is', () => {
    expect(FIRM_FACT_JUDGE_PROMPT).toContain('twists_the_quote')
    expect(FIRM_FACT_JUDGE_PROMPT).toContain('only LEAVES OUT part of the quote does not twist it')
    // TWO WORDINGS WITHDRAWN, each measured on real clauses the same day. "says_the_same"
    // asked for sameness and got it: a clause naming one item of a list was refused. Then
    // "is the clause a true statement about the company" made the judge pass a real
    // must-fail control (added words) on two runs of three.
    expect(FIRM_FACT_JUDGE_PROMPT).not.toContain('says_the_same')
    expect(FIRM_FACT_JUDGE_PROMPT).not.toContain('a true statement about the company')
    expect(FIRM_FACT_JUDGE_PROMPT).toContain('a word such as "not" was left out')
    expect(FIRM_FACT_JUDGE_PROMPT).toContain("the quote says of the company's customers, or of somebody or something else")
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('write the clause for its FIRST item alone')
  })
})

describe('a verb that only says things get better names nothing (checks version 17)', () => {
  it.each(['you help businesses win', 'you help firms grow', 'you help companies succeed', 'you help clients achieve better results', 'you help organisations reach their potential'])(
    'PLANTED: "%s" is true of any firm', clause => {
      expect(clauseIsGeneric(clause)).toBe(true)
    })
  it.each(['you help hotels grow direct bookings', 'you help exporters win tenders abroad', 'you improve cold room efficiency'])(
    '"%s" names something beside it (control)', clause => {
      expect(clauseIsGeneric(clause)).toBe(false)
    })
})

describe('a slogan verb on the shared list must not swallow a trade\'s own noun', () => {
  // "build" went on the shared list with the other slogan words, and the list is matched by
  // inflection, so the NOUN "building" was read as the verb: a builder's clause and a
  // builder's kind were both refused as naming nothing (the pre-merge review, 2026-10-02).
  const QUOTE = 'Kessel is a building company serving the county.'
  const SOURCE = `${PAGE} ${QUOTE} We provide building services and building work for landlords.`

  it.each([
    'you provide building services',
    'you provide building services for businesses',
    'you do building work for businesses',
    'you provide building work',
  ])('PLANTED: "%s" names a trade', clause => {
    expect(clauseIsGeneric(clause)).toBe(false)
    expect(checkDoesClause(clause, SOURCE).reasons.join(' | ')).not.toContain('names nothing specific')
  })
  it.each(['a building company', 'a building firm', 'a building business', 'a building services company', 'a building group'])(
    'PLANTED: "%s" is a kind of firm', kind => {
      expect(kindIsGeneric(kind)).toBe(false)
    })
  it('PLANTED: checkFirmKind passes a builder\'s kind said by its own page', () => {
    expect(checkFirmKind('a building company', QUOTE, SOURCE)).toEqual({ ok: true, reasons: [] })
  })
  it.each([
    'you help build vital capabilities to deliver meaningful outcomes',
    'you help businesses build',
    'you help with all the business builds',
    'you provide services built for businesses',
  ])('"%s" still names nothing: the verb, in each form a clause can hold it (control)', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
  })
  it('the other slogan verbs are still matched in every inflection (control)', () => {
    // Only a verb whose -ing form is a trade's noun is held to exact forms. None of these is.
    for (const clause of ['you help firms creating outcomes', 'you help businesses transforming', 'you help clients enabling growth', 'you help companies scaling']) {
      expect(clauseIsGeneric(clause), clause).toBe(true)
    }
  })
})

describe('checks version 18: from reading every passing line of a real run', () => {
  it('PLANTED: a kind holds no preposition: what a page says of a THING is not what the firm is', () => {
    // The page said "coaching is a working relationship with a coach". Every other check
    // passed: the words stand together after "is a", and nothing carries them on.
    const quote = 'Coaching is a working relationship with a coach who listens.'
    expect(kindInQuote('a working relationship with a coach', quote)).toBe('said')
    expect(kindHoldsAPreposition('a working relationship with a coach')).toBe(true)
    const v = checkFirmKind('a working relationship with a coach', quote, PAGE + ' ' + quote)
    expect(v.ok).toBe(false)
    expect(v.reasons.join(' | ')).toContain('holds a preposition')
    for (const kind of ['a provider of cold rooms', 'a firm for charities', 'a partner to schools']) expect(kindHoldsAPreposition(kind), kind).toBe(true)
    // Control: a kind is a short noun phrase.
    for (const kind of ['a dental practice', 'an HR consultancy', 'a people and talent consulting firm', 'a full service B2B marketing agency']) expect(kindHoldsAPreposition(kind), kind).toBe(false)
  })

  it.each([
    'you provide DATA + CRM + MARTECH consultancy',
    'you design sites / apps for charities',
    'you run a 100% remote studio',
    'you build #1 rated tools',
  ])('PLANTED: "%s" holds a symbol and is refused', clause => {
    expect(checkDoesClause(clause, PAGE + ' ' + clause.replace(/^you /, 'We '), new Set<string>()).reasons.join(' | ')).toContain('holds a symbol')
  })

  it('PLANTED: a repair that leaves fewer than two specific words is not offered', () => {
    expect(specificWordCount('you help organisations prepare')).toBe(1)
    expect(specificWordCount('you offer business and personal support')).toBe(1)
    expect(specificWordCount('you deliver executive coaching')).toBe(2)
    expect(specificWordCount('you provide safety consultancy')).toBe(2)
    // The clause as written is always the first form; the cut that says nothing is not a second.
    const long = 'you offer business services to organisations across the whole country during every season of the year'
    expect(cutToWordCap(long)).toBe('you offer business services to organisations')
    expect(clauseForms('you help organisations prepare, plan, and succeed')).toEqual([{ does: 'you help organisations prepare, plan, and succeed', repair: 'none' }])
    // The guard itself: the cut exists and is NOT offered as a form, because it names too little.
    expect(clauseForms(long).map(f => f.repair)).toEqual(['none'])
    // Control: a repair that keeps two specific words is offered.
    expect(clauseForms('you deliver executive coaching, leadership assessments, and conflict resolution').map(f => f.repair)).toEqual(['none', 'first_item'])
  })

  it('PLANTED: a word about size or ownership counts where it describes the WORK, not the firm', () => {
    expect(specificWordCount('you provide public relations')).toBe(2)
    expect(specificWordCount('you provide private tuition')).toBe(2)
    // Control: the same kind of word in front of a word for "a firm" names nothing.
    expect(specificWordCount('you run a small business')).toBe(0)
    expect(specificWordCount('you run an independent company')).toBe(0)
  })

  it.each([
    'you help businesses achieve growth',
    'you make businesses more successful',
    'you help businesses scale',
    'you help firms keep growing',
    'you drive business growth',
    'you deliver value for clients',
    'you help companies perform better',
  ])('PLANTED: "%s" only says things get better and names nothing', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
  })
  it.each([
    'you help hotels grow direct bookings',
    'you lead change programmes for hospital trusts',
    'you generate sales leads for software makers',
  ])('"%s" has a specific word beside the weak one and passes (control)', clause => {
    expect(clauseIsGeneric(clause)).toBe(false)
  })

  describe('sentenceCaseClause', () => {
    const PAGE_TEXT = 'Fractional Executive Services. We place leaders with Northtown firms. Our services are fractional by design.'
    it('PLANTED: a clause lifted from a HEADING is lower-cased throughout', () => {
      expect(sentenceCaseClause('you provide Fractional Executive Services', 'Fractional Executive Services', PAGE_TEXT)).toBe('you provide fractional executive services')
      expect(sentenceCaseClause('you provide Business Design and Execution for the Agentic Era', 'Business Design & Execution for the Agentic Era', PAGE_TEXT)).toBe('you provide business design and execution for the agentic era')
    })
    it('a clause from a SENTENCE keeps the capital of a name the page only ever capitalises (control)', () => {
      expect(sentenceCaseClause('you place leaders with Northtown firms', 'We place leaders with Northtown firms.', PAGE_TEXT)).toBe('you place leaders with Northtown firms')
    })
    it('PLANTED: a word the page uses as a NAME in running text keeps its capital, even in a clause from a heading', () => {
      const page = 'Northtown Consulting Services. We are certified on your Northtown account and build flows in it. Our services start with an audit.'
      expect(sentenceCaseClause('you provide Northtown Consulting Services', 'Northtown Consulting Services', page)).toBe('you provide Northtown consulting services')
      // Control: the same heading on a page that never uses the word as a name in a sentence.
      expect(sentenceCaseClause('you provide Northtown Consulting Services', 'Northtown Consulting Services', 'Northtown Consulting Services. Our services start with an audit.')).toBe('you provide northtown consulting services')
    })
    it('PLANTED: a run of Title Case is lowered whole, never half ("Executive coaching and leadership Development")', () => {
      const page = 'Executive Coaching and Leadership Development. Our coaching is practical and our approach to leadership is plain.'
      expect(sentenceCaseClause('you specialise in Executive Coaching and Leadership Development for senior teams', 'We specialise in Executive Coaching and Leadership Development for senior teams.', page))
        .toBe('you specialise in executive coaching and leadership development for senior teams')
    })
    it('PLANTED: a joining word between two capitalised words does not end the run', () => {
      // "sourcing" and "advisory" are never in lower case on these pages; their neighbours are.
      const page = 'Category Management & Strategic Sourcing at federal agencies. Our category management work is plain.'
      expect(sentenceCaseClause('you provide Category Management and Strategic Sourcing at federal agencies', 'Our team provides Category Management & Strategic Sourcing at federal agencies and elsewhere today.', page))
        .toBe('you provide category management and strategic sourcing at federal agencies')
    })
    it('KNOWN LIMIT, pinned: a word the page capitalises between two lower-case words is read as a name and kept', () => {
      // "Advisory" here is not a name, and nothing in the page's text can tell code so: it
      // stands exactly where "your Northtown account" puts a name. A stray capital, never a
      // wrong word. One real line of the version 20 run.
      const page = 'Our people provide HR Services and Advisory support to small firms. Those services are fixed price.'
      expect(sentenceCaseClause('you provide HR Services and Advisory support to small firms', 'Our people provide HR Services and Advisory support to small firms.', page))
        .toBe('you provide HR services and Advisory support to small firms')
    })
    it('PLANTED: a name followed by an all-caps token keeps its capital though the page uses the word in lower case too', () => {
      const page = 'We build Northtown BI dashboards for retailers. See the northtown of your own data.'
      expect(sentenceCaseClause('you build Northtown BI dashboards for retailers', 'We build Northtown BI dashboards for retailers.', page)).toBe('you build Northtown BI dashboards for retailers')
    })
    it('leaves acronyms alone in both cases', () => {
      expect(sentenceCaseClause('you provide HR Technology Assessments', 'HR Technology Assessments', PAGE_TEXT)).toBe('you provide HR technology assessments')
      expect(sentenceCaseClause('you provide SaaS Implementation Services', 'SaaS Implementation Services', PAGE_TEXT)).toBe('you provide SaaS implementation services')
    })
  })
})

// ── Checks version 22: the operator's fifth reading, note 4 (2026-10-02) ──────────────────
//
// "No unexplained acronyms in the opener; plain-word paraphrase allowed. Prefer a service
// line over a slogan or tagline." A real opener read "Can see you optimize and implement
// HCM and payroll providers": true to the page, and one word of it means nothing to most
// readers. Code refuses the acronym, repairs the clause where the acronym can simply be
// left out, and the extraction prompt is told the same list code allows.

describe('checks version 22: no acronym a reader may not know', () => {
  /** The known short forms, read from the list the code exports: these tests follow it. */
  const KNOWN = KNOWN_ACRONYM_LIST.split(', ')

  it('the list of known short forms is really there (control for every loop over it below)', () => {
    // A loop over an empty list passes whatever the code does.
    expect(KNOWN.length).toBeGreaterThanOrEqual(5)
    expect(KNOWN).toContain('HR')
    expect(KNOWN.every(known => /^[A-Z0-9]{2,6}$/.test(known) && /[A-Z]/.test(known))).toBe(true)
  })

  describe('findUnexplainedAcronyms', () => {
    it.each([
      ['two capitals, the shortest', 'you run XY projects for hotels', ['XY']],
      ['three capitals', 'you implement HCM systems', ['HCM']],
      ['six capitals, the longest', 'you run ABCDEF projects', ['ABCDEF']],
      ['a digit among the capitals', 'you build B2G portals', ['B2G']],
      ['a plural s, returned as written', 'you report KPIs for hotels', ['KPIs']],
      ['one inside a hyphenated word', 'you run CRM-led projects', ['CRM']],
      ['one with punctuation round it, and a second in the same clause', 'you implement (HCM), and ERP.', ['HCM', 'ERP']],
    ])('PLANTED: finds %s', (_what, text, expected) => {
      expect(findUnexplainedAcronyms(text)).toEqual(expected)
    })

    it.each([
      ['an ordinary capitalised word', 'you place leaders with Northtown firms'],
      // A MIXED-CASE short form ("SaaS") was a control here until checks version 23. It is
      // a short form, and is now reported: see "checks version 23" below.
      ['a capitalised name with a capital inside it, too long to be a short form', 'you resell NorthBridge kilns'],
      ['the same letters in lower case', 'you implement hcm systems'],
      ['seven capitals, one over the longest', 'you run ABCDEFG projects'],
      ['one capital alone', 'you run A projects'],
      ['digits with no capital among them', 'you run 24 projects'],
      ['no capitals at all', 'you fit cold rooms for food wholesalers'],
    ])('does not find %s (control)', (_what, text) => {
      expect(findUnexplainedAcronyms(text)).toEqual([])
    })

    it('finds none of the known ones: alone, as a plural, or inside a hyphenated word (control, read from the list itself)', () => {
      for (const known of KNOWN) {
        expect(findUnexplainedAcronyms(`you provide ${known} support`), known).toEqual([])
        expect(findUnexplainedAcronyms(`you advise ${known}s on pay`), `${known}s`).toEqual([])
        expect(findUnexplainedAcronyms(`you run ${known}-led projects`), `${known}-led`).toEqual([])
      }
      // The same three shapes with a short form that is NOT on the list are each found, so
      // the loop above passed because of the list and not because of the sentences.
      expect(KNOWN).not.toContain('HCM')
      expect(findUnexplainedAcronyms('you provide HCM support')).toEqual(['HCM'])
      expect(findUnexplainedAcronyms('you advise HCMs on pay')).toEqual(['HCMs'])
      expect(findUnexplainedAcronyms('you run HCM-led projects')).toEqual(['HCM'])
    })
  })

  describe('a clause or a kind holding one is refused, and the reason names it', () => {
    // The page holds every word used below, so a refusal here is for the acronym alone.
    const SOURCE = `${PAGE} We implement HCM systems, ERP systems and HR systems for food wholesalers. We are an HCM consultancy. We are an HR consultancy.`

    it('PLANTED: checkDoesClause refuses an unexplained acronym, and that is its ONLY reason', () => {
      expect(checkDoesClause('you implement HCM systems for food wholesalers', SOURCE))
        .toEqual({ ok: false, reasons: ['unexplained acronym "HCM": a reader may not know it'] })
    })
    it('the same clause with a known acronym in its place passes every check (control)', () => {
      expect(checkDoesClause('you implement HR systems for food wholesalers', SOURCE)).toEqual({ ok: true, reasons: [] })
    })
    it('PLANTED: every acronym in the clause is named, each in its own reason', () => {
      const v = checkDoesClause('you implement HCM and ERP systems for food wholesalers', SOURCE)
      expect(v.reasons).toEqual([
        'unexplained acronym "HCM": a reader may not know it',
        'unexplained acronym "ERP": a reader may not know it',
      ])
    })

    it('PLANTED: checkFirmKind refuses a kind holding an unexplained acronym, and that is its ONLY reason', () => {
      expect(checkFirmKind('an HCM consultancy', 'We are an HCM consultancy.', SOURCE))
        .toEqual({ ok: false, reasons: ['unexplained acronym "HCM": a reader may not know it'] })
    })
    it('the same kind with a known acronym in its place passes every check (control)', () => {
      expect(checkFirmKind('an HR consultancy', 'We are an HR consultancy.', SOURCE)).toEqual({ ok: true, reasons: [] })
    })
  })

  // THE ACRONYM REPAIR WAS REMOVED on 2026-10-02 (the pre-merge review of the fifth reading).
  // It left the acronym out and kept the rest, and what was left passed every check and
  // read broken: the tests below hold each of those clauses as REFUSED. A clause with an
  // unexplained acronym now has one outcome, the same one a kind always had: it is refused,
  // and the next candidate or the next rung is used.
  describe('a clause holding an unexplained acronym is REFUSED, never repaired', () => {
    /** The page says the clause, so a refusal below is for the acronym and nothing else. */
    const pageFor = (does: string) => `${PAGE} ${does.replace(/^you/, 'We')}.`

    /** Every form code offers for this clause still holds the acronym, and is refused for it. */
    const expectRefusedInEveryForm = (does: string) => {
      const forms = clauseForms(does)
      expect(forms.length).toBeGreaterThan(0)
      for (const form of forms) {
        expect(findUnexplainedAcronyms(form.does), form.does).not.toEqual([])
        const verdict = checkDoesClause(form.does, pageFor(does))
        expect(verdict.ok, form.does).toBe(false)
        expect(verdict.reasons.join(' | '), form.does).toContain('unexplained acronym')
      }
      return forms
    }

    it.each([
      // The five the repair's own tests held as sound. Sound or not, none is offered now.
      ['you implement HCM and payroll systems', 'you implement payroll systems'],
      ['you implement HCM or payroll systems', 'you implement payroll systems'],
      ['you implement payroll and HCM for hotel groups', 'you implement payroll for hotel groups'],
      ['you provide interim CIO leadership', 'you provide interim leadership'],
      ['you optimize and implement HCM and payroll providers', 'you optimize and implement payroll providers'],
      ['you run payroll software and HCM', 'you run payroll software'],
      ['you implement CRM software for small charities', 'you implement software for small charities'],
      ['you run HCM and sales-led payroll projects', 'you run sales-led payroll projects'],
    ])('PLANTED: "%s" is refused, and "%s" is not offered in its place', (does, onceRepairedTo) => {
      const forms = expectRefusedInEveryForm(does)
      expect(forms.map(form => form.does)).not.toContain(onceRepairedTo)
    })

    it.each([
      // Reproduced by the review on the pure functions: each right-hand clause passed every
      // code check and composed into an opener. An acronym and then a SECOND VERB:
      ['you install CCTV and maintain fire alarms', 'you install maintain fire alarms'],
      ['you implement HCM and train payroll teams', 'you implement train payroll teams'],
      // "both" and "between" need the two things they stand in front of:
      ['you offer both SEO and content writing', 'you offer both content writing'],
      ['you offer both payroll and HCM for hotels', 'you offer both payroll for hotels'],
      ['you bridge the gap between HCM and payroll teams', 'you bridge the gap between payroll teams'],
      // The acronym was the OBJECT, and what followed it was not a noun it described:
      ['you keep SMEs compliant with tax law', 'you keep compliant with tax law'],
      ['you make HVAC easy for landlords', 'you make easy for landlords'],
      ['you help CFOs close faster each quarter', 'you help close faster each quarter'],
      // The page explained it in brackets, and the join went with the bracket:
      ['you implement human capital management (HCM) and payroll software for hotels', 'you implement human capital management payroll software for hotels'],
      // One of two alternatives left out says the firm offers no choice:
      ['you help firms choose ERP or Northwind systems', 'you help firms choose Northwind systems'],
    ])('PLANTED: "%s" is refused, and the broken "%s" is never written', (does, broken) => {
      const forms = expectRefusedInEveryForm(does)
      expect(forms.map(form => form.does)).not.toContain(broken)
    })

    it.each([
      // The shapes the repair itself declined, kept so that none of them comes back as one.
      ['straight after an article, which was chosen for the acronym', 'you run an HCM practice for hotels'],
      ['straight after "a"', 'you run a CRM agency for charities'],
      ['between a join and a noun, as one of two describing words', 'you implement payroll and HCM systems'],
      ['between a join and a noun, opening a second noun phrase', 'you provide payroll implementation and CRM training for hotels'],
      ['as the last word', 'you implement workforce systems using HCM'],
      ['before a trailing word', 'you implement CRM for small charities'],
      ['before a grammar word', 'you fix the CRM their sales teams use'],
      ['in a clause too short to lose a word', 'you implement HCM and payroll'],
      ['beside a second acronym inside a hyphenated word', 'you run HCM and CRM-led payroll projects'],
    ])('PLANTED: refused with the acronym %s', (_where, does) => {
      expectRefusedInEveryForm(does)
    })

    it('the same clauses pass every check once the acronym is one a reader knows (control)', () => {
      // So the refusals above are for the acronym, and not for the sentence or the page.
      for (const does of ['you implement HR and payroll systems', 'you install alarms and maintain fire alarms', 'you keep landlords compliant with tax law']) {
        expect(checkDoesClause(does, pageFor(does)), does).toEqual({ ok: true, reasons: [] })
        expect(clauseForms(does), does).toEqual([{ does, repair: 'none' }])
      }
    })

    it('PLANTED: clauseForms offers such a clause as written and in no other form', () => {
      const does = 'you implement HCM and payroll systems for hotels'
      expect(clauseForms(does)).toEqual([{ does, repair: 'none' }])
    })

    it('PLANTED: the list and length cuts still run on it by their own rules; here what they leave still holds the acronym, so every form is refused', () => {
      const forms = expectRefusedInEveryForm('you implement HCM and payroll systems, rostering tools, and training courses')
      expect(forms.map(form => form.repair)).toEqual(['none', 'first_item'])
      expect(forms[1].does).toBe('you implement HCM and payroll systems')
    })

    it('PLANTED: no repair is labelled as removing an acronym: the label is gone from the type', () => {
      const labels: ClauseRepair[] = ['none', 'first_item', 'cut_to_cap', 'first_item_then_cut']
      // @ts-expect-error 'acronym_removed' was a ClauseRepair until 2026-10-02. If this line stops being an error, the repair is back.
      const gone: ClauseRepair = 'acronym_removed'
      expect(labels).not.toContain(gone)
      const seen = new Set([
        'you implement HCM and payroll systems for hotels',
        'you provide interim CIO leadership for charities',
        'you implement HCM and payroll systems, rostering tools, and training courses',
      ].flatMap(does => clauseForms(does).map(form => form.repair)))
      expect([...seen].every(label => labels.includes(label))).toBe(true)
    })

    it('PLANTED: an acronym joined by a slash, or carrying a possessive, is seen', () => {
      expect(findUnexplainedAcronyms('you provide HR/HCM support')).toEqual(['HCM'])
      expect(findUnexplainedAcronyms("you manage an HCM's rollout")).toEqual(['HCM'])
      // Control: the known one beside it is not reported.
      expect(findUnexplainedAcronyms('you provide HR/IT support')).toEqual([])
    })
  })

  describe('a roman numeral is a number written in letters, not an acronym', () => {
    // "you run phase II clinical trials" is how that trade writes it, and the extraction
    // obeyed its prompt in writing it: "II" is not a short form of anything.
    it.each(['II', 'III', 'IV', 'VI', 'VII', 'IX', 'XI', 'XV', 'XX'])('PLANTED: "%s" is not reported', numeral => {
      expect(findUnexplainedAcronyms(`you run phase ${numeral} clinical trials`)).toEqual([])
    })

    it('PLANTED: the clause that holds one passes every check as written, and is not cut', () => {
      const does = 'you run phase II clinical trials'
      const page = `${PAGE} We run phase II clinical trials for biotech firms.`
      expect(checkDoesClause(does, page)).toEqual({ ok: true, reasons: [] })
      expect(clauseForms(does)).toEqual([{ does, repair: 'none' }])
      expect(findWordsAbsentFromQuote(does, 'We run phase II clinical trials for biotech firms.')).toEqual([])
    })

    it.each([
      ['a plural s: that is a short form with an ending, not a numeral', 'you fit IVs for clinics', ['IVs']],
      ['any other letter among them', 'you run XL print jobs', ['XL']],
      ['a digit among them', 'you sell X5 parts', ['X5']],
      ['an ordinary acronym', 'you run phase HCM trials', ['HCM']],
    ])('still reports %s (control)', (_what, text, expected) => {
      expect(findUnexplainedAcronyms(text)).toEqual(expected)
    })

    // Checks version 23: the letters I, V and X are a numeral only in an order a numeral
    // can take. Until then any string of them passed, and "you install VX ventilation
    // units in schools" composed.
    it.each(['VX', 'IVX', 'VVV', 'IIII', 'XXXX', 'IIV', 'VIV'])('PLANTED: "%s" is not a numeral and is reported', letters => {
      expect(findUnexplainedAcronyms(`you install ${letters} ventilation units in schools`)).toEqual([letters])
    })
    it.each(['XXX', 'XIV', 'XIX', 'XXIII', 'VIII'])('"%s" is a numeral in a numeral\'s order and is not reported (control)', numeral => {
      expect(findUnexplainedAcronyms(`you run phase ${numeral} clinical trials`)).toEqual([])
    })
  })

  describe('the extraction prompt says what the code holds', () => {
    /** The list as the PROMPT states it, read out of the prompt text. */
    const stated = (FIRM_FACT_EXTRACTION_PROMPT.match(/Only these may appear: ([^\n]*?)\. For any other short form/)?.[1] ?? '').split(', ').filter(Boolean)

    it('PLANTED: the acronyms the prompt allows are exactly the ones the code allows', () => {
      // A model told it may write an acronym the code then refuses is a paid refusal each time.
      expect(stated.length).toBeGreaterThanOrEqual(5)
      expect(stated).toEqual(KNOWN)
      expect(FIRM_FACT_EXTRACTION_PROMPT).toContain(`Only these may appear: ${KNOWN_ACRONYM_LIST}.`)
      for (const allowed of stated) expect(findUnexplainedAcronyms(`you provide ${allowed} support`), allowed).toEqual([])
    })
    it('an acronym the code refuses is not among those the prompt allows (control)', () => {
      expect(findUnexplainedAcronyms('you provide HCM support')).toEqual(['HCM'])
      expect(stated).not.toContain('HCM')
    })
    it('PLANTED: the KIND paragraph states the same list, in its own words, and what to do with any other short form', () => {
      // "lower case except an acronym" invited any acronym, and the check refuses all but
      // these: a kind has no other way to say it, so each one was a paid refusal.
      const kindRule = FIRM_FACT_EXTRACTION_PROMPT.split('\n').find(line => line.startsWith('firm_kind:')) ?? ''
      const statedForKind = (kindRule.match(/The only short forms allowed are ([^;]*?); for any other/)?.[1] ?? '').split(', ').filter(Boolean)
      expect(statedForKind.length).toBeGreaterThanOrEqual(5)
      expect(statedForKind).toEqual(KNOWN)
      expect(kindRule).toContain(`The only short forms allowed are ${KNOWN_ACRONYM_LIST}; for any other, use the page's plain words for it or give null.`)
      // Checks version 23. "Write it lower case" invited "a pr agency" from a page that says
      // "a PR agency", and code then saw no capitals to refuse. A short form keeps the
      // page's capitals, and code reads them from the quote either way.
      expect(kindRule).toContain('keep any short form exactly as the page writes it')
      expect(kindRule).not.toContain('Write it lower case;')
      // And code holds exactly that list for a kind: each allowed one passes, another does not.
      for (const allowed of statedForKind) expect(findUnexplainedAcronyms(`an ${allowed} consultancy`), allowed).toEqual([])
      expect(findUnexplainedAcronyms('an HCM consultancy')).toEqual(['HCM'])
    })
    it('PLANTED: the prompt says what to do with any other short form: the page\'s plain words, leave it out, or another quote', () => {
      expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('NO ACRONYM THE READER MAY NOT KNOW.')
      expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('use the plain words the page itself gives for it if your quote holds them, or leave that part out, or pick a different quote')
    })
    it('PLANTED: the prompt prefers a service line to a slogan, and says a slogan is marked "tagline"', () => {
      expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('Prefer a line that names a SERVICE the company sells, or its niche, over a slogan or a tagline')
      expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('Mark a slogan\'s section as "tagline" honestly; it is used only when nothing better is on the page.')
    })
    it('"tagline" is one of the sections the answer\'s shape allows, so the mark asked for can be given (control)', () => {
      expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('"section":"service" | "niche" | "body" | "title" | "tagline"')
    })
  })
})

// ─── Checks version 23 (the second fix round of the pre-merge review, 2026-10-02) ──────

describe('checks version 23: a short form is judged as its QUOTE writes it', () => {
  // The code saw an acronym only in capitals, so "a pr agency" passed every check and
  // composed into "you run a pr agency" from a page that says "a PR agency". The model was
  // told to write a kind in lower case. So each word now takes its capitals from the quote.
  const KNOWN = KNOWN_ACRONYM_LIST.split(', ')

  describe('findUnexplainedAcronyms, given the quote', () => {
    it.each([
      ['a pr agency', 'Brightwell is a PR agency for charities.', ['PR']],
      ['an seo agency', 'We are an SEO agency for hotels.', ['SEO']],
      ['you provide crm training for charities', 'We provide CRM training for charities.', ['CRM']],
      ['you fit hvac units for landlords', 'We fit HVAC units for landlords.', ['HVAC']],
      ['you advise kpis for hotels', 'We advise on KPIs for hotels.', ['KPIs']],
      ['a saas company', 'We are a SaaS company for clinics.', ['SaaS']],
      ['you run crm-led projects', 'We run CRM-led projects.', ['CRM']],
    ])('PLANTED: "%s" is read with the capitals of "%s"', (text, quote, expected) => {
      expect(findUnexplainedAcronyms(text, quote)).toEqual(expected)
      // ...exactly as the same words written with the quote's capitals are.
      const asTheQuoteWritesIt = text.split(' ').map(word => {
        const parts = word.split('-').map(part => expected.find(e => e.toLowerCase() === part) ?? part)
        return parts.join('-')
      }).join(' ')
      expect(findUnexplainedAcronyms(asTheQuoteWritesIt)).toEqual(expected)
    })

    it('without the quote the lower-cased form is not seen: why every caller that has the quote must pass it (control)', () => {
      expect(findUnexplainedAcronyms('a pr agency')).toEqual([])
      expect(findUnexplainedAcronyms('a pr agency', 'Brightwell is a PR agency for charities.')).toEqual(['PR'])
    })
    it.each([
      ['a word the quote writes in lower case', 'you fit cold rooms for food wholesalers', 'We fit cold rooms for food wholesalers.'],
      ['a known short form the quote writes in capitals', 'you provide hr support for hotels', 'We provide HR support for hotels.'],
      ['a Title Case word', 'a design consultancy', 'Northtown Design is a Design Consultancy.'],
      ['a long word the quote shouts, longer than any short form', 'you provide refrigeration', 'We provide REFRIGERATION for hotels.'],
    ])('does not report %s (control)', (_what, text, quote) => {
      expect(findUnexplainedAcronyms(text, quote)).toEqual([])
    })
  })

  describe('checkFirmKind and checkDoesClause read the quote\'s capitals', () => {
    const KIND_QUOTE = 'Brightwell is a PR agency for charities.'
    const KIND_SOURCE = `${PAGE} ${KIND_QUOTE} Brightwell does PR for charities.`

    it('PLANTED: "a pr agency" is refused exactly as "a PR agency" is', () => {
      const lower = checkFirmKind('a pr agency', KIND_QUOTE, KIND_SOURCE)
      const upper = checkFirmKind('a PR agency', KIND_QUOTE, KIND_SOURCE)
      expect(upper).toEqual({ ok: false, reasons: ['unexplained acronym "PR": a reader may not know it'] })
      expect(lower).toEqual(upper)
    })
    it('PLANTED: "a saas company" is refused as "a SaaS company" is, and "a SaaS company" is refused', () => {
      const quote = 'Quillmere is a SaaS company for clinics.'
      const source = `${PAGE} ${quote}`
      expect(checkFirmKind('a SaaS company', quote, source)).toEqual({ ok: false, reasons: ['unexplained acronym "SaaS": a reader may not know it'] })
      expect(checkFirmKind('a saas company', quote, source)).toEqual(checkFirmKind('a SaaS company', quote, source))
    })
    it('PLANTED: checkDoesClause refuses a lower-cased short form its quote writes in capitals', () => {
      const quote = 'We provide PR for charities.'
      const source = `${PAGE} ${quote}`
      expect(checkDoesClause('you provide pr for charities', source, undefined, quote))
        .toEqual({ ok: false, reasons: ['unexplained acronym "PR": a reader may not know it'] })
      expect(checkDoesClause('you provide PR for charities', source, undefined, quote))
        .toEqual(checkDoesClause('you provide pr for charities', source, undefined, quote))
    })
    it('PLANTED: a KNOWN short form the clause lower-cases is refused too: the opener would print "an hr consultancy"', () => {
      const quote = 'We are an HR consultancy for hotels.'
      const source = `${PAGE} ${quote}`
      expect(checkFirmKind('an hr consultancy', quote, source).reasons)
        .toEqual(['writes "hr" in lower case where its quote writes "HR": a short form is written as the page writes it'])
      expect(checkDoesClause('you provide hr support', `${PAGE} We provide HR support.`, undefined, 'We provide HR support.').reasons)
        .toEqual(['writes "hr" in lower case where its quote writes "HR": a short form is written as the page writes it'])
    })
    it('the same kind and clause with the quote\'s capitals pass every check (control)', () => {
      const quote = 'We are an HR consultancy for hotels.'
      expect(checkFirmKind('an HR consultancy', quote, `${PAGE} ${quote}`)).toEqual({ ok: true, reasons: [] })
      expect(checkDoesClause('you provide HR support', `${PAGE} We provide HR support.`, undefined, 'We provide HR support.')).toEqual({ ok: true, reasons: [] })
    })
    it('a word the quote ALSO writes in lower case is not a short form written in lower case ("IT" and the pronoun "it") (control)', () => {
      const quote = 'We set up IT for small firms and run it for them.'
      expect(checkDoesClause('you run it for small firms', `${PAGE} ${quote}`, undefined, quote).reasons.join(' | ')).not.toContain('lower case where its quote')
    })
    it('PLANTED: a quote written in capitals throughout cannot show which words are short forms, so the clause is refused', () => {
      const quote = 'WE FIT COLD ROOMS FOR FOOD WHOLESALERS'
      const source = `${PAGE} ${quote}`
      expect(checkDoesClause('you fit cold rooms for food wholesalers', source, undefined, quote).reasons)
        .toEqual(['its quote is written in capitals throughout, so which of its words are short forms cannot be told'])
      expect(checkFirmKind('a cold room firm', 'WE ARE A COLD ROOM FIRM', `${PAGE} WE ARE A COLD ROOM FIRM`).reasons)
        .toContain('its quote is written in capitals throughout, so which of its words are short forms cannot be told')
    })
    it('the same clause from a quote in running prose passes (control)', () => {
      const quote = 'We fit cold rooms for food wholesalers.'
      expect(checkDoesClause('you fit cold rooms for food wholesalers', `${PAGE} ${quote}`, undefined, quote)).toEqual({ ok: true, reasons: [] })
    })
  })

  describe('a MIXED-CASE short form is an unexplained acronym too', () => {
    // Until version 23 the listed field words (SaaS, IoT, FinTech, PaaS, eCommerce) were
    // let through because the extraction prompt told the model to write an acronym. The
    // operator's rule is "no unexplained acronyms in the opener", and none of these is on
    // the known list.
    it.each([
      ['SaaS'], ['IoT'], ['FinTech'], ['PaaS'], ['eCommerce'],
      // Not listed anywhere: found by their shape.
      ['IaaS'], ['DevOps'], ['eLearning'], ['PropTech'], ['mHealth'],
    ])('PLANTED: "%s" is reported', form => {
      expect(findUnexplainedAcronyms(`you build ${form} tools for clinics`)).toEqual([form])
    })
    it('PLANTED: two in one clause are both reported, and one inside a hyphenated word is seen', () => {
      expect(findUnexplainedAcronyms('you build SaaS and IoT tools')).toEqual(['SaaS', 'IoT'])
      expect(findUnexplainedAcronyms('you run SaaS-based billing')).toEqual(['SaaS'])
    })
    it.each([
      ['an invented product name with a capital inside it', 'you resell NorthBridge kilns'],
      ['a family name with its own capital', 'you represent the McLeod family'],
      ['a Title Case word', 'you supply Northwind parts'],
      ['a known all-caps short form', 'you provide HR support'],
    ])('does not report %s (control)', (_what, text) => {
      expect(findUnexplainedAcronyms(text)).toEqual([])
    })
    it('none of the known short forms is mixed case, so none is refused by this rule (control, read from the list)', () => {
      for (const known of KNOWN) expect(findUnexplainedAcronyms(`you provide ${known} support`), known).toEqual([])
    })
  })
})

describe('checks version 23: "building" names a trade only before one of its nouns', () => {
  // Version 22's fix made "building" specific wherever it stood, and re-admitted the
  // slogans built on it: each clause below was refused before that fix, passed after it,
  // and composed at the specific rung (the verifier's ten, 2026-10-02).
  it.each([
    'you help firms with building capabilities',
    'you help businesses with building capability',
    'you help organisations building capability',
    'you help clients with building better businesses',
    'you help companies with building success',
    'you help leaders with building meaningful impact',
    'you help firms with building growth',
    'you provide capability building for businesses',
    'you help businesses with building value',
    'you help clients with building results',
  ])('PLANTED: "%s" names nothing', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
    expect(checkDoesClause(clause, `${PAGE} ${clause.replace(/^you/, 'We')}.`).reasons).toContain('names nothing specific: true of any firm')
  })
  it.each([
    'you provide capability building',
    'you help teams with building',
    'you help firms with building and growth',
  ])('PLANTED: "%s" names nothing: "building" with nothing after it, or only an outcome past "and"', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
  })

  const SOURCE = `${PAGE} Kessel is a building company serving the county. We provide building services, building work, building materials and building maintenance for landlords.`
  it.each([
    'you provide building services',
    'you provide building services for businesses',
    'you do building work for businesses',
    'you provide building work',
    'you supply building materials',
    'you provide building maintenance for landlords',
    'you provide building and maintenance services',
    'you provide building surveys for landlords',
    'you supply building supplies',
  ])('"%s" names a trade (control)', clause => {
    expect(clauseIsGeneric(clause)).toBe(false)
    expect(checkDoesClause(clause, SOURCE).reasons.join(' | ')).not.toContain('names nothing specific')
  })
  it.each(['a building company', 'a building firm', 'a building business', 'a building services company', 'a building group', 'a building contractor'])(
    '"%s" is a kind of firm (control)', kind => {
      expect(kindIsGeneric(kind)).toBe(false)
    })
  // Merge review, 2026-10-02: a shared-list word in FRONT of "building" makes the trade
  // noun after it the slogan's, not a builder's. The clause's own verb ("you provide
  // building services") is not that word.
  it.each([
    'you provide capability building services',
    'you provide value building services for businesses',
    'you provide growth building services',
    'you provide success building services',
    'you provide capability building work for businesses',
  ])('PLANTED: "%s" names nothing: a slogan word stands in front of "building"', clause => {
    expect(clauseIsGeneric(clause)).toBe(true)
  })
  it.each(['a capability building company', 'a value building company', 'a growth building business'])(
    'PLANTED: "%s" is not a kind of firm: a slogan word stands in front of "building"', kind => {
      expect(kindIsGeneric(kind)).toBe(true)
    })
  it('a repair that leaves "building" before an outcome word is not worth keeping: it counts no specific word for it', () => {
    expect(specificWordCount('you help firms with building success')).toBe(0)
    expect(specificWordCount('you provide building services')).toBe(1)
  })
})

describe('merge review: a heading in capitals is not an acronym when the page also writes the word in lower case', () => {
  it.each([
    ['you install and service cold rooms', 'COLD ROOMS. We install and service cold rooms for food wholesalers.'],
    ['a design studio', 'DESIGN STUDIO based in Kessel. We are a design studio.'],
    ['a full service agency', 'We are a FULL service agency, and a full service agency is what we stay.'],
  ])('PLANTED (must pass): "%s"', (text, quote) => {
    expect(findUnexplainedAcronyms(text, quote)).toEqual([])
  })
  it('a lower-cased short form the page writes only in capitals is still refused (control)', () => {
    expect(findUnexplainedAcronyms('a pr agency', 'Brightwell is a PR agency for charities.')).toEqual(['PR'])
  })
})

describe('checks version 23: an acronym is never cut out ALONE, and the list and length cuts keep their own rules', () => {
  // A clause holding an unexplained acronym is never shortened to hide it by deleting the
  // acronym alone. The list and length cuts still run by their own rules, and a cut that
  // leaves the acronym out is kept, because what it leaves is a sound, true clause.
  it.each([
    ['the first item of a list', 'you install fire alarm systems, CCTV cameras, and door entry systems', 'first_item', 'you install fire alarm systems'],
    ['the clause cut at its trailing phrase', 'you install commercial kitchen extraction systems for restaurants across the north with HACCP support', 'cut_to_cap', 'you install commercial kitchen extraction systems for restaurants'],
  ])('PLANTED (must pass): %s', (_what, does, repair, kept) => {
    const page = `${PAGE} ${does.replace(/^you/, 'We')}.`
    // As written it is refused, and the acronym is among the reasons.
    expect(checkDoesClause(does, page).reasons.join(' | ')).toContain('unexplained acronym')
    const form = clauseForms(does).find(f => f.repair === repair)
    expect(form?.does).toBe(kept)
    expect(findUnexplainedAcronyms(kept)).toEqual([])
    expect(checkDoesClause(kept, page)).toEqual({ ok: true, reasons: [] })
  })
})

describe('checks version 23: the version note', () => {
  it('PLANTED: the note has a line for the version in force, and says what it changed', () => {
    const text = readFileSync(join(__dirname, '..', 'firm-fact-checks.ts'), 'utf8')
    const note = text.slice(0, text.indexOf('export const FIRM_FACT_CHECKS_VERSION'))
    expect(note).toMatch(new RegExp(`\\n \\*\\s+${FIRM_FACT_CHECKS_VERSION}\\s+2026-\\d\\d-\\d\\d\\s`))
    expect(FIRM_FACT_CHECKS_VERSION).toBe(23)
    // The round-one note said nothing reaches a stored row. The generic list re-runs at
    // composition, so that sentence must not stand.
    expect(note).not.toContain('none of this reaches a row stored before it')
  })
})

// ── Mutation round, 2026-10-02: checks versions 16 to 22, kept where they still hold at version 23 ──────────────────────────────────
//
// Each test below holds a guard that could be deleted, or a list entry that could be
// dropped, with every other test in this file green. Found by mutation-testing the guards
// one at a time. Every one has a control beside it. All text is invented.

describe('mutation round: guards of checks versions 16 to 22 that no test held', () => {
  describe('ampersandAsAnd: only where an ampersand joins two words', () => {
    it('PLANTED: one lower-case letter either side is a trade term, as its capitals are', () => {
      expect(ampersandAsAnd('you run an r&d lab')).toBe('you run an r&d lab')
      expect(ampersandAsAnd('you run a p&l review')).toBe('you run a p&l review')
      // Control: two letters either side is two words, and is rewritten.
      expect(ampersandAsAnd('you run a pay&reward desk')).toBe('you run a pay and reward desk')
    })
    it('PLANTED: capitals either side of an unspaced ampersand are left alone', () => {
      expect(ampersandAsAnd('you staff QA&Test teams')).toBe('you staff QA&Test teams')
      // Control: the same two words spaced are joined.
      expect(ampersandAsAnd('you staff QA & Test teams')).toBe('you staff QA and Test teams')
    })
    it('PLANTED: clauseForms writes the ampersand as "and" in the clause as written', () => {
      expect(clauseForms('you provide pay & reward advice')).toEqual([{ does: 'you provide pay and reward advice', repair: 'none' }])
      // Control: a clause with no ampersand is the first form untouched.
      expect(clauseForms('you provide pay and reward advice')).toEqual([{ does: 'you provide pay and reward advice', repair: 'none' }])
    })
  })

  describe('hasNounForm, read through the two repairs that use it', () => {
    // The only place a cut can be made is straight after the word under test.
    const afterWord = (word: string) => `you help every housing team ${word} with everything a growing landlord might possibly need today`
    it.each([
      'manage', 'engage', 'encourage', 'leverage', 'ensure', 'secure', 'assure', 'insure', 'procure', 'nurture',
      'capture', 'measure', 'restructure', 'bring', 'mention', 'position', 'transition', 'implement', 'complement',
      'supplement', 'document', 'experience', 'influence', 'balance', 'finance', 'advance', 'enhance', 'reference',
    ])('PLANTED: "%s" is a verb that ends as a noun does, and a cut never ends on it', verb => {
      expect(afterWord(verb).split(/\s+/).length).toBeGreaterThan(12)
      expect(cutToWordCap(afterWord(verb))).toBeNull()
    })
    it('a noun in the same place is cut on (control)', () => {
      expect(cutToWordCap(afterWord('storage'))).toBe('you help every housing team storage')
      expect(cutToWordCap(afterWord('budgets'))).toBe('you help every housing team budgets')
    })
    it.each([
      ['sion', 'you provide clinical staff supervision'],
      ['ment', 'you provide tenant deposit management'],
      ['ance', 'you arrange commercial fleet insurance'],
      ['ence', 'you teach basic data science'],
      ['ity', 'you assess food plant productivity'],
      ['acy', 'you teach adult workplace literacy'],
      ['ncy', 'you provide interim finance consultancy'],
      ['egy', 'you write retail pricing strategy'],
      ['ogy', 'you supply dental imaging technology'],
      ['ure', 'you design street lighting infrastructure'],
      ['ism', 'you promote rural farm tourism'],
      ['age', 'you provide archive document storage'],
    ])('PLANTED: a first item ending -%s ends on a noun, and the list is cut to it', (_ending, first) => {
      expect(firstItemOfList(`${first}, rota planning, and site audits`)).toBe(first)
    })
    it('a first item with no noun ending is not cut, in the same list (control)', () => {
      expect(firstItemOfList('you provide tenant deposit advice, rota planning, and site audits')).toBeNull()
    })
  })

  describe('hasPluralForm: a short word, and a word ending -us or -is, is not a plural', () => {
    const through = (words: string) => `you help each council ${words} through everything a growing borough might possibly need today`
    it.each([
      ['its', 'improve its training'],
      ['plus', 'buy coaching plus training'],
      ['this', 'run this training'],
    ])('PLANTED: "%s" before an -ing word is not a plural, so the -ing word is a noun and the cut stands', (_word, words) => {
      expect(cutToWordCap(through(words))).toBe(`you help each council ${words}`)
    })
    it('a real plural before an -ing word is people doing something, and the cut is refused (control)', () => {
      expect(cutToWordCap(through('find tutors training'))).toBeNull()
    })
  })

  describe('itemDescribes: a later item that ends as a describing phrase does', () => {
    // "engaging" passes as a noun by its ending, so only the describing item refuses the cut.
    const list = (item: string) => `you help schools run engaging, ${item} and parent led events`
    it.each([
      ['a phrase holding " to "', 'simple to book'],
      ['-ly', 'held monthly'], ['-ed', 'well attended'], ['-al', 'truly local'], ['-ive', 'fully inclusive'],
      ['-able', 'easily affordable'], ['-ible', 'widely accessible'], ['-ic', 'highly academic'],
      ['-ous', 'really generous'], ['-ful', 'very useful'], ['-less', 'almost effortless'],
      ['"cost"', 'low cost'], ['"free"', 'gluten free'], ['"first"', 'safety first'], ['"proof"', 'weather proof'],
      ['"ready"', 'classroom ready'], ['"efficient"', 'energy efficient'], ['"simple"', 'quite simple'],
      ['"secure"', 'very secure'], ['"safe"', 'totally safe'], ['"fast"', 'really fast'], ['"easy"', 'really easy'],
      ['"quick"', 'very quick'], ['"clear"', 'very clear'], ['"fair"', 'very fair'], ['"lean"', 'very lean'],
      ['"new"', 'brand new'], ['"modern"', 'very modern'], ['"smart"', 'very smart'],
    ])('PLANTED: %s: the list is one of describing words and is not cut', (_what, item) => {
      expect(firstItemOfList(list(item))).toBeNull()
    })
    it('the same list with a noun phrase in that place is cut (control)', () => {
      expect(firstItemOfList(list('sports clubs'))).toBe('you help schools run engaging')
    })
  })

  describe('firstItemOfList: the conditions nothing else shadows', () => {
    it.each([
      ['everything from', 'you handle everything from planning applications, building control and site handover'],
      ['ranging from', 'you offer services ranging from planning applications, building control and site handover'],
      ['both', 'you serve both housing associations, private landlords and letting agents'],
      ['either', 'you supply either steel frames, timber frames or concrete panels'],
      ['range of', 'you offer a range of site surveys, drone mapping and soil testing'],
      ['combination of', 'you offer a combination of site surveys, drone mapping and soil testing'],
      ['variety of', 'you offer a variety of site surveys, drone mapping and soil testing'],
      ['blend of', 'you offer a blend of site surveys, drone mapping and soil testing'],
      ['number of', 'you offer a number of site surveys, drone mapping and soil testing'],
      ['selection of', 'you offer a selection of site surveys, drone mapping and soil testing'],
    ])('PLANTED: a head holding "%s" needs both sides of what follows, and is not cut', (_head, clause) => {
      expect(firstItemOfList(clause)).toBeNull()
    })
    it('the same lists with no such head are cut (control)', () => {
      expect(firstItemOfList('you handle planning applications, building control and site handover')).toBe('you handle planning applications')
      expect(firstItemOfList('you offer site surveys, drone mapping and soil testing')).toBe('you offer site surveys')
    })
    it('PLANTED: a first item of one word after its verb is too little to stand, though it is a plural', () => {
      expect(firstItemOfList('you train nurses, midwives and carers')).toBeNull()
      // Control: one more word and the same list is cut.
      expect(firstItemOfList('you train agency nurses, midwives and carers')).toBe('you train agency nurses')
    })
    it('PLANTED: a single-word item in the middle and a phrase at the end may share the end noun: not cut', () => {
      expect(firstItemOfList('you supply steel frames, cladding and roof panels')).toBeNull()
      // Control: every item a phrase, or the last a single word, and the list is cut.
      expect(firstItemOfList('you supply steel frames, wall cladding and roof panels')).toBe('you supply steel frames')
      expect(firstItemOfList('you supply steel frames, roof panels and cladding')).toBe('you supply steel frames')
    })
    it.each([
      ['-ure', 'you help firms build mature, well run sales teams'],
      ['-age', 'you help schools lift average, below target exam results'],
    ])('PLANTED: a first item ending %s is a describing word as often as a noun: one later item is not enough', (_ending, clause) => {
      expect(firstItemOfList(clause)).toBeNull()
    })
    it('the same endings with two later items are cut (control)', () => {
      expect(firstItemOfList('you provide archive document storage, rota planning, and site audits')).toBe('you provide archive document storage')
    })
  })

  describe('cutToWordCap: the words that fence a claim in, each one', () => {
    const verb = (word: string) => `you help rural councils ${word} housing developers from building on flood plains near existing towns today`
    const other = (word: string) => `you help rural councils plan new homes ${word} building on flood plains near existing towns today`
    // "stop", "replace", "against" and "only" are held by the tests above; these are the rest of the list.
    it.each(['prevent', 'avoid', 'ban', 'reduce', 'end', 'remove', 'block', 'fight', 'oppose', 'cut'])(
      'PLANTED: "%s" fences the claim in, and the clause is never cut', word => {
        expect(cutToWordCap(verb(word))).toBeNull()
      })
    it.each(['without', 'instead', 'not', 'never', 'no', 'except', 'unless'])(
      'PLANTED: "%s" fences the claim in, and the clause is never cut', word => {
        expect(cutToWordCap(other(word))).toBeNull()
      })
    it('the same two clauses with a plain word in that place are cut (control)', () => {
      expect(cutToWordCap(verb('meet'))).toBe('you help rural councils meet housing developers')
      expect(cutToWordCap(other('by'))).toBe('you help rural councils plan new homes')
    })
  })

  describe('cutToWordCap: a cut never ends on a word that needs its "of"', () => {
    it.each([
      ['selection', 'a wide selection'], ['series', 'a long series'],
      ['kinds', 'many kinds'], ['types', 'many types'], ['sorts', 'many sorts'], ['lots', 'many lots'],
      ['parts', 'many parts'], ['sets', 'many sets'],
    ])('PLANTED: "%s" has a noun\'s form and still cannot end the clause', (_word, phrase) => {
      expect(cutToWordCap(`you supply and install commercial kitchens for ${phrase} of hotels and restaurants today`))
        .toBe('you supply and install commercial kitchens')
    })
    it('a noun that needs no "of" in the same place does end it (control)', () => {
      expect(cutToWordCap('you supply and install commercial kitchens for many chains of hotels and restaurants today'))
        .toBe('you supply and install commercial kitchens for many chains')
    })
  })

  describe('cutToWordCap: where the search for a cut starts and stops', () => {
    it('PLANTED: a cut is never tried past the cap, however sound the phrase before it', () => {
      // "across" is the fifteenth word and "butchers" before it is a plural: a cut there leaves fourteen words.
      const out = cutToWordCap('you design and fit cold rooms for regional food wholesalers and bakeries and butchers across northern towns')
      expect(out).toBe('you design and fit cold rooms')
      expect(out!.split(/\s+/).length).toBeLessThanOrEqual(12)
    })
    it('PLANTED: a cut that leaves exactly twelve words is tried', () => {
      const out = cutToWordCap('you design and fit cold rooms and freezers and chillers and counters for butchers')
      expect(out).toBe('you design and fit cold rooms and freezers and chillers and counters')
      expect(out!.split(/\s+/).length).toBe(12)
    })
    it('PLANTED: a cut never ends on a trailing word that happens to end -ing ("using")', () => {
      expect(cutToWordCap('you train hotel kitchen staff using in house chef led demo days every single month')).toBeNull()
      // Control: an -ing word that names a service, in the same place, ends the clause.
      expect(cutToWordCap('you give hotel kitchen staff training in house chef led demo days every single month')).toBe('you give hotel kitchen staff training')
    })
  })

  describe('clauseForms: every repair is held to "two specific words", and the order is fixed', () => {
    it('PLANTED: a first item that names too little is not offered', () => {
      const does = 'you provide business services, staff training, and site audits'
      expect(firstItemOfList(does)).toBe('you provide business services')
      expect(specificWordCount('you provide business services')).toBe(0)
      expect(clauseForms(does).map(form => form.repair)).toEqual(['none'])
    })
    it('PLANTED: a first item cut to the cap that names too little is not offered, while the first item itself is', () => {
      const does = 'you offer business services to organisations across the whole country during every season for charities, staff training, and site audits'
      expect(cutToWordCap(firstItemOfList(does)!)).toBe('you offer business services to organisations')
      expect(clauseForms(does).map(form => form.repair)).toEqual(['none', 'first_item'])
    })
    it('PLANTED: the first item of a list is offered before the clause cut to the cap', () => {
      const does = 'you provide digital marketing, website design, and creative brand development for regional food wholesalers'
      expect(clauseForms(does)).toEqual([
        { does, repair: 'none' },
        { does: 'you provide digital marketing', repair: 'first_item' },
        { does: 'you provide digital marketing, website design, and creative brand development', repair: 'cut_to_cap' },
      ])
    })
  })

  describe('specificWordCount and the shared generic words', () => {
    it('KNOWN LIMIT, pinned: a size or ownership word with nothing after it is not counted', () => {
      // clauseIsGeneric keeps such a word as content in a specific clause ("you support women").
      // This count does not. The two disagree, and the count is the stricter: a repair ending
      // on such a word needs two OTHER specific words to be offered.
      expect(specificWordCount('you build websites for the public')).toBe(1)
      expect(clauseIsGeneric('you build websites for the public')).toBe(false)
      // Control: the same word with a plain noun after it describes the work, and counts.
      expect(specificWordCount('you build public websites')).toBe(2)
    })
    it.each([
      'you help build vital capabilities to deliver meaningful outcomes',
      'you help teams create meaningful impact',
    ])('PLANTED: "%s" is a slogan and names nothing', clause => {
      expect(clauseIsGeneric(clause)).toBe(true)
    })
    it('the same slogan with one word that says what is sold names something (control)', () => {
      expect(clauseIsGeneric('you help build payroll capabilities to deliver meaningful outcomes')).toBe(false)
    })
  })

  describe('sentenceCaseClause: what marks a word as a name, and what a run crosses', () => {
    it.each([
      ['a possessive', "Kessel Tools. We resell Kessel's range across the north. Our tools are plain."],
      ['a comma', 'Kessel Tools. Every depot we fit runs on Kessel, and our tools are plain.'],
      ['the end of the text', 'Kessel Tools. Our tools are plain and every depot we fit runs on Kessel'],
    ])('PLANTED: a word used as a name in running text before %s keeps its capital in a clause from a heading', (_what, page) => {
      expect(sentenceCaseClause('you resell Kessel Tools', 'Kessel Tools', page)).toBe('you resell Kessel tools')
    })
    it('the same heading on a page that never uses the word in a sentence is lowered whole (control)', () => {
      expect(sentenceCaseClause('you resell Kessel Tools', 'Kessel Tools', 'Kessel Tools. Our tools are plain.')).toBe('you resell kessel tools')
    })
    it.each([
      ['or', 'you provide Payroll Audits or Rota Reviews for care homes', 'you provide payroll audits or rota reviews for care homes'],
      ['&', 'you provide Payroll Audits & Rota Reviews for care homes', 'you provide payroll audits & rota reviews for care homes'],
    ])('PLANTED: "%s" between two capitalised words does not end the run', (join, clause, lowered) => {
      // "payroll" is the only word of the run the page writes in lower case.
      const page = `Payroll Audits ${join} Rota Reviews for care homes. Our payroll work is plain.`
      expect(sentenceCaseClause(clause, `Our team provides Payroll Audits ${join} Rota Reviews for care homes and elsewhere today.`, page)).toBe(lowered)
    })
    it('PLANTED: "of" between two capitalised words does not end the run', () => {
      const page = 'The School of Coaching Programmes. Our coaching is plain.'
      expect(sentenceCaseClause('you run the School of Coaching Programmes for managers', 'We run the School of Coaching Programmes for managers in the north today.', page))
        .toBe('you run the school of coaching programmes for managers')
    })
    it('a plain word between two capitalised words does end the run (control)', () => {
      const page = 'Payroll Audits. Rota Reviews. Our payroll work is plain.'
      expect(sentenceCaseClause('you provide Payroll Audits with Rota Reviews for care homes', 'Our team provides Payroll Audits with Rota Reviews for care homes and elsewhere today.', page))
        .toBe('you provide payroll audits with Rota Reviews for care homes')
    })
    it('PLANTED: a quote is a heading at four capitalised long words of five, and not at three of six', () => {
      // Neither "Marlow" nor "Method" is ever in lower case on the page, so only the heading rule can lower them.
      const page = 'We run Marlow Method workshops for senior Kessel teams.'
      expect(sentenceCaseClause('you run Marlow Method workshops', 'We run Marlow Method workshops for senior Kessel teams', page)).toBe('you run Marlow Method workshops')
      // Control: one lower-case long word among five does not stop a heading being one.
      expect(sentenceCaseClause('you sell Payroll Software', 'Payroll Software built for Care Homes', 'Payroll Software built for Care Homes.')).toBe('you sell payroll software')
    })
  })

  describe('the known acronyms, symbols and prepositions', () => {
    it('PLANTED: the list of short forms a reader knows is exactly this one', () => {
      // The tests above follow the list the code exports, so an entry could be dropped from
      // it with all of them green. The prompt states this list to the model: a change here
      // is a change to what passes, and wants a new checks version.
      expect(KNOWN_ACRONYM_LIST).toBe('HR, IT, AI, UK, US, USA, EU, UAE, CEO, B2B, B2C')
      // Control: one that is not on it is found.
      expect(findUnexplainedAcronyms('you advise CFOs')).toEqual(['CFOs'])
    })
    it.each(['|', '\\', '*', '@', '=', '<', '>', '~', '^'])('PLANTED: "%s" in a clause is a symbol, and the clause is refused', symbol => {
      const clause = `you build tools ${symbol} apps for food wholesalers`
      expect(checkDoesClause(clause, PAGE + ' We build tools and apps for food wholesalers.', new Set<string>()).reasons.join(' | ')).toContain('holds a symbol')
    })
    it('the same clause with a word in that place holds no symbol (control)', () => {
      expect(checkDoesClause('you build tools and apps for food wholesalers', PAGE + ' We build tools and apps for food wholesalers.', new Set<string>()).reasons.join(' | ')).not.toContain('holds a symbol')
    })
    it.each([
      ['in', 'a consultancy in Northtown'], ['by', 'a studio by the sea'], ['at', 'a team at work'], ['on', 'a firm on call'],
      ['from', 'a spin-out from Vantor'], ['into', 'a way into work'], ['between', 'a bridge between teams'],
      ['about', 'a firm about people'], ['through', 'a route through change'], ['across', 'a network across regions'],
    ])('PLANTED: "%s" is a preposition, and a kind holding it is a phrase about something', (_word, kind) => {
      expect(kindHoldsAPreposition(kind)).toBe(true)
      expect(kindFormReasons(kind, null).join(' | ')).toContain('holds a preposition')
    })
    it('a kind that only holds a word starting like one is not refused (control)', () => {
      for (const kind of ['an insurance broker', 'a forestry contractor', 'an online tutoring agency']) expect(kindHoldsAPreposition(kind), kind).toBe(false)
    })
  })
})
