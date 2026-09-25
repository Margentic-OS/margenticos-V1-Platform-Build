// The two new gates, tested in BOTH directions.
//
// A gate that rejects everything is an outage, not a control. The commit gate's self-test
// makes the same point: its ALLOW cases matter as much as its BLOCK cases. So every
// describe below has a rejection case AND a case that must pass, and the passing cases are
// written to be the awkward ones: a legitimate generalisation mid-sentence, a date that
// describes the prospect's own activity, a definite article opening.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { splitIntoSentences } from '../sentence-count'
import {
  checkFollowupGates,
  checkFollowupPairGates,
  findEcho,
  normaliseForEcho,
  ECHO_NEEDLE_WORDS,
  FOLLOWUP_MAX_SENTENCE_WORDS,
  companyShortForm,
  companyNameForms,
  MAX_SENTENCES_PER_PARAGRAPH,
  reformatParagraphs,
} from '../followup-gates'

/** A reference block, already stripped of its opening paragraph. */
const REFERENCE = [
  'The gap is not the work itself. It is the week that disappears before the next job starts.',
  'Does that match what you see?',
].join('\n\n')

/** Everything a passing follow-up needs, so each test varies one thing. */
const base = {
  position: 2 as const,
  reference: REFERENCE,
  companyName: 'Northgate Fabrication',
  // Null by default so the existing fixtures are unaffected by the third-person gate; the
  // tests that are ABOUT that gate pass a name explicitly.
  prospectFirstName: null as string | null,
  // No dated findings by default, so existing fixtures are unaffected: a year count with
  // nothing behind it is rejected, and the tests ABOUT that pass dates explicitly.
  datedCandidates: [] as ReadonlyArray<{ date?: string | null }>,
  now: new Date('2026-09-24T00:00:00Z'),
  bodyWordCount: 60,
  minWords: 30,
  maxWords: 85,
}

/**
 * PARAGRAPHED BEFORE SCORING, unless the fixture already has blank lines.
 *
 * Every fixture in this file was written as one line of prose, because until 2026-09-24 no
 * gate cared where the paragraphs were. MAX_SENTENCES_PER_PARAGRAPH does, and without this
 * every existing test would fail on a rule it is not about, which is how a suite ends up
 * asserting the wrong thing everywhere at once.
 *
 * A fixture that already carries blank lines is left exactly as written, so a test ABOUT
 * paragraphs still controls its own input.
 */
function asParagraphs(prose: string): string {
  if (/\n\s*\n/.test(prose)) return prose
  const sentences = splitIntoSentences(prose)
  const out: string[] = []
  for (let i = 0; i < sentences.length; i += 2) out.push(sentences.slice(i, i + 2).join(' '))
  return out.join('\n\n')
}

const pass = (prose: string, over: Partial<typeof base> = {}) =>
  checkFollowupGates({ prose: asParagraphs(prose), ...base, ...over })

// ═══════════════════════════════════════════════════════════════════════════════
// THE RECIPIENT IS NEVER NAMED IN THE THIRD PERSON.
//
// Measured on the runs of 2026-09-24: two follow-ups wrote about the reader by name. Email
// 1 has forbidden this since it had a writer; follow-ups never inherited it, because the
// name was not in scope at the call site at all.
//
// Fixtures are industry-neutral and the names are ordinary given names, not any prospect's.
// ═══════════════════════════════════════════════════════════════════════════════
// CAPACITY CLAIMS AND AUDIENCE PROMISES ON EMAILS 2 AND 3.
//
// Neither check reached follow-ups before 2026-09-24. BLOCKING IS NARROWER THAN DETECTING,
// and that split is the design: wiring the whole detector to block hit four live sentences,
// at least two of which were the SENDER describing its own work, and one rejection here
// discards BOTH follow-ups.
describe('capacity and audience on follow-ups', () => {
  const run = (prose: string, over: Partial<typeof base> = {}) =>
    checkFollowupGates({ prose: asParagraphs(prose), ...base, ...over })
  const capacity = (fs: string[]) => fs.filter(f => f.includes('their week') || f.includes('who does') || f.includes('capacity') || f.includes('time'))

  it('BLOCKS a capacity claim that names the reader', () => {
    const f = run('You took the second unit on in March.\n\nYour week is already full before the quote goes out.\n\nWorth a look?')
    expect(f.some(x => x.includes('email 2'))).toBe(true)
  })

  it('NEVER blocks the sender describing its own work', () => {
    // THE CONTROL THAT MATTERS MOST. These are offer statements, and this module's header
    // has listed them as permitted since it was written. Measured: blocking the unchanged
    // detector rejected two of them on live copy.
    for (const line of [
      'We map the right targets, run the outreach, and book the meetings into your calendar.',
      'We keep outbound running so the next meetings are booked before the current work ends.',
    ]) {
      const f = run(`You took the second unit on in March.\n\n${line}\n\nWorth a look?`)
      expect(f.filter(x => x.includes('reader') || x.includes('week') || x.includes('calendar')), line).toEqual([])
    }
  })

  it('NEVER blocks a promise that the reader will NOT do the work', () => {
    // THE READER NOT DOING IT IS AN OFFER, not a claim about them. Both of these are in the
    // client's own approved template, written deliberately. Measured 2026-09-24: without the
    // rule, two of eighty-six approved sentences were rejected and both were offers.
    for (const line of [
      'No prospecting on your end.',
      'You don\u2019t touch the prospecting.',
      'Without you touching the outreach, the meetings still land.',
    ]) {
      const f = run(`You took the second unit on in March.\n\n${line} It changes the month.\n\nWorth a look?`)
      expect(f.filter(x => x.includes('who does') || x.includes('prospecting')), line).toEqual([])
    }
  })

  it('and STILL blocks the same activity asserted rather than removed', () => {
    // The grammar is what tells them apart. Without this the exemption would swallow the
    // claim it is carved out of: a negated activity is the sender removing it, the same
    // activity asserted is a guess about how this reader's business runs.
    const f = run('You took the second unit on in March.\n\nYou do all the prospecting yourself.\n\nWorth a look?')
    expect(f.length).toBeGreaterThan(0)
  })

  it('COUNTS rather than blocks the impersonal form, which may be a population statement', () => {
    // A bridge is REQUIRED to say what is typically true of a population, so the impersonal
    // construction cannot be a hard failure without contradicting the house rule one gate up.
    const f = run('You took the second unit on in March.\n\nThat makes sense when delivery is consuming the week.\n\nWorth a look?')
    expect(f).toEqual([])
  })

  it('BLOCKS a promise to reach the audience they already have', () => {
    const f = run('You took the second unit on in March.\n\nWe can reach your subscribers with the same message.\n\nWorth a look?')
    expect(f.some(x => x.includes('audience they already have'))).toBe(true)
  })
})

describe('the third-person gate', () => {
  const withName = (prose: string, name: string, over: Partial<typeof base> = {}) =>
    checkFollowupGates({ prose: asParagraphs(prose), ...base, prospectFirstName: name, ...over })
  const thirdPerson = (fs: string[]) => fs.filter(f => f.includes('third person'))

  it('rejects the reader named mid-sentence', () => {
    const f = thirdPerson(withName(
      'You took on the second unit in March. That is the month Marisa stops doing the prospecting herself.\n\nWorth a look?',
      'Marisa',
    ))
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('Marisa')
    expect(f[0]).toContain('Write to them as "you"')
  })

  it('accepts the same copy written in the second person', () => {
    // POSITIVE CONTROL. Without it the test above would pass on a gate that rejects
    // everything, and one rejection here discards BOTH follow-ups.
    expect(thirdPerson(withName(
      'You took on the second unit in March. That is the month you stop doing the prospecting yourself.\n\nWorth a look?',
      'Marisa',
    ))).toEqual([])
  })

  it('does NOT reject an ordinary word that happens to be the reader\'s name', () => {
    // A first name is often a common English word. A bare word-boundary match would reject
    // correct copy, and the cost of a false positive here is both follow-ups.
    for (const [name, prose] of [
      ['Will', 'You took on the second unit in March. Nobody will own the quiet month.\n\nWorth a look?'],
      ['Bill', 'You took on the second unit in March. The bill for that arrives later.\n\nWorth a look?'],
      ['Mark', 'You took on the second unit in March. That is the mark of a firm growing fast.\n\nWorth a look?'],
      ['Rose', 'You took on the second unit in March. Output rose through the summer.\n\nWorth a look?'],
    ] as const) {
      expect(thirdPerson(withName(prose, name)), `${name}: ${prose}`).toEqual([])
    }
  })

  it('STILL rejects those names when they are used as names', () => {
    // The other half of the same claim: the exemption is about CASE, not about the word.
    expect(thirdPerson(withName(
      'You took on the second unit in March. The quiet month is what Will feels first.\n\nWorth a look?',
      'Will',
    ))).toHaveLength(1)
  })

  it('does not fire on a sentence-initial capital, where the capital says nothing', () => {
    expect(thirdPerson(withName(
      'You took on the second unit in March. Will that month stay quiet?\n\nWorth a look?',
      'Will',
    ))).toEqual([])
  })

  it('leaves the callback gate an alternative when the firm is named after the reader', () => {
    // THE DORMANT CONFLICT. The callback gate accepts copy that names the COMPANY. If a
    // company form contains the first name, both gates would fire on the same sentence and
    // there would be no legal move. The company forms are cut out before this gate reads.
    const prose = 'Hartley Fabrication took on a second unit in March.\n\nThat changes what a quiet month costs.\n\nWorth a look?'
    const f = withName(prose, 'Hartley', { companyName: 'Hartley Fabrication' })
    expect(thirdPerson(f)).toEqual([])
    expect(f.filter(x => x.includes('opens without addressing the reader'))).toEqual([])
  })

  it('does nothing when no name is supplied, and nothing for a one-letter name', () => {
    expect(thirdPerson(withName('Marisa took the unit on in March.\n\nIt changes the month.\n\nWorth a look?', ''))).toEqual([])
    expect(thirdPerson(withName('A took the unit on in March.\n\nIt changes the month.\n\nWorth a look?', 'A'))).toEqual([])
  })
})

describe('the callback gate: the opening sentence is about this reader', () => {
  it('accepts an opening that says "you"', () => {
    expect(pass('You took on the second unit in March.\n\nIt changes what a quiet month costs.\n\nShall I show you the first step?')).toEqual([])
  })

  it('accepts an opening that names the company instead of saying "you"', () => {
    expect(pass("Northgate Fabrication's second unit went in during March.\n\nThat changes what a quiet month costs.\n\nWorth a look?")).toEqual([])
  })

  it('rejects a population opener', () => {
    const f = pass('Most owners find the same thing happens every quarter. You will know the feeling. Worth a look?')
    expect(f.some(x => x.includes('opens on a population'))).toBe(true)
  })

  it('rejects every shape the reference material actually uses', () => {
    // These are the SHAPES measured across the live template follow-ups, rewritten with
    // invented nouns. Each must be rejected, or the gate does not cover the thing it was
    // built for.
    const shapes = [
      'The cost that does not show up anywhere obvious: the week before each job.',
      'Most owners who fix this do not do it by working later.',
      'The pattern I see most often is a diary that fills and then empties.',
      'When outreach has failed before, it is almost always the same reason.',
      'There is a common trap here that catches people at this size.',
      'Owners who get past this point rarely do it by pushing harder.',
    ]
    for (const shape of shapes) {
      const f = pass(`${shape} You will recognise it. Worth a look?`)
      expect(f.some(x => x.includes('opens on a population')), shape).toBe(true)
    }
  })

  it('rejects an opening that addresses nobody', () => {
    const f = pass('The second unit went in during March. It changes things. Worth a look?')
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
  })

  it('DOES NOT reject a generalisation that appears mid-sentence', () => {
    // Generalising is how a bridge works. It is the OPENING that must be about them.
    expect(pass('You added the second unit in March, which is where most of this starts. The bench is bigger now. Worth a look?')).toEqual([])
  })
})

describe('the banned-phrase gate', () => {
  it.each([
    'just following up on this',
    'just circling back',
    'just checking in',
    'I never heard back',
    "I haven't heard back from you",
    'hope this finds you well',
    "hope you're well",
  ])('rejects %j', phrase => {
    const f = pass(`You mentioned the second unit. ${phrase}. Worth a look?`)
    expect(f.some(x => x.includes('banned follow-up phrase'))).toBe(true)
  })

  it('DOES NOT reject ordinary use of the same words', () => {
    // "follow" and "hear" are common verbs. The gate targets the MOVE, not the words.
    expect(pass('You said the second unit would follow the first. I hear that a lot. Worth a look?')).toEqual([])
  })
})

describe('the time-reference gate', () => {
  it.each([
    'last week',
    'the other day',
    'a few days ago',
    'since I emailed',
    'my last email',
  ])('rejects %j, because the gap is not known when this is written', phrase => {
    const f = pass(`You took on the second unit. I wrote ${phrase}. Worth a look?`)
    expect(f.some(x => x.includes('refers to when the previous email went out'))).toBe(true)
  })

  it('DOES NOT reject a date describing the prospect\'s own activity', () => {
    // This is the entire basis of the observation Email 1 is built on, and it has to keep
    // working here. A gate that ate it would reject the best follow-ups.
    expect(pass('You took on the second unit in March. Two quarters on, the bench is bigger. Worth a look?')).toEqual([])
    expect(pass('Your third depot opened in 2024. The same gap now costs more. Worth a look?')).toEqual([])
  })
})

describe('the echo gate against the stripped reference', () => {
  it('rejects a lifted clause', () => {
    const lifted = 'the week that disappears before the next job starts'
    const f = pass(`You know ${lifted}. It costs more now. Worth a look?`)
    expect(f.some(x => x.includes('reproduces'))).toBe(true)
  })

  it('finds an echo anywhere, not only at the start', () => {
    expect(findEcho('padding words here the gap is not the work itself and more', REFERENCE))
      .not.toBeNull()
  })

  it(`needs ${ECHO_NEEDLE_WORDS} consecutive words, so a shared phrase is not an echo`, () => {
    expect(findEcho('the gap is not big', REFERENCE)).toBeNull()
  })

  it('normalises punctuation and case, so reformatting does not evade it', () => {
    expect(normaliseForEcho('The GAP, is not -- the work itself!')).toBe('the gap is not the work itself')
    expect(findEcho('The GAP, IS NOT the WORK itself!', REFERENCE)).not.toBeNull()
  })

  it('DOES NOT fire on an empty reference', () => {
    expect(findEcho('any text at all here we go', '')).toBeNull()
  })
})

describe('house rules', () => {
  it('rejects a second question mark', () => {
    const f = pass('You took on the second unit. Does it feel bigger? Worth a look?')
    expect(f.some(x => x.includes('asks 2 questions'))).toBe(true)
  })

  it(`rejects a sentence over ${FOLLOWUP_MAX_SENTENCE_WORDS} words`, () => {
    const long = `You took on the second unit in March and ever since then the bench has been bigger than the work coming in which makes a quiet month cost a great deal more than it did.`
    const f = pass(`${long} Worth a look?`)
    expect(f.some(x => x.includes('against a cap of'))).toBe(true)
  })

  it('rejects a body outside its word band, in both directions', () => {
    const ok = 'You took on the second unit in March. The bench is bigger now. Worth a look?'
    expect(pass(ok, { bodyWordCount: 20 }).some(x => x.includes('outside its band'))).toBe(true)
    expect(pass(ok, { bodyWordCount: 120 }).some(x => x.includes('outside its band'))).toBe(true)
    expect(pass(ok, { bodyWordCount: 60 })).toEqual([])
  })

  it('reports the writer returning nothing, rather than passing vacuously', () => {
    // An empty string must not sail through every gate and read as clean.
    expect(pass('')).toEqual(['email 2: the writer returned nothing'])
  })
})

describe('the pair gates', () => {
  const e2 = 'You took on the second unit in March. The bench is bigger now. Worth a look?'
  const e3 = 'Your second unit changes what a quiet month costs. Worth fifteen minutes?'

  // CHANGED 2026-09-25. This used to assert a REJECTION. On the 104-prospect run it was the
  // second largest cause of a follow-up pair falling back to template, 28 of 59, most of
  // them near-misses at two words. It is the same shape as the Email 2 coupling that was
  // deleted for the same reason: both emails are written in ONE response, so Email 3's
  // budget depends on a figure for Email 2 that does not exist while the copy is written.
  // The model cannot aim at it. The taper is carried by the bands themselves (85/70/50).
  it('COUNTS email 3 being longer than email 2, and does not reject it', () => {
    const f = checkFollowupPairGates(e2, e3, 50, 70)
    expect(f.filter(x => x.includes('it must not be longer'))).toEqual([])
    // And nothing else fires on this pair either, so the pair really does ship.
    expect(f).toEqual([])
  })

  it('accepts equal lengths, and a shorter email 3, as it always did', () => {
    // POSITIVE CONTROL ON THE OTHER SIDE: the change must not have turned the whole pair
    // gate off. A shared sentence is still rejected, asserted in the next test.
    expect(checkFollowupPairGates(e2, e3, 50, 50)).toEqual([])
    expect(checkFollowupPairGates(e2, e3, 70, 50)).toEqual([])
  })

  it('THE PAIR GATE STILL GATES: a sentence repeated across the two is rejected', () => {
    // Without this, making the length rule report-only would be indistinguishable from
    // deleting checkFollowupPairGates, and the repeat rule is the one that matters.
    const shared = 'You took the second unit on in March and it changes what a quiet month costs.'
    const f = checkFollowupPairGates(`${shared}\n\nWorth a look?`, `${shared}\n\nWorth a call?`, 50, 40)
    expect(f.length).toBeGreaterThan(0)
  })

  it('rejects a sentence repeated verbatim across the two', () => {
    const shared = 'The bench is bigger now than the work coming in.'
    const f = checkFollowupPairGates(`You took the unit on. ${shared}`, `Your unit changed things. ${shared}`, 50, 40)
    expect(f.some(x => x.includes('repeats a sentence from email 2'))).toBe(true)
  })

  it('DOES NOT reject two different sentences about the same thing', () => {
    // One finding developed across the thread is the GOAL, not the fault.
    expect(checkFollowupPairGates(
      'You took the second unit on in March. The bench is bigger now.',
      'Your second unit changes what a quiet month costs. Worth fifteen minutes?',
      50, 40,
    )).toEqual([])
  })

  it('ignores very short shared fragments', () => {
    expect(checkFollowupPairGates('You did. Worth a look?', 'You did. Worth a look?', 50, 40))
      .toEqual([])
  })
})

describe('the company short form: the measured false positive, both directions', () => {
  // SIX of the TWELVE hits on the callback gate in the 2026-09-21 run were emails that DID
  // name the company and were rejected anyway, because the gate matched the registered
  // name in full while the copy used the short form. Each pair below is a real one from
  // that run, and each must now pass.
  it.each([
    ['Abacus Business Consulting, Inc.', 'Abacus'],
    ['Cavalry Consulting LLC', 'Cavalry'],
    ['Interra Consulting', "Interra's"],
    ['BCR Business Consulting Resources, Inc.', 'BCR'],
    ['Matrix Restaurant Consulting', 'Matrix'],
    ['CANDOR Management Consulting', 'CANDOR'],
  ])('stored %j is addressed by %j', (stored, written) => {
    const f = checkFollowupGates({
      ...base,
      companyName: stored,
      prose: asParagraphs(`${written} has been running a while now. The bench is bigger. Worth a look?`),
    })
    expect(f.filter(x => x.includes('opens without addressing the reader'))).toEqual([])
  })

  it('extracts the distinguishing token, dropping legal and descriptive suffixes', () => {
    expect(companyShortForm('Abacus Business Consulting, Inc.')).toBe('Abacus')
    expect(companyShortForm('Cavalry Consulting LLC')).toBe('Cavalry')
    expect(companyShortForm('BCR Business Consulting Resources, Inc.')).toBe('BCR')
    expect(companyShortForm(null)).toBeNull()
    // A name that is ENTIRELY suffixes has no distinguishing token, and the gate then
    // requires second person, which is the stricter branch and the safe failure direction.
    expect(companyShortForm('Consulting Group Ltd')).toBeNull()
  })

  it('THE OTHER DIRECTION: a non-leading token does NOT count as naming them', () => {
    // "Matrix Restaurant Consulting" must not be credited with a callback because the
    // email happened to say "restaurant". Anything looser starts accepting ordinary nouns
    // as company references, which would make the gate pass on copy it should reject.
    const f = checkFollowupGates({
      ...base,
      companyName: 'Matrix Restaurant Consulting',
      prose: asParagraphs('The restaurant sector has been slow. Things are hard. Worth a look?'),
    })
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
  })
})

describe('the offer-line echo gate', () => {
  const OFFER = 'We find the work and book it in, so the bench stays full without you chasing it.'

  it('rejects the offer line coming back word for word', () => {
    const f = checkFollowupGates({
      ...base,
      offerLine: OFFER,
      prose: asParagraphs('You took the unit on. We find the work and book it in, so the bench stays full. Worth a look?'),
    })
    expect(f.some(x => x.includes('reproduces') && x.includes('offer line'))).toBe(true)
  })

  it('DOES NOT reject describing the same mechanism in different words', () => {
    // Email 2's job IS to explain the mechanism, so substantive overlap with the offer
    // line is correct. Only a verbatim repeat is the fault.
    const f = checkFollowupGates({
      ...base,
      offerLine: OFFER,
      prose: asParagraphs('You took the unit on. We build the list, run the sending, and hand you the replies. Worth a look?'),
    })
    expect(f).toEqual([])
  })

  it('is inert when no offer line is supplied', () => {
    expect(checkFollowupGates({ ...base, prose: asParagraphs('You took the unit on. It is bigger now. Worth a look?') }))
      .toEqual([])
  })
})

describe('the firmographic gate applies here too', () => {
  it('rejects a figure from the prospect record', () => {
    const f = checkFollowupGates({
      ...base,
      prose: asParagraphs('You crossed £5M last year. The bench is bigger now. Worth a look?'),
    })
    expect(f.some(x => x.includes("from the prospect's record"))).toBe(true)
  })

  it('DOES NOT reject an ordinary number', () => {
    expect(checkFollowupGates({
      ...base,
      prose: asParagraphs('You took the second unit on 13 months ago. The bench is bigger. Worth a look?'),
    })).toEqual([])
  })
})

describe('the acronym short form: the SECOND measured false positive', () => {
  // Found on the rerun, after the leading-token rule had fixed six of eight. These two
  // companies keep their real short form as an acronym at the END of the registered name,
  // so the leading token ("Virtual", "Global") could never reach it.
  it.each([
    ['Virtual Miss Friday (VMF Ltd)', "VMF's"],
    ['Global Business Consulting Services (GBCS)', "GBCS's"],
  ])('stored %j is addressed by %j', (stored, written) => {
    const f = checkFollowupGates({
      ...base,
      companyName: stored,
      prose: asParagraphs(`${written} retention is strong, and that is what makes a pause expensive. It costs more now. Worth a look?`),
    })
    expect(f.filter(x => x.includes('opens without addressing the reader'))).toEqual([])
  })

  it('collects the acronym and the leading token, and nothing else', () => {
    expect(companyNameForms('Virtual Miss Friday (VMF Ltd)')).toEqual(['VMF', 'Virtual'])
    // Every word after the acronym is generic, so the acronym is the ONLY form offered.
    // That is the safe answer: "Business" as a short form would let "Business is slow"
    // count as naming the company.
    expect(companyNameForms('Global Business Consulting Services (GBCS)')).toEqual(['GBCS'])
    expect(companyNameForms('Abacus Business Consulting, Inc.')).toEqual(['Abacus'])
    expect(companyNameForms(null)).toEqual([])
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // WHEN EVERY TOKEN IS SKIPPED, FALL BACK TO THE WHOLE NAME.
  //
  // Measured 2026-09-24: companyNameForms('9 Consulting') returned []. The first token is
  // one character and skipped for being under two; the second is a suffix and skipped as
  // one; the loop ends with nothing. The callback gate asks whether the copy says "you" or
  // names the company, so with NO form to match, no email that prospect could ever receive
  // can satisfy it. Their Email 3 opened by naming the company in full and was rejected
  // anyway, and both follow-ups were lost.
  //
  // THIS REVERSED A PREVIOUS ASSERTION, deliberately. The line removed above said a name
  // made entirely of generic words "offers nothing, and the gate then requires second
  // person, which is the stricter branch and the safe direction to fail in". Stricter is
  // not safe when it is unsatisfiable: the copy was correct and the gate could not see it.
  // The collision risk the old reasoning guarded against is a SINGLE generic word standing
  // in for the company, not the full phrase, which is distinctive even when its words are
  // not.
  describe('the whole-name fallback', () => {
    it('gives a usable form to a name whose tokens are all skipped', () => {
      expect(companyNameForms('9 Consulting')).toEqual(['9 Consulting'])
      // A second shape of the same fault: a single-character distinguishing token.
      expect(companyNameForms('Q Advisory')).toEqual(['Q Advisory'])
    })

    it('strips LEGAL suffixes only, so the descriptive word stays', () => {
      // 'Consulting' is in COMPANY_SUFFIXES to stop it becoming a short form on its own.
      // Stripping it HERE would leave the bare '8', which is worse than the rule it rescues.
      expect(companyNameForms('9 Consulting Ltd')).toEqual(['9 Consulting'])
    })

    it('does NOT fire when every token is generic, which is a different fault', () => {
      // Both cases produce no form from the rules above and they need opposite answers.
      // "8" is distinctive and was skipped for LENGTH; "Consulting Group" has nothing
      // distinctive at all, and crediting it would let any sentence containing the phrase
      // "consulting group" count as naming the company. Such a prospect is still reachable
      // through the second-person branch, which is ordinary rather than impossible.
      expect(companyNameForms('Business Management Services Ltd')).toEqual([])
      expect(companyNameForms('Consulting Group Ltd')).toEqual([])
    })

    it('ORDINARY NAMES ARE UNCHANGED, which is what makes this a fallback', () => {
      // The control that matters: the fallback must fire only when the rules above found
      // nothing, or it would start offering whole names everywhere and widen the gate.
      expect(companyNameForms('Matrix Restaurant Consulting')).toEqual(['Matrix'])
      expect(companyNameForms('Abacus Business Consulting, Inc.')).toEqual(['Abacus'])
      expect(companyNameForms('Virtual Miss Friday (VMF Ltd)')).toEqual(['VMF', 'Virtual'])
      expect(companyNameForms('Cavalry Consulting LLC')).toEqual(['Cavalry'])
      expect(companyNameForms(null)).toEqual([])
      expect(companyNameForms('')).toEqual([])
    })

    it('the gate now accepts copy that names such a company, which it could not before', () => {
      // END TO END, through the real gate rather than the helper, because the helper
      // returning a form proves nothing about whether the callback is credited.
      const f = checkFollowupGates({
        ...base,
        companyName: '9 Consulting',
        prose: asParagraphs('9 Consulting has thirteen years of past performance behind it. That record is what buyers want. Worth a look?'),
      })
      expect(f.filter(x => x.includes('opens without addressing the reader'))).toEqual([])
    })

    it('and still rejects copy that names neither the reader nor the company', () => {
      // POSITIVE CONTROL THE OTHER WAY. The fallback must not turn the gate off.
      const f = checkFollowupGates({
        ...base,
        companyName: '9 Consulting',
        prose: asParagraphs('Those twelve articles represent a real point of view that cold buyers have not met. It costs more now. Worth a look?'),
      })
      expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
    })
  })

  it('THE OTHER DIRECTION HOLDS: an ordinary non-leading word still does not count', () => {
    // An acronym is distinctive by construction and safe to accept from anywhere. An
    // ordinary word is not, or the gate starts passing copy it should reject.
    expect(companyNameForms('Matrix Restaurant Consulting')).toEqual(['Matrix'])
    const f = checkFollowupGates({
      ...base,
      companyName: 'Matrix Restaurant Consulting',
      prose: asParagraphs('The restaurant sector has been slow. Things are hard. Worth a look?'),
    })
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
  })
})

// ═══ THE FOUR RULES ADDED 2026-09-24, each measured before it was written ═══

// REPLACED 2026-09-24. This was a GATE and is now a deterministic REFORMAT. Paragraph length
// is the one fault here with a correct answer computable without asking the model again: the
// words are right and only the line breaks are wrong. A gate spent a retry, and an exhausted
// retry costs the prospect a personalised email, to reach a result this produces for free.
describe('overlong paragraphs are reformatted, not rejected', () => {
  it('splits three sentences into two paragraphs', () => {
    expect(reformatParagraphs('You took the unit on. It is bigger now. Worth a look?'))
      .toBe('You took the unit on. It is bigger now.\n\nWorth a look?')
  })

  it('THE WORDS ARE IDENTICAL, which is the whole claim', () => {
    // A reformat that changed a word would be a rewrite nobody reviewed.
    const before = 'One thing happened. A second thing happened. A third thing happened. A fourth did too.'
    const words = (t: string) => t.replace(/\s+/g, ' ').trim()
    expect(words(reformatParagraphs(before))).toBe(words(before))
  })

  it('leaves a paragraph already within the limit exactly as it was', () => {
    const ok = 'You took the unit on. It is bigger now.'
    expect(reformatParagraphs(ok)).toBe(ok)
  })

  it('splits each overlong paragraph independently, keeping the existing breaks', () => {
    const before = 'One. Two.\n\nThree. Four. Five.'
    expect(reformatParagraphs(before)).toBe('One. Two.\n\nThree. Four.\n\nFive.')
  })

  it('NOTHING is rejected for paragraph length any more', () => {
    // The positive control for the removal. A three-sentence paragraph reaching the gates
    // unreformatted must now pass, or the gate is still there under another name.
    const f = checkFollowupGates({ ...base, prose: 'You took the unit on. It is bigger now. Worth a look?' })
    expect(f.some(x => x.includes('no paragraph may hold more than'))).toBe(false)
  })

  it('the cap is still one exported constant, now used by the reformatter', () => {
    expect(MAX_SENTENCES_PER_PARAGRAPH).toBe(2)
  })
})

describe("email 3's callback may land anywhere in the first paragraph", () => {
  // MEASURED. Two of three prospects with a clean personalised Email 1 shipped template
  // follow-ups, both on EMAIL 3, both because the paragraph opened on a general statement
  // and addressed the reader in its second sentence.
  const contextFirst = 'When a client engagement ends, the next one needs to already be moving.\nYou saw that in March.\n\nWorth a look?'

  it('ACCEPTS a sentence of context before the callback, on email 3', () => {
    const f = checkFollowupGates({ ...base, position: 3, reference: REFERENCE, prose: contextFirst })
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(false)
  })

  it('REJECTS the same opening on email 2, which points straight away', () => {
    const f = checkFollowupGates({ ...base, position: 2, prose: contextFirst })
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
  })

  it('still rejects email 3 when the whole first paragraph never addresses the reader', () => {
    const f = checkFollowupGates({
      ...base, position: 3, reference: REFERENCE,
      prose: 'When an engagement ends, the next needs moving. Firms feel it a quarter later.\n\nWorth a look?',
    })
    expect(f.some(x => x.includes('opens without addressing the reader'))).toBe(true)
  })
})

describe("the reference's closing question is not an echo", () => {
  // MEASURED. One prospect with a clean personalised Email 1 lost its follow-ups to "worth
  // a quick call to see", six words of the client's own approved closing question.
  it('ACCEPTS reuse of the reference\'s closing question', () => {
    const ref = 'The bench is bigger than it was. Is it worth a quick call to see what that changes?'
    const f = checkFollowupGates({
      ...base, reference: ref,
      prose: 'You took the unit on.\n\nIs it worth a quick call to see what that changes?',
    })
    expect(f.some(x => x.includes('reproduces'))).toBe(false)
  })

  it('STILL rejects a lifted sentence from the body of the reference', () => {
    const ref = 'The bench is bigger than it was and the diary has not caught up. Worth a quick call?'
    const f = checkFollowupGates({
      ...base, reference: ref,
      prose: 'You took the unit on.\n\nThe bench is bigger than it was and the diary has not caught up.',
    })
    expect(f.some(x => x.includes('reproduces'))).toBe(true)
  })

  it('leaves a reference that ends in no question entirely alone', () => {
    const ref = 'The bench is bigger than it was and the diary has not caught up yet.'
    const f = checkFollowupGates({
      ...base, reference: ref,
      prose: 'You took the unit on.\n\nThe bench is bigger than it was and the diary has not caught up yet.',
    })
    expect(f.some(x => x.includes('reproduces'))).toBe(true)
  })
})
