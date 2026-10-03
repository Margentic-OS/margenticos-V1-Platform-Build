// The firm's name as it is said inside a sentence. Invented names only.
//
// THE FIFTH READING, 2026-10-02, CHANGED FIVE EXPECTATIONS IN THIS FILE. Until then a
// trailing word like "Consulting" or "Holdings" stayed in the name. The operator's rule now
// drops trailing generic business words when what is left is distinctive, keeps the full
// name when what is left is a place or a common word, and says "your firm" when nothing
// distinctive is left: when every word was a generic business word, and also when the name
// is one word that is a place or a common word ("Denver Ltd", "Orchard GmbH"). Each changed
// case below carries a comment that says CHANGED and why.
//
// THE REVIEW OF THE FIFTH READING, the same day, CHANGED THREE MORE, each marked CHANGED BY
// THE REVIEW: "Quiet Harbour Group" and "Quiet Harbour Strategy Consulting" (a remainder
// of several ordinary words is no longer a name) and "Kessel Marsh Tax & Advisory" (the
// joined trade word comes off only when one word stands in front of it). It also renamed
// one invented firm, whose shape was too close to a real record; its expectation did not
// change. Everything else the review added is a new planted case, and each was seen to
// fail before the code changed.
//
// THE SECOND ROUND OF THE REVIEW, the same day, CHANGED ONE MORE, marked CHANGED BY THE
// SECOND ROUND: the trade-word helper now keeps digits ("3pl"). Its new planted cases are
// a word inside a listed place of several words, a hyphenated word, the joins of other
// languages, the missing demonyms (with a test pairing every listed country to one), the
// one form trade words are compared in, and a comma-joined list of trades.
//
// THE SIXTH READING, 2026-10-03, CHANGED MORE THAN ANY ROUND BEFORE IT, each marked CHANGED
// BY THE SIXTH READING with the old expectation. The operator: "short names drop trailing
// descriptors and initialisms; places and trade words keep the full name". A COMMON ENGLISH
// WORD NO LONGER BLOCKS a short name, so every case that kept its full name only because
// what was left was ordinary words ("Orchard Group", "Real Estate Advisors", "Quiet
// Harbour Group", "Los Angeles Tax Advisors") is now said by what is left. A trailing
// initialism comes off ("Quillon HCM Consulting Group" is "Quillon"), and so do the firm's
// own trade words ("Kessel Logistics Group" with logistics on its record is "Kessel"). The
// operator's own three examples are real prospects' names, so the cases here are invented
// names of the same three shapes.
//
// A REMAINDER IS SAID WHEN ONE WORD IN IT NAMES SOMETHING: three characters or more, and
// not a place, a nationality, a weekday, a month, one of the calling client's generic words
// or one of the firm's own trade words, and not inside a run of words that is a place. A
// hyphenated word is one when one of its parts is. "Kessel", "Marlow", "Vantor" and
// "Northtown" are on no list, and a control at the foot of this file holds that true.

import { describe, it, expect } from 'vitest'
import { companyShortName, firmTradeWords, COMPANY_SHORT_NAME_MAX_CHARS } from '../company-short-name'
import { COMMON_ENGLISH_WORDS } from '../common-words.data'
import {
  PLACE_NAMES,
  PLACE_QUALIFIERS,
  DEMONYMS_AND_CALENDAR_WORDS,
  COUNTRIES_AND_TERRITORIES,
  COUNTRIES_WITHOUT_A_DEMONYM,
  DEMONYM_OF_COUNTRY,
} from '../place-names.data'

const NONE = new Set<string>()
// What names nothing on one invented client's list: the client writes to hauliers.
const CLIENT = new Set(['haulage', 'haulier', 'hauliers', 'logistics'])

describe('companyShortName', () => {
  it.each([
    ['The NTW Company', 'NTW'],
    ['Northtown Design, Inc.', 'Northtown Design'],
    ['Northtown Design Inc', 'Northtown Design'],
    ['Coldharbour Rooms Ltd', 'Coldharbour Rooms'],
    ['Coldharbour Rooms Limited', 'Coldharbour Rooms'],
    ['Kessel Marsh LLP', 'Kessel Marsh'],
    ['Kessel Marsh, L.L.C.', 'Kessel Marsh'],
    // CHANGED, was "Brightwater Holdings": "Holdings" says a business exists and nothing
    // else, and "Brightwater" alone is neither a place nor a common word.
    ['Brightwater Holdings Co., Ltd.', 'Brightwater'],
    ['Kessel GmbH', 'Kessel'],
    // CHANGED BY THE SIXTH READING, was "Orchard Group": a common word no longer keeps the
    // full name.
    ['the Orchard Group', 'Orchard'],
    ['Rêve Atelier', 'Rêve Atelier'],
    ['Kessel and Co', 'Kessel'],
    // CHANGED, was "Northtown Consulting" under "a market's own word stays". "Consulting"
    // is now one of the service words that come off in every market.
    ['Northtown Consulting', 'Northtown'],
    ['IBX', 'IBX'],
    // One "&" between two words is how partnerships are named, and reads correctly.
    ['Kessel Joinery & Design, Inc', 'Kessel Joinery & Design'],
    ['Marlow & Kessel', 'Marlow & Kessel'],
    // A bracketed tag is dropped, as a legal form is.
    ['Northtown (UK) Ltd', 'Northtown'],
    ['Northtown (Holdings) Design', 'Northtown Design'],
    // Marks INSIDE a word are part of the name.
    ['Northtown-West Roofing', 'Northtown-West Roofing'],
    ["O'Neill Roofing Ltd", "O'Neill Roofing"],
    ['Northtown.io', 'Northtown.io'],
    // An abbreviation keeps its stop where a capital follows: nothing is respelled.
    // CHANGED, was "St. James Partners": "Partners" is an entity word, and "James" is on
    // neither list.
    ['St. James Partners', 'St. James'],
  ])('PLANTED: "%s" is said as "%s"', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })

  it.each([
    ['a comma inside the name', 'Northtown, Southtown Design'],
    ['a slash', 'Northtown/Southtown Design'],
    // THE REVIEW OF 2026-10-02: each of these went out in a sentence under the first version.
    ['an en dash between words', 'Northtown – Roofing'],
    ['an em dash between words', 'Northtown — Cold Storage'],
    ['a hyphen standing as its own word', 'Northtown - West Ltd'],
    ['a tagline after a dash, which also loses its last word', 'Northtown - A Hartwell Company'],
    ['a name ending in a full stop, which ends the sentence it sits in', 'Kessel Bros.'],
    ['an abbreviation followed by a lower-case word, which would be capitalised', 'Northtown Sp. z o.o.'],
    ['a name ending in an exclamation mark', 'Northtown!'],
    ['a name ending in a question mark', 'Northtown Cold Storage?'],
    ['two ampersands', 'Marlow & Kessel & Orchard'],
    ['an ampersand at the end', 'Marlow &'],
    ['curly quotes', 'Northtown “Prime” Roofing'],
    ['straight quotes', 'Northtown "Prime" Roofing'],
    ['an at sign', 'Northtown @ Home'],
    ['a merge tag', 'Northtown {{first_name}}'],
    ['a colon', 'Northtown: Cold Storage'],
    ['a plus sign', 'Northtown + Kessel'],
    ['a value that is not a firm', 'Self-employed'],
    ['a value that is not a firm, two words', 'Self Employed'],
    ['a value that is not a firm', 'Freelance'],
    ['a value that is not a firm', 'Confidential'],
    ['a value that is not a firm', 'Stealth Startup'],
    ['a value that is not a firm', 'Independent Consultant'],
    ['a value that is not a firm', 'Retired'],
    ['a value that is not a firm', 'Unknown'],
    ['more than four words', 'Northtown Cold Room Engineering Works'],
    ['all capitals', 'NORTHTOWN DESIGN LTD'],
    ['no capital at all', 'northtown design'],
    ['a lower-case first letter, which a sentence start would respell', 'eNorth Design'],
    ['nothing left but a form', 'The Company'],
    ['one letter', 'N Ltd'],
  ])('PLANTED: %s is not used in a sentence ("%s")', (_why, stored) => {
    expect(companyShortName(stored, NONE)).toBeNull()
  })

  it('PLANTED: more than the character cap is not used, and the cap is what the templates are validated against', () => {
    const long = 'Northtownshire Coldharbourside Atelier'
    expect(long.length).toBeGreaterThan(COMPANY_SHORT_NAME_MAX_CHARS)
    expect(companyShortName(long, NONE)).toBeNull()
  })

  it('PLANTED: what names no firm is the calling client\'s to say', () => {
    // For a client that writes to hauliers, "Haulage Logistics" names nobody in particular.
    expect(companyShortName('Haulage Logistics Ltd', CLIENT)).toBeNull()
    // Control: for another client it is a name like any other.
    expect(companyShortName('Haulage Logistics Ltd', NONE)).toBe('Haulage Logistics')
  })

  describe('a firm named after the reader', () => {
    const jane = { firstName: 'Jane', lastName: 'Marlow' }
    it.each(['Jane Marlow Ltd', 'Dr. Jane Marlow', 'Dr Jane Marlow', 'Jane Marlow PhD', 'Marlow Ltd', 'The Jane Marlow Company'])(
      'PLANTED: "%s" is not written back to Jane Marlow in the third person', stored => {
        expect(companyShortName(stored, NONE, jane)).toBeNull()
      })
    it('one word that is not the reader\'s makes it a firm\'s name (control)', () => {
      expect(companyShortName('Marlow Design Ltd', NONE, jane)).toBe('Marlow Design')
      expect(companyShortName('Jane Marlow Consulting', NONE, jane)).toBe('Jane Marlow Consulting')
    })
    it('with no reader given, the same name is used (control: the rule is about the reader)', () => {
      expect(companyShortName('Jane Marlow Ltd', NONE)).toBe('Jane Marlow')
      expect(companyShortName('Jane Marlow Ltd', NONE, { firstName: 'Tom', lastName: 'Kessel' })).toBe('Jane Marlow')
    })
    it('PLANTED: a remainder that is the reader\'s own name is not said, and the full name is', () => {
      // One word left, and it is the reader's surname: titles ignored, first or last.
      expect(companyShortName('Marlow Consulting', NONE, { lastName: 'Marlow' })).toBe('Marlow Consulting')
      expect(companyShortName('Jane Advisory Ltd', NONE, { firstName: 'Jane' })).toBe('Jane Advisory')
      // Two words left, and they are the reader.
      expect(companyShortName('Jane Marlow Group', NONE, jane)).toBe('Jane Marlow Group')
      expect(companyShortName('Dr. Jane Marlow Consulting', NONE, jane)).toBe('Dr. Jane Marlow Consulting')
      // Control: written to anybody else, the same firms are shortened.
      expect(companyShortName('Marlow Consulting', NONE)).toBe('Marlow')
      expect(companyShortName('Marlow Consulting', NONE, { firstName: 'Tom', lastName: 'Kessel' })).toBe('Marlow')
      expect(companyShortName('Jane Marlow Group', NONE)).toBe('Jane Marlow')
    })
    it('PLANTED: an initial or a possessive does not make the reader\'s name a firm\'s name', () => {
      // THE REVIEW OF THE FIFTH READING: each of these came back as "J Marlow", "Jane M
      // Marlow" and "Marlow's", written to Jane Marlow.
      expect(companyShortName('J Marlow Consulting', NONE, jane)).toBe('J Marlow Consulting')
      expect(companyShortName('J. Marlow Consulting', NONE, jane)).toBe('J. Marlow Consulting')
      expect(companyShortName('Jane M Marlow Consulting', NONE, jane)).toBe('Jane M Marlow Consulting')
      expect(companyShortName("Marlow's Consulting", NONE, jane)).toBe("Marlow's Consulting")
      expect(companyShortName('Marlow’s Consulting', NONE, jane)).toBe('Marlow’s Consulting')
      // With no generic word to fall back to, there is nothing to say.
      expect(companyShortName('J. Marlow Ltd', NONE, jane)).toBeNull()
      expect(companyShortName('J Marlow Ltd', NONE, jane)).toBeNull()
      expect(companyShortName("Marlow's Ltd", NONE, jane)).toBeNull()
      // Control: written to anybody else, or with another surname, the same shapes are names.
      expect(companyShortName('J Marlow Consulting', NONE)).toBe('J Marlow')
      expect(companyShortName("Marlow's Consulting", NONE, { firstName: 'Tom', lastName: 'Kessel' })).toBe("Marlow's")
      expect(companyShortName('J Kessel Consulting', NONE, jane)).toBe('J Kessel')
    })
  })

  it('PLANTED: the word cap, the capital and the form-word guards each refuse what they are for', () => {
    // Five words, under the character cap: only the word cap refuses it.
    expect('Ab Cd Ef Gh Ij'.length).toBeLessThanOrEqual(COMPANY_SHORT_NAME_MAX_CHARS)
    expect(companyShortName('Ab Cd Ef Gh Ij', NONE)).toBeNull()
    expect(companyShortName('Ab Cd Ef Gh', NONE)).toBe('Ab Cd Ef Gh')
    // Opens on a digit and holds no capital anywhere.
    expect(companyShortName('360 northtown', NONE)).toBeNull()
    expect(companyShortName('360 Northtown', NONE)).toBe('360 Northtown')
  })

  it.each([null, undefined, '', '   '])('no name on the record gives null (%s)', stored => {
    expect(companyShortName(stored as string | null | undefined, NONE)).toBeNull()
  })

  it('PLANTED: it only removes words: a name is never shortened to "the distinctive word"', () => {
    expect(companyShortName('Higher Ground Design', NONE)).toBe('Higher Ground Design')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SHORTER NAME (operator note 2 on the fifth reading, 2026-10-02)

describe('companyShortName: trailing generic business words', () => {
  it.each([
    // A service word.
    ['Kessel Consulting', 'Kessel'],
    ['Marlow Advisors', 'Marlow'],
    ['Kessel Advisory', 'Kessel'],
    ['Vantor Solutions', 'Vantor'],
    ['Kessel Consultancy Services', 'Kessel'],
    // An entity word.
    ['Vantor Group', 'Vantor'],
    ['Kessel Partners', 'Kessel'],
    ['Vantor Holdings', 'Vantor'],
    ['Kessel International', 'Kessel'],
    // Several, one after another, with a legal form behind them.
    ['Vantor Consulting Group', 'Vantor'],
    ['Kessel Group Consulting Inc.', 'Kessel'],
    ['Vantor Global Advisory Services Ltd', 'Vantor'],
    // "Co" in front of another generic word, where the legal form pass never reaches it.
    ['Kessel Co. Consulting', 'Kessel'],
    // A comma left hanging where a word came off.
    ['Kessel Marsh, Consulting', 'Kessel Marsh'],
    // The match is on letters, whatever the case.
    ['Kessel consulting', 'Kessel'],
    ['Vantor GROUP', 'Vantor'],
    // An acronym of three letters is a name. The operator's own example had this shape.
    ['NTW Group', 'NTW'],
    ['The NTW Company', 'NTW'],
  ])('PLANTED: "%s" is said as "%s"', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })

  // THE TWO LISTS, WORD BY WORD. They are the operator's, and a word quietly dropped from
  // one would send a registered style back into a sentence with nothing else to notice.
  it.each([
    'Group', 'Partners', 'Partner', 'Associates', 'Holdings', 'Enterprises', 'Ventures', 'International', 'Worldwide',
    'Global', 'Industries', 'Collective', 'Company', 'Co',
  ])('PLANTED: the entity word "%s" comes off the end of a name', word => {
    expect(companyShortName(`Kessel ${word}`, NONE)).toBe('Kessel')
    // An entity word leaves the word joined to it: that word is the name.
    expect(companyShortName(`Kessel Marsh & ${word}`, NONE)).toBe('Kessel Marsh')
  })

  it.each([
    'Consulting', 'Consultants', 'Consultancy', 'Consultancies', 'Advisors', 'Advisers', 'Advisory', 'Solutions',
    'Services',
  ])('PLANTED: the service word "%s" comes off the end of a name, with the trade joined to it', word => {
    expect(companyShortName(`Kessel ${word}`, NONE)).toBe('Kessel')
    expect(companyShortName(`Kessel Marsh & ${word}`, NONE)).toBe('Kessel')
  })

  it.each([
    // The word joined to a SERVICE word is a trade, and goes with it, when it is a common
    // word and ONE word stands in front of it.
    ['Vantor Surveying & Consulting, Inc', 'Vantor'],
    ['Vantor Tax and Advisory Ltd', 'Vantor'],
    ['Kessel Research and Consulting Group', 'Kessel'],
    ['Kessel Tax & Advisory', 'Kessel'],
    // CHANGED BY THE REVIEW OF THE FIFTH READING, was "Kessel Marsh": two words stand in
    // front of the join, so code cannot tell which of them the trade is. Only the join and
    // the service word go.
    ['Kessel Marsh Tax & Advisory', 'Kessel Marsh Tax'],
    // THE REVIEW: these were cut to "Kessel Real", "Kessel Human" and "Kessel Public", one
    // word of a two-word trade.
    ['Kessel Real Estate & Advisory', 'Kessel Real Estate'],
    ['Kessel Human Resources & Consulting', 'Kessel Human Resources'],
    ['Kessel Public Relations and Consulting', 'Kessel Public Relations'],
    // THE REVIEW: a joined word on no list may be a partner's surname, and was cut to "Kessel".
    ['Kessel Trennick & Advisors', 'Kessel Trennick'],
    // A trade word on no list is kept for the same reason: code cannot tell it from a surname.
    ['Kessel Haulage & Consulting', 'Kessel Haulage'],
    // The word joined to an ENTITY word is the name, and stays.
    ['Marlow & Associates', 'Marlow'],
    ['Marlow and Partners', 'Marlow'],
    ['Kessel Marsh & Associates', 'Kessel Marsh'],
    // Control: an "&" between two names is not a join onto a generic word.
    ['Marlow & Kessel LLP', 'Marlow & Kessel'],
    ['Marlow & Kessel Consulting', 'Marlow & Kessel'],
  ])('PLANTED: a join left at the end goes, and a trade word goes only with a service word ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })

  it('PLANTED: a list of common trade words, joined by commas and one join, goes with the service word', () => {
    // THE SECOND ROUND OF THE REVIEW. These were "your firm" by accident: the comma stayed
    // inside the remainder, and the full name has it too. Now they are decided: one word
    // stands in front, every word between it and the service word is a common word, and
    // they are joined by commas and one "and" or "&". That is a list of trades.
    expect(companyShortName('Kessel Tax, Audit & Advisory', NONE)).toBe('Kessel')
    expect(companyShortName('Kessel Audit, Tax & Advisory', NONE)).toBe('Kessel')
    expect(companyShortName('Kessel Tax, Audit and Advisory Ltd', NONE)).toBe('Kessel')
    // Control: a word on no list in the list may be a partner, and two words in front may
    // be a two-word name. Either way the comma stays, so the full name cannot be said either.
    expect(companyShortName('Kessel Trennick, Tax & Advisory', NONE)).toBeNull()
    expect(companyShortName('Kessel Marsh Tax, Audit & Advisory', NONE)).toBeNull()
    // Control: a list joined onto an ENTITY word is not a trade.
    expect(companyShortName('Kessel Tax, Audit & Associates', NONE)).toBeNull()
  })

  it('PLANTED: a trade word is never the only word taken, so a name of nothing else is said in full', () => {
    // Without the "a word is left in front of it" condition "Tax" would go, nothing would
    // be left, and the firm would become "your firm".
    expect(companyShortName('Tax & Advisory Ltd', NONE)).toBe('Tax & Advisory')
    // THE SIXTH READING: a common word no longer blocks a short name, but "Tax" here is not
    // a name left over. It is the trade joined to the service word, and a trade keeps the
    // full name. "so Tax can win the right clients" is the sentence this holds off.
    expect(companyShortName('Tax, Audit & Advisory', NONE)).toBeNull()
  })

  it.each([
    // CHANGED BY THE SIXTH READING. Each kept its full name because what was left is a
    // common word. The operator: "short names drop trailing descriptors". The first stands
    // in for his own example of this shape, which is a real firm's name.
    ['Harbour Consulting', 'Harbour'],
    ['Lantern Consulting Group', 'Lantern'],
    ['Bridge Partners', 'Bridge'],
    ['Beacon Advisory Services', 'Beacon'],
    ['Amber Ridge Consulting', 'Amber Ridge'],
    ['Bright Meadow Consulting', 'Bright Meadow'],
  ])('PLANTED: a remainder of common words is said ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })

  it.each([
    // THE SIXTH READING: a trailing initialism comes off, as a descriptor does. Invented,
    // in the shape of the operator's own example.
    ['Quillon HCM Consulting Group', 'Quillon'],
    ['Kessel HR Ltd', 'Kessel'],
    ['Amber Ridge CX Advisors', 'Amber Ridge'],
    ['Kessel UK', 'Kessel'],
    // A name that IS an initialism keeps its capitals: there is nothing in front of it.
    ['The QTX Company', 'QTX'],
    ['QTX Group', 'QTX'],
  ])('PLANTED: a trailing initialism comes off ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })
  it('an initialism that is not trailing, joined by "&", mixed case or with a digit stays (control)', () => {
    expect(companyShortName('JB Kessel Advisory', NONE)).toBe('JB Kessel')
    expect(companyShortName('Marlow & KMR Consulting', NONE)).toBe('Marlow & KMR')
    expect(companyShortName('Kessel SaaS Consulting', NONE)).toBe('Kessel SaaS')
    expect(companyShortName('Kessel B2B Consulting', NONE)).toBe('Kessel B2B')
    // Six capitals is a word typed in capitals, not an initialism.
    expect(companyShortName('Kessel NORTHX Consulting', NONE)).toBe('Kessel NORTHX')
  })
  it('PLANTED: what an initialism leaves is held to the same refusals', () => {
    // "Denver" is a place: the full name is said.
    expect(companyShortName('Denver HCM Consulting', NONE)).toBe('Denver HCM Consulting')
    expect(companyShortName('Denver HCM Ltd', NONE)).toBe('Denver HCM')
    // Control: with no initialism, a place alone is "your firm".
    expect(companyShortName('Denver Ltd', NONE)).toBeNull()
  })

  it.each([
    ['Denver Advisory Partners'],
    ['Georgia Solutions'],
    ['London Consulting'],
    ['Pacific Partners'],
    // Looked up without its accent, and without its full stop.
    ['Zürich Advisory'],
    // A place of two words, taken whole.
    ['New York Consulting'],
    ['St. Louis Partners'],
  ])('PLANTED: a remainder that is a place keeps the full name ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })

  it('a place that is only part of the remainder does not hold it back (control)', () => {
    expect(companyShortName('Kessel Denver Consulting', NONE)).toBe('Kessel Denver')
  })
  it('PLANTED: a one-word place keeps the full name and alone is "your firm", under the sixth reading too', () => {
    expect(companyShortName('Denver Consulting', NONE)).toBe('Denver Consulting')
    expect(companyShortName('Denver', NONE)).toBeNull()
  })

  it('PLANTED: a remainder under three characters keeps the full name', () => {
    expect(companyShortName('QX & Associates', NONE)).toBe('QX & Associates')
    expect(companyShortName('QX Consulting', NONE)).toBe('QX Consulting')
    // Control: three characters is a name.
    expect(companyShortName('QXV & Associates', NONE)).toBe('QXV')
  })

  it.each([
    ['Kessel Marsh Consulting Group', 'Kessel Marsh'],
    ['Kessel Denver Consulting', 'Kessel Denver'],
    ['Marlow & Kessel Consulting', 'Marlow & Kessel'],
    // The three-character floor is for a remainder of ONE word. Initials in front of a
    // second word are part of a name.
    ['JB Kessel Advisory', 'JB Kessel'],
  ])('PLANTED: a remainder of two words or more is distinctive when one of its words is on neither list ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })

  // THE REVIEW OF THE FIFTH READING, 2026-10-02. Until then ANY remainder of two words or
  // more was a name, so a bare trade phrase and a bare region went out as the firm:
  // "so Human Resources can win the right clients", "Does that match what North Texas sees?".
  it.each([
    // A region: a compass word and a place, or a listed region of two words.
    ['North Texas Advisors'],
    ['Greater Boston Consulting'],
    ['Twin Cities Advisors'],
    ['Thames Valley Advisors'],
  ])('PLANTED: a remainder of several words that is a place keeps the full name ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })

  it.each([
    // CHANGED BY THE SIXTH READING, each was the full name: every word of what is left is a
    // common word, or a place beside one, and a common word no longer keeps the full name.
    // THE KNOWN COST, accepted with the operator's rule: a trade said in ordinary words is
    // said alone unless the firm's own record names it (see the trade-word tests below).
    ['Real Estate Advisors', 'Real Estate'],
    ['Human Resources Consulting', 'Human Resources'],
    ['Supply Chain Solutions', 'Supply Chain'],
    ['Health and Safety Consultants', 'Health and Safety'],
    ['IT Support Solutions', 'IT Support'],
    ['Denver Tax Advisors', 'Denver Tax'],
    ['Quiet Harbour Group', 'Quiet Harbour'],
  ])('PLANTED: a remainder of common words, or of a place and a common word, is said ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })
  it('PLANTED: the same trade said in ordinary words keeps the full name when the firm\'s record names it', () => {
    expect(companyShortName('Real Estate Advisors', NONE, {}, firmTradeWords('Real Estate', null))).toBe('Real Estate Advisors')
    expect(companyShortName('Human Resources Consulting', NONE, {}, firmTradeWords('Human Resources', []))).toBe('Human Resources Consulting')
  })

  it('PLANTED: the calling client\'s generic word is not the distinctive word of a remainder either', () => {
    // A client word beside a place: nothing in what is left names the firm.
    expect(companyShortName('Haulage Denver Consulting', CLIENT)).toBe('Haulage Denver Consulting')
    // CHANGED BY THE SIXTH READING, was the full name: "Freight" is a common word, and a
    // common word now names the firm.
    expect(companyShortName('Haulage Freight Consulting', CLIENT)).toBe('Haulage Freight')
    // Control: for a client with no such word, "Haulage" is on neither list and makes it a name.
    expect(companyShortName('Haulage Freight Consulting', NONE)).toBe('Haulage Freight')
    expect(companyShortName('Haulage Denver Consulting', NONE)).toBe('Haulage Denver')
  })

  it('PLANTED: a full name over the cap is said by its remainder', () => {
    // CHANGED BY THE SIXTH READING, was null: the remainder is three common words, which
    // are now said.
    const stored = 'Quiet Harbour Strategy Consulting'
    expect(stored.length).toBeGreaterThan(COMPANY_SHORT_NAME_MAX_CHARS)
    expect(companyShortName(stored, NONE)).toBe('Quiet Harbour Strategy')
    expect(companyShortName('Kessel Harbour Strategy Consulting', NONE)).toBe('Kessel Harbour Strategy')
    // Control: a remainder that is a place is not said, and the full name is over the cap.
    expect('Greater Manchester Consultancy Group'.length).toBeGreaterThan(COMPANY_SHORT_NAME_MAX_CHARS)
    expect(companyShortName('Greater Manchester Consultancy Group', NONE)).toBeNull()
  })

  it.each([
    ['New York Ltd'],
    ['San Francisco Inc'],
    ['Los Angeles LLC'],
    // A compass word or "Greater" in front of a listed place is a place, by rule.
    ['North Texas Ltd'],
    ['Greater Manchester LLC'],
    ['North West England Ltd'],
    ['Thames Valley Ltd'],
  ])('PLANTED: a name that is ONLY a place, in any number of words, is "your firm" ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBeNull()
  })
  it('a place with a word in front of it that is on neither list is a name (control)', () => {
    expect(companyShortName('Kessel York Ltd', NONE)).toBe('Kessel York')
    expect(companyShortName('Greater Kessel LLC', NONE)).toBe('Greater Kessel')
  })

  // THE SECOND ROUND OF THE REVIEW, 2026-10-02. A listed place of several words was looked
  // up only as the WHOLE remainder, so beside a common word it was read word by word, and
  // "los", "hong" and "diego" are on no list: "so Los Angeles Tax can win the right clients".
  it.each([
    // CHANGED BY THE SIXTH READING, each was the full name. The run of words that is a place
    // still names nothing, as before, but the common word beside it now does.
    ['Los Angeles Tax Advisors', 'Los Angeles Tax'],
    ['Hong Kong Tax Advisors', 'Hong Kong Tax'],
    ['St. Louis Tax Advisors', 'St. Louis Tax'],
    ['San Diego Wealth Advisors', 'San Diego Wealth'],
    ['El Paso Legal Consulting', 'El Paso Legal'],
  ])('PLANTED: a listed place of several words beside a common word is said with it ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
  })
  it.each([
    ['Los Angeles Advisors'],
    ['San Diego Consulting Group'],
    // A run that is a place, and a client's generic word beside it: nothing names the firm.
    ['Los Angeles Haulage Consulting'],
  ])('PLANTED: a remainder whose every word sits in a place, or is the client\'s, keeps the full name ("%s")', stored => {
    expect(companyShortName(stored, CLIENT)).toBe(stored)
  })
  it('a place of several words beside a word on no list is still part of a name (control)', () => {
    expect(companyShortName('Kessel Hong Kong Consulting', NONE)).toBe('Kessel Hong Kong')
    expect(companyShortName('Kessel Los Angeles Group', NONE)).toBe('Kessel Los Angeles')
  })

  // THE SECOND ROUND OF THE REVIEW. A hyphenated word matched no entry on any list, so a
  // hyphenated region or trade was a name: "so Asia-Pacific can win the right clients".
  it('CHANGED BY THE SIXTH READING: a hyphenated pair of common words is said, as the pair is', () => {
    // Was the full name "Real-Estate Advisors".
    expect(companyShortName('Real-Estate Advisors', NONE)).toBe('Real-Estate')
  })
  it.each([
    ['Asia-Pacific Advisors'],
    ['North-Texas Advisors'],
    ['Pan-European Solutions'],
    // A place of two words written with a hyphen: neither part is on a list by itself.
    ['Los-Angeles Advisors'],
  ])('PLANTED: a hyphenated word is distinctive only through a distinctive part ("%s" keeps the full name)', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })
  it('PLANTED: and a name that is only such a word is "your firm"', () => {
    expect(companyShortName('Asia-Pacific Ltd', NONE)).toBeNull()
  })
  it('a hyphenated word with a part on no list is a name (control)', () => {
    expect(companyShortName('Marlow-Kessel Consulting', NONE)).toBe('Marlow-Kessel')
    expect(companyShortName('Northtown-West Roofing', NONE)).toBe('Northtown-West Roofing')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // WORDS THAT MUST NOT BE SAID ALONE (the review of the fifth reading, 2026-10-02)

  it.each([
    ['American Consulting Group'],
    ['British Advisory Services'],
    ['European Solutions'],
    ['Canadian Consulting'],
    ['Scottish Consulting'],
    ['Irish Advisors'],
    ['Asian Solutions Group'],
    ['Texan Consulting'],
    ['Celtic Advisory'],
    ['North American Advisors'],
    ['Friday Solutions'],
    ['Monday Consulting'],
    ['April Consulting'],
  ])('PLANTED: a nationality, a weekday or a month is not said alone ("%s" keeps the full name)', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })
  // THE SECOND ROUND OF THE REVIEW: 62 of 197 country demonyms were missing, and the
  // regional adjectives with them. Each of these went out as the adjective alone.
  it.each([
    ['Dominican Consulting'],
    ['Costa Rican Consulting'],
    ['Puerto Rican Advisors'],
    ['Sri Lankan Consulting'],
    ['Nepali Consulting'],
    ['Salvadoran Consulting'],
    ['Luxembourgish Advisors'],
    ['Alpine Consulting'],
    ['Iberian Advisors'],
    ['Balkan Solutions'],
    ['Caledonian Consulting'],
    ['Hibernian Advisors'],
    ['Midwestern Consulting'],
    ['Appalachian Advisors'],
  ])('PLANTED: the demonyms the first list missed are not said alone either ("%s" keeps the full name)', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })

  it('CHANGED BY THE SIXTH READING: a demonym beside a common word is said with it', () => {
    // Was the full name "American Tax Advisors". "American" alone still names nothing.
    expect(companyShortName('American Tax Advisors', NONE)).toBe('American Tax')
  })

  it('PLANTED: and a name that is only one of them is "your firm", as a place is', () => {
    expect(companyShortName('American Ltd', NONE)).toBeNull()
    expect(companyShortName('Friday LLC', NONE)).toBeNull()
    // With a compass word in front, as a place is.
    expect(companyShortName('North American Ltd', NONE)).toBeNull()
  })

  it.each([
    // The operator's examples on 2026-10-02 were real firms' names. These are invented
    // names of the same three shapes: a rare word, another rare word, three capitals.
    ['Quarvel Consulting', 'Quarvel'],
    ['Tessaly Group', 'Tessaly'],
    ['QTX Advisors', 'QTX'],
  ])('PLANTED: names shaped like the operator\'s own examples still shorten ("%s" is "%s")', (stored, said) => {
    expect(companyShortName(stored, NONE)).toBe(said)
    // And with trade words that are not the name, nothing changes.
    expect(companyShortName(stored, NONE, {}, firmTradeWords('Management Consulting', ['strategy', 'operations']))).toBe(said)
  })

  describe('the firm\'s own trade words, from its stored industry and keywords', () => {
    // Built inside each test, so a fault in the helper fails the tests that use it and not
    // the collection of the whole file.
    const tradeWords = () => firmTradeWords('Logistics and Supply Chain', ['Freight Forwarding', 'CRM', 'e-commerce', '3PL'])

    it('PLANTED: the helper keeps words of three characters or more, digits included, in lower case, without grammar words', () => {
      // CHANGED BY THE SECOND ROUND, was without "3pl": the helper split on
      // anything that is not a letter, so "3PL" lost its digit and matched nothing.
      expect([...tradeWords()].sort()).toEqual(['3pl', 'chain', 'commerce', 'crm', 'forwarding', 'freight', 'logistics', 'supply'])
      expect(firmTradeWords('Études de Marché', null)).toEqual(new Set(['etudes', 'marche']))
      expect(firmTradeWords(null, undefined).size).toBe(0)
      expect(firmTradeWords('', ['', '  ']).size).toBe(0)
    })

    it('PLANTED: a one-word remainder that is one of the firm\'s own trade words keeps the full name', () => {
      expect(companyShortName('Logistics Solutions', NONE, {}, tradeWords())).toBe('Logistics Solutions')
      expect(companyShortName('Freight Consulting Group', NONE, {}, tradeWords())).toBe('Freight Consulting Group')
      // Code cannot tell "QTX" from "CRM". The record can: it says CRM is this firm's trade.
      expect(companyShortName('CRM Consulting', NONE, {}, tradeWords())).toBe('CRM Consulting')
      // Matched on letters, whatever the case of the caller's set.
      expect(companyShortName('Logistics Solutions', NONE, {}, new Set(['Logistics']))).toBe('Logistics Solutions')
    })

    it('PLANTED: a trade word is not the distinctive word of a longer remainder, and alone it is "your firm"', () => {
      expect(companyShortName('Logistics Forwarding Solutions', NONE, {}, tradeWords())).toBe('Logistics Forwarding Solutions')
      expect(companyShortName('Logistics Ltd', NONE, {}, tradeWords())).toBeNull()
    })

    it('PLANTED: the firm\'s own trade words come off the END of a name, as service words do (the sixth reading)', () => {
      expect(companyShortName('Kessel Logistics Solutions', NONE, {}, tradeWords())).toBe('Kessel')
      expect(companyShortName('Kessel Freight Forwarding', NONE, {}, tradeWords())).toBe('Kessel')
      expect(companyShortName('Amber Ridge Logistics', NONE, {}, tradeWords())).toBe('Amber Ridge')
      // Joined on, as a service word joins: the word in front goes with it.
      expect(companyShortName('Kessel Freight & Logistics', NONE, {}, tradeWords())).toBe('Kessel')
      // Never the last word: a name made only of the firm's trade is said in full.
      expect(companyShortName('Freight Logistics Solutions', NONE, {}, tradeWords())).toBe('Freight Logistics Solutions')
      // Never from the front or the middle.
      expect(companyShortName('Logistics Kessel Group', NONE, {}, tradeWords())).toBe('Logistics Kessel')
    })

    it('with no trade words given, or with other trade words, the same names shorten (control: the KNOWN LIMIT)', () => {
      // "logistics" and "CRM" are on neither list, so nothing but the record can hold them.
      expect(companyShortName('Logistics Solutions', NONE)).toBe('Logistics')
      expect(companyShortName('CRM Consulting', NONE)).toBe('CRM')
      expect(companyShortName('Logistics Solutions', NONE, {}, firmTradeWords('Marketing', ['advertising']))).toBe('Logistics')
      // A name that is not one of the trade words is untouched by them.
      expect(companyShortName('Kessel Consulting', NONE, {}, tradeWords())).toBe('Kessel')
      // CHANGED BY THE SIXTH READING, was "Kessel Logistics": the firm's own trade word now
      // comes off the end. Without the trade words it is part of the name.
      expect(companyShortName('Kessel Logistics Group', NONE, {}, tradeWords())).toBe('Kessel')
      expect(companyShortName('Kessel Logistics Group', NONE)).toBe('Kessel Logistics')
    })

    // THE SECOND ROUND OF THE REVIEW, 2026-10-02. Matching was exact, word for word, so the
    // shapes a record really holds missed: each of these still went out as the one word.
    it.each([
      ['Telecom Consulting', 'Telecommunications', []],
      ['Logistic Solutions', 'Logistics', []],
      ['E-Commerce Solutions', null, ['E-Commerce']],
      ['Ed-Tech Consulting', null, ['Ed-Tech']],
      ['3PL Solutions', null, ['3PL']],
    ])('PLANTED: a name word is compared in the form the trade words are built in ("%s" keeps the full name)', (stored, industry, keywords) => {
      expect(companyShortName(stored, NONE, {}, firmTradeWords(industry, keywords))).toBe(stored)
    })
    it('the same names shorten without those trade words, and a prefix under four characters is no match (control)', () => {
      expect(companyShortName('Telecom Consulting', NONE)).toBe('Telecom')
      expect(companyShortName('Logistic Solutions', NONE)).toBe('Logistic')
      expect(companyShortName('Ed-Tech Consulting', NONE)).toBe('Ed-Tech')
      expect(companyShortName('3PL Solutions', NONE)).toBe('3PL')
      // "Tec" is three letters: too short to be read as the start of "technology".
      expect(companyShortName('Tec Consulting', NONE, {}, firmTradeWords('Technology', null))).toBe('Tec')
      // "law" is a trade word of three letters, and "Lawson" is a surname that starts with it.
      expect(companyShortName('Lawson Consulting', NONE, {}, firmTradeWords('Law Practice', null))).toBe('Lawson')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // A NAME CUT MID-PHRASE (the review of the fifth reading, 2026-10-02)

  it.each([
    // Each went out ending on the small word: "so Institute of can win the right clients".
    ['Institute of Consulting'],
    ['Kessel School of Consulting'],
    ['Board of Advisors'],
    ['Centre for Advisory Services'],
    ['Ask The Advisors'],
    ['Kessel and The Partners'],
  ])('PLANTED: a remainder that ends on a preposition, an article or a join keeps the full name ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })
  // THE SECOND ROUND OF THE REVIEW: the words no name ends on held only English ones, so
  // "Kessel en Partners" went out as "so Kessel en can win the right clients".
  it.each([
    ['Kessel en Partners'],
    ['Kessel und Partner'],
    ['Kessel og Partners'],
    ['Kessel och Partners'],
    ['Kessel et Associates'],
    ['Kessel y Partners'],
    ['Kessel e Associates'],
    ['Kessel de Consulting'],
    ['Kessel van Partners'],
    ['Kessel von Partners'],
    ['Kessel with Partners'],
    ['Kessel on Consulting'],
    ['Kessel from Consulting'],
    ['Kessel or Partners'],
  ])('PLANTED: a remainder that ends on a join or a preposition of another language keeps the full name ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBe(stored)
  })
  it('a small word INSIDE a name is part of it (control)', () => {
    expect(companyShortName('Bank of Northtown', NONE)).toBe('Bank of Northtown')
    expect(companyShortName('Friends of Kessel Group', NONE)).toBe('Friends of Kessel')
    expect(companyShortName('Van Kessel Consulting', NONE)).toBe('Van Kessel')
    expect(companyShortName('Kessel en Marlow', NONE)).toBe('Kessel en Marlow')
  })
  it.each([
    ['Harrowby The'],
    ['Kessel Of Ltd'],
    ['Northtown And'],
    ['Kessel For, Inc.'],
  ])('PLANTED: a full name that ends that way is not said at all ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBeNull()
  })

  it.each([
    ['Services Partners, Inc.'],
    ['Global Group Ltd'],
    ['Consulting Group'],
    ['The Consulting Company'],
    ['Holdings Ltd'],
    ['Advisory & Consulting'],
  ])('PLANTED: when every word is a generic business word there is no name to say ("%s")', stored => {
    expect(companyShortName(stored, NONE)).toBeNull()
  })

  it('PLANTED: the calling client\'s own generic words come off like service words', () => {
    // CHANGED, was "Kessel Haulage" under the client's set: one distinctive word used to
    // keep the whole name. For a client that writes to hauliers "Haulage" now comes off.
    expect(companyShortName('Kessel Haulage Ltd', CLIENT)).toBe('Kessel')
    // Control: for a client with no such word it is part of the name.
    expect(companyShortName('Kessel Haulage Ltd', NONE)).toBe('Kessel Haulage')
    // Treated as SERVICE words: the trade joined to one goes with it.
    expect(companyShortName('Kessel Freight & Haulage Ltd', CLIENT)).toBe('Kessel')
    // A client's generic word joined to a service word goes too, on the common list or
    // not and whatever stands in front: it is a service word itself.
    expect(companyShortName('Kessel Haulage & Consulting', CLIENT)).toBe('Kessel')
    expect(companyShortName('Kessel Marsh Haulage & Consulting', CLIENT)).toBe('Kessel Marsh')
    expect(companyShortName('Kessel Freight & Haulage Ltd', NONE)).toBe('Kessel Freight & Haulage')
    // Compared on letters, whatever case the caller's list is in.
    expect(companyShortName('Kessel Haulage Ltd', new Set(['Haulage']))).toBe('Kessel')
  })

  it('PLANTED: a market\'s own word that is on no list stays in the name', () => {
    expect(companyShortName('Vantor Marketing', NONE)).toBe('Vantor Marketing')
    expect(companyShortName('Kessel Roofing Ltd', NONE)).toBe('Kessel Roofing')
    // Control: the same word comes off for the client whose list calls it generic.
    expect(companyShortName('Vantor Marketing', new Set(['marketing']))).toBe('Vantor')
  })

  it('PLANTED: words come off the END only, never the middle or the front', () => {
    expect(companyShortName('Kessel Consulting Engineers', NONE)).toBe('Kessel Consulting Engineers')
    expect(companyShortName('Global Kessel Design', NONE)).toBe('Global Kessel Design')
    expect(companyShortName('Higher Ground Design', NONE)).toBe('Higher Ground Design')
  })

  it('PLANTED: a remainder is held to the same refusals as a full name, and the full name is the fallback', () => {
    // The remainder is a record typed in capitals, and code will not guess its case. The
    // full name has lower-case letters in it and is said as it stands.
    expect(companyShortName('NORTHTOWN Consulting', NONE)).toBe('NORTHTOWN Consulting')
    // The remainder ends on an abbreviation with no capital after it. In the full name a
    // capital follows it.
    expect(companyShortName('Kessel St. Group', NONE)).toBe('Kessel St. Group')
    // Neither can be said: the comma is inside both.
    expect(companyShortName('Kessel, Marsh & Associates', NONE)).toBeNull()
    expect(companyShortName('northtown Consulting', NONE)).toBeNull()
  })

  it.each([
    ['DOYLE CONSULTING'],
    ['KMR CONSULTING'],
    ['VANTO ADVISORS LTD'],
    ['KESSEL CONSULTING'],
  ])('PLANTED: a record typed all in capitals is not said by a short remainder either ("%s")', stored => {
    // THE REVIEW OF THE FIFTH READING: with "CONSULTING" off, "DOYLE" is five letters and
    // passed as an acronym. The evidence that the RECORD is in capitals is the full name.
    expect(companyShortName(stored, NONE)).toBeNull()
  })
  it('a mixed-case record keeps its acronym, and a short name in capitals is still an acronym (control)', () => {
    expect(companyShortName('KMR Consulting', NONE)).toBe('KMR')
    expect(companyShortName('NTW Group', NONE)).toBe('NTW')
    expect(companyShortName('Vantor GROUP', NONE)).toBe('Vantor')
    expect(companyShortName('DOYLE LTD', NONE)).toBe('DOYLE')
    expect(companyShortName('IBX', NONE)).toBe('IBX')
  })

  it('PLANTED: a full name over the word cap is said by its remainder when the remainder fits', () => {
    expect(companyShortName('Northtown Cold Room Engineering Group', NONE)).toBe('Northtown Cold Room Engineering')
    // Control: with a fifth word that is on no list, nothing fits.
    expect(companyShortName('Northtown Cold Room Engineering Works', NONE)).toBeNull()
  })

  it('PLANTED: a name that is ONE word, and that word a place or under three characters, is "your firm"', () => {
    expect(companyShortName('Denver Ltd', NONE)).toBeNull()
    expect(companyShortName('QX Ltd', NONE)).toBeNull()
  })
  it('CHANGED BY THE SIXTH READING: a one-word name that is a common word is said', () => {
    // Each was null: a common word no longer blocks. "The Harbour Company" stands in for a
    // shape the fifth reading used, whose word is a real firm's name.
    expect(companyShortName('Orchard GmbH', NONE)).toBe('Orchard')
    expect(companyShortName('The Harbour Company', NONE)).toBe('Harbour')
    // A surname that is also an ordinary word is a name again.
    expect(companyShortName('Smith and Co', NONE)).toBe('Smith')
  })
  it('a one-word name that is neither is used as it is (control)', () => {
    expect(companyShortName('Kessel GmbH', NONE)).toBe('Kessel')
    expect(companyShortName('IBX', NONE)).toBe('IBX')
    expect(companyShortName('The NTW Company', NONE)).toBe('NTW')
  })
})

describe('the two lists the shorter name reads', () => {
  it('PLANTED: the common words are the list the cut was measured on', () => {
    expect(COMMON_ENGLISH_WORDS.size).toBeGreaterThan(20_000)
    for (const word of ['harbour', 'pyramid', 'bridge', 'apex', 'beacon', 'orchard', 'lantern']) {
      expect(COMMON_ENGLISH_WORDS.has(word), word).toBe(true)
    }
    // Above the cut: real words, and rare enough to be a firm's name.
    for (const word of ['quasar', 'isotope']) {
      expect(COMMON_ENGLISH_WORDS.has(word), word).toBe(false)
    }
  })

  it('PLANTED: every common word is 3 to 14 lower-case letters, and the list is sorted with no repeats', () => {
    const words = [...COMMON_ENGLISH_WORDS]
    expect(words.filter(word => !/^[a-z]{3,14}$/.test(word))).toEqual([])
    expect(words).toEqual([...words].sort())
  })

  it('PLANTED: the places hold the countries, states and cities the rule is for', () => {
    expect(PLACE_NAMES.size).toBeGreaterThan(600)
    for (const place of ['boston', 'georgia', 'denver', 'london', 'new york', 'zurich', 'st louis', 'pacific']) {
      expect(PLACE_NAMES.has(place), place).toBe(true)
    }
  })

  it('PLANTED: every place is in the form a lookup uses: lower case, no accents, no full stops', () => {
    expect([...PLACE_NAMES].filter(place => !/^[a-z]+(?:[ -][a-z]+)*$/.test(place))).toEqual([])
    expect([...DEMONYMS_AND_CALENDAR_WORDS].filter(word => !/^[a-z]+(?:[ -][a-z]+)*$/.test(word))).toEqual([])
    expect([...PLACE_QUALIFIERS].filter(word => !/^[a-z]+$/.test(word))).toEqual([])
  })

  it('PLANTED: the regions, rivers and short forms the review found missing are places', () => {
    for (const place of ['north west', 'south east', 'twin cities', 'north shore', 'tri-state', 'thames', 'hudson', 'mersey', 'cotswold', 'lakeland', 'usa', 'nyc']) {
      expect(PLACE_NAMES.has(place), place).toBe(true)
    }
    // A compass word or "greater" in front of a listed place is a place by RULE, so the
    // list does not hold "north texas" or "greater manchester" and never has to.
    for (const word of ['north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'greater']) {
      expect(PLACE_QUALIFIERS.has(word), word).toBe(true)
    }
    expect(PLACE_NAMES.has('north texas')).toBe(false)
  })

  it('PLANTED: nationalities, weekdays and months are closed sets, held beside the places', () => {
    for (const word of ['american', 'british', 'european', 'canadian', 'scottish', 'irish', 'asian', 'texan', 'celtic', 'german', 'french']) {
      expect(DEMONYMS_AND_CALENDAR_WORDS.has(word), word).toBe(true)
    }
    for (const word of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
      expect(DEMONYMS_AND_CALENDAR_WORDS.has(word), word).toBe(true)
    }
    for (const word of ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']) {
      expect(DEMONYMS_AND_CALENDAR_WORDS.has(word), word).toBe(true)
    }
  })

  it('PLANTED: every listed country and territory has its demonym, or is named as a deliberate exception', () => {
    // THE SECOND ROUND OF THE REVIEW: the first set of demonyms was written as a list and
    // missed 62 of 197. A table keyed by the place list cannot miss one silently.
    const unpaired = COUNTRIES_AND_TERRITORIES.filter(
      country => !(country in DEMONYM_OF_COUNTRY) && !COUNTRIES_WITHOUT_A_DEMONYM.has(country),
    )
    expect(unpaired).toEqual([])
    // Each country is paired one way only, every key of the table is a listed country,
    // every exception is a listed country, and every demonym reaches the set the rule reads.
    expect(COUNTRIES_AND_TERRITORIES.filter(country => country in DEMONYM_OF_COUNTRY && COUNTRIES_WITHOUT_A_DEMONYM.has(country))).toEqual([])
    expect(Object.keys(DEMONYM_OF_COUNTRY).filter(country => !COUNTRIES_AND_TERRITORIES.includes(country))).toEqual([])
    expect([...COUNTRIES_WITHOUT_A_DEMONYM].filter(country => !COUNTRIES_AND_TERRITORIES.includes(country))).toEqual([])
    expect(Object.entries(DEMONYM_OF_COUNTRY).filter(([, demonyms]) => demonyms.length === 0)).toEqual([])
    expect(Object.values(DEMONYM_OF_COUNTRY).flat().filter(demonym => !DEMONYMS_AND_CALENDAR_WORDS.has(demonym))).toEqual([])
    // The ones the review found missing, by name.
    for (const word of ['dominican', 'costa rican', 'puerto rican', 'sri lankan', 'nepali', 'salvadoran', 'luxembourgish']) {
      expect(DEMONYMS_AND_CALENDAR_WORDS.has(word), word).toBe(true)
    }
    for (const word of ['alpine', 'iberian', 'balkan', 'caledonian', 'hibernian', 'midwestern', 'appalachian']) {
      expect(DEMONYMS_AND_CALENDAR_WORDS.has(word), word).toBe(true)
    }
  })

  it('the invented names these tests use for firms and people are on neither list (control)', () => {
    for (const name of ['northtown', 'kessel', 'marlow', 'vantor', 'coldharbour', 'brightwater', 'trennick', 'harrowby', 'doyle', 'vanto']) {
      expect(PLACE_NAMES.has(name), name).toBe(false)
      expect(COMMON_ENGLISH_WORDS.has(name), name).toBe(false)
      expect(DEMONYMS_AND_CALENDAR_WORDS.has(name), name).toBe(false)
    }
  })
})

describe('merge review, 2026-10-02: compound region adjectives and a small word of any language at the end', () => {
  const EMPTY: ReadonlySet<string> = new Set()
  it.each(['Indo-Pacific Advisors', 'Trans-Atlantic Partners', 'Afro-Caribbean Consulting', 'Sino-European Solutions'])(
    'PLANTED: "%s" keeps its full name: every part is a place, a demonym or a combining form', name => {
      expect(companyShortName(name, EMPTY)).toBe(name)
    })
  it('a compound with a part that is a name still shortens (control)', () => {
    expect(companyShortName('Euro-Kessel Consulting', EMPTY)).toBe('Euro-Kessel')
    expect(companyShortName('Marlow-Kessel Consulting', EMPTY)).toBe('Marlow-Kessel')
  })
  it.each(['Kessel i Partners', 'Kessel ja Partners', 'Kessel di Partners', 'Kessel ve Partners'])(
    'PLANTED: "%s" is never cut to end on its lower-case join', name => {
      expect(companyShortName(name, EMPTY)).toBe(name)
    })
  it('a name ending on a capitalised word is said as before (control)', () => {
    expect(companyShortName('Bank of Northtown', EMPTY)).toBe('Bank of Northtown')
    expect(companyShortName('Kessel Consulting', EMPTY)).toBe('Kessel')
  })
})
