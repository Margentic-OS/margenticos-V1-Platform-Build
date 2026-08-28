// The gate originally matched numerals and currency only, so two spelled-out headcounts
// shipped: "a two-person firm" in one opening and "a firm that size" in another. Both are
// the prospect's headcount restated, and both were reported as clean.

import { describe, it, expect } from 'vitest'
import { findFirmographicFigures, FIRMOGRAPHIC_RULE_TEXT } from '../firmographic'

describe('numerals and currency, the original coverage', () => {
  it.each([
    ['a currency amount', 'Launching Fitch Media while running a $5M consulting firm.'],
    ['a headcount', 'You have 12 employees now.'],
    ['a team size', 'A team of 12 is a lot to keep busy.'],
    ['a figure like 500K or 5M', 'Most firms at the 500K mark see this.'],
  ])('still catches %s', (_label, text) => {
    expect(findFirmographicFigures(text).length).toBeGreaterThan(0)
  })
})

describe('spelled-out forms, the hole that shipped', () => {
  it('catches the real "two-person firm" from Shevonne\'s opening', () => {
    const text = 'Three visibility plays in eight months from a two-person firm says the brand-building is deliberate.'
    expect(findFirmographicFigures(text)).toContain('a spelled-out team size')
  })

  it('catches the real "a firm that size" from Robert\'s opening', () => {
    const text = 'Eleven years in, a firm that size fills its diary through relationships.'
    expect(findFirmographicFigures(text)).toContain('an oblique reference to their size')
  })

  it.each([
    'A team of five is a lot to keep busy.',
    'A company of that size rarely needs to chase work.',
    'Running a three-person shop means everything competes.',
  ])('catches %s', text => {
    expect(findFirmographicFigures(text).length).toBeGreaterThan(0)
  })
})

describe('what must never fire: dates, tenures and counts of things they did', () => {
  it.each([
    'Fourteen months running CRC alongside the firm says a lot.',
    'Your last five posts are carrying RLCore.',
    'Two years running Full Bloom alongside a full-time Stanford role.',
    'Three and a half years running SCG alongside a full consulting role.',
    'Winning Best Startup at CAEV Expo in your first year.',
    'Every post in the last two months is Qundo or PALADYN.',
    'Six years running Henosys and Fitch in parallel.',
    'Seven years of delivery have not left much room.',
    'Nine months into HydrospherIQ.',
    'The Nashville recruiting post says delivery is live.',
  ])('leaves alone: %s', text => {
    expect(findFirmographicFigures(text)).toEqual([])
  })

  it('all eleven surviving openings from the run pass', () => {
    const survivors = [
      'Two years running Full Bloom alongside a full-time Stanford role says the consulting work is real enough to hold through serious competing demands.',
      'Six years running Henosys and Fitch in parallel says you can carry a serious operational load.',
      'Three and a half years running SCG alongside a full consulting role at GP Strategies says you can carry a serious load.',
      'Going on air to work through the ideal-client question says the positioning work is happening.',
      'Your last five posts are carrying RLCore story, media hits, open roles, the momentum is visible.',
      'Running DRI Consulting and DRIC Jamaica simultaneously means the delivery load across two geographies rarely leaves a gap for pipeline.',
      'Your post connecting the Counselors Academy conference to opening day says you know where PR agency principals gather.',
      'The hiring post for a Manager of Delivery and Operations says the client load is real and growing.',
      'The Nashville recruiting post says delivery is live and the diary is full.',
      'Every post in the last two months is Qundo or PALADYN.',
    ]
    for (const s of survivors) expect(findFirmographicFigures(s)).toEqual([])
  })
})

describe('known over-reach, recorded rather than hidden', () => {
  it('fires on the idiom "a one-person job", which is not about a firm', () => {
    // Accepted: in this copy "one-person" almost always describes the prospect's firm,
    // and the cost of a false positive is one rewrite attempt, not a bad send.
    expect(findFirmographicFigures('A one-person job is still a job.').length).toBeGreaterThan(0)
  })
})


// ─── A headcount of one ──────────────────────────────────────────────────────
//
// "running it solo since" shipped in a real email. The list already caught "a two-person
// firm" and "a team of five" and had no spelling for one, which is the headcount most
// likely to be observed and most likely to go stale.

describe('a headcount of one is still a headcount', () => {
  const banned = [
    ['have been running it solo since',        'solo'],
    ['a solopreneur three years in',           'solopreneur'],
    ['built single-handed since 2022',         'single-handed'],
    ['built single-handedly since 2022',       'single-handedly'],
    ['still a one-man band',                   'one-man'],
    ['a one man operation',                    'one man'],
    ['the sole practitioner on every project', 'sole practitioner'],
    ['the sole operator there',                'sole operator'],
    ['right now it is just you',               'just you'],
    ['doing all of it on your own',            'on your own'],
    ['running the whole thing by yourself',    'by yourself'],
    ['you are the only one selling',           'the only one'],
    ["right now it's just you",                "it's just you"],
    ['with no employees to hand it to',        'no employees'],
  ] as const

  for (const [text, label] of banned) {
    it(`flags "${label}"`, () => {
      expect(findFirmographicFigures(text).length).toBeGreaterThan(0)
    })
  }

  it('reports it as a headcount, so the writer feedback names the real problem', () => {
    expect(findFirmographicFigures('running it solo since')[0]).toContain('headcount of one')
  })

  it('still passes ordinary copy that merely sounds similar', () => {
    // The ban is on stating their headcount, not on every nearby word.
    expect(findFirmographicFigures('You spoke solely about regulation.')).toEqual([])
    expect(findFirmographicFigures('the only post in the last two months')).toEqual([])
    expect(findFirmographicFigures('your own words, from the launch post')).toEqual([])
    expect(findFirmographicFigures('thirteen months of running both')).toEqual([])
    expect(findFirmographicFigures('your last three posts')).toEqual([])
    // A pattern statement about a population, not a claim about their headcount.
    expect(findFirmographicFigures("this isn't just you, it is most founders")).toEqual([])
  })

  it('the prompt text tells the writer the same thing the patterns enforce', () => {
    expect(FIRMOGRAPHIC_RULE_TEXT).toContain('A headcount of ONE counts')
    expect(FIRMOGRAPHIC_RULE_TEXT).toContain('running it solo')
    expect(FIRMOGRAPHIC_RULE_TEXT).toContain('wrong the day they make a first hire')
  })
})
