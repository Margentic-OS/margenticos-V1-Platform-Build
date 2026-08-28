import { describe, it, expect, vi } from 'vitest'
import * as finiteVerbModule from '../finite-verb'
import {
  findVerblessSentences,
  checkFiniteVerbs,
  FINITE_VERB_GATE_MODE,
  FINITE_VERB_WORD_LISTS,
} from '../finite-verb'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// EVERY FIXTURE IN THIS FILE IS INVENTED, and every one is about weather, furniture,
// gardening, cooking or timetables. Nothing is copied from the writer prompt, from the
// database, or from another test file. A copied example carries whichever client it came
// from into the repository, and has done four times already.

const CONTEXT = { prospectId: 'test-prospect', part: 'observation' }

describe('findVerblessSentences', () => {
  it('flags a bare noun list punctuated as a sentence', () => {
    const text = 'Two kettles, a stack of plates and a toaster on the counter.'
    expect(findVerblessSentences(text)).toEqual([text])
  })

  it('flags a sentence whose only verb-like word is a bare -ing participle', () => {
    const text = 'Rain falling steadily across the allotment all afternoon.'
    expect(findVerblessSentences(text)).toEqual([text])
  })

  // THE ASYMMETRY RULE, AND THE HIGHEST-VALUE TEST IN THIS FILE.
  //
  // A bare -ed word is far more often a simple past than a bare participle. Reading it as
  // a participle would flag enormous numbers of correct sentences, so it counts as finite.
  // Its mirror image, the -ing case above, does not. Swap the two and the gate is useless
  // in both directions at once: it would pass the fragments it exists to catch and reject
  // ordinary prose.
  it('does NOT flag a sentence whose only verb is a bare -ed past form', () => {
    expect(findVerblessSentences('The gardener planted three rows of onions.')).toEqual([])
  })

  it('does NOT flag a normal sentence with a third-singular lexical verb', () => {
    expect(findVerblessSentences('The bus goes past the library every hour.')).toEqual([])
  })

  it('does NOT flag a normal sentence with a copula', () => {
    expect(findVerblessSentences('The kitchen window is stuck again.')).toEqual([])
  })

  it('skips a sentence under four words', () => {
    // Verbless, and deliberately ignored: too short to judge, and a short fragment is a
    // style choice rather than the accident this hunts.
    expect(findVerblessSentences('Cold soup again.')).toEqual([])
  })

  it('skips a question', () => {
    expect(findVerblessSentences('Any chance of a lift on Thursday?')).toEqual([])
  })

  it('finds the fragment among sentences that are fine, and returns it verbatim', () => {
    const fragment = 'Four bicycles and a lawnmower behind the garage.'
    const text = `The garage door was open all week. ${fragment} We locked it on Sunday.`
    expect(findVerblessSentences(text)).toEqual([fragment])
  })

  it('does not flag an -ed participle sentence carried by its auxiliary', () => {
    expect(findVerblessSentences('The fence has been repainted twice this year.')).toEqual([])
  })

  it('does not flag a contraction standing in for the verb', () => {
    expect(findVerblessSentences("The oven's been cold since Tuesday morning.")).toEqual([])
    expect(findVerblessSentences('The neighbours don’t use the side gate.')).toEqual([])
    expect(findVerblessSentences("It's colder in the porch than the garden.")).toEqual([])
  })

  // THE POSSESSIVE, WHICH IS NOT A VERB. An unconditional 's rule read this as one and
  // let a bare noun phrase through, which was the single biggest hole in the first draft.
  it('flags a noun phrase built round a possessive', () => {
    const text = "The neighbour's untidy pile of firewood."
    expect(findVerblessSentences(text)).toEqual([text])
  })

  it('still passes a possessive when the sentence has a verb elsewhere', () => {
    expect(findVerblessSentences("The neighbour's firewood sits across the path.")).toEqual([])
  })

  it('returns nothing for empty text', () => {
    expect(findVerblessSentences('')).toEqual([])
  })

  // ACCEPTED MISSES, PINNED SO NEITHER IS LATER MISTAKEN FOR A BUG.
  //
  // Both fall out of the asymmetry rule and the refusal to disambiguate homographs, and
  // both fail in the permitted direction: one imperfect email, rather than good copy
  // rejected and a retry paid for. Each of these was a genuine fixture in the first draft
  // of this file and the gate passed all of them, which is how they came to be documented.
  it('MISSES a noun-phrase fragment containing an -ed adjective', () => {
    // "chipped" is adjectival here, but a bare -ed word counts as finite by design.
    expect(findVerblessSentences('Two kettles and a stack of chipped plates.')).toEqual([])
  })

  it('MISSES a noun-phrase fragment containing a noun that doubles as a verb', () => {
    // "runs" is a plural noun here and a third-singular verb in the list. Nothing
    // deterministic can tell the two apart without a tagger.
    expect(findVerblessSentences('Three runs of the dishwasher every evening.')).toEqual([])
  })

  it('MISSES a fragment ending in a short noun that happens to end in -ed', () => {
    // "shed" is a noun, and the asymmetry rule reads any -ed word as a simple past. No
    // minimum length is imposed, because excluding short -ed words would start rejecting
    // real four-letter verbs such as "used" and "aged", which is the expensive direction.
    expect(findVerblessSentences('Four bicycles and a lawnmower in the shed.')).toEqual([])
  })
})

describe('gate mode', () => {
  it('is report-only today', () => {
    expect(FINITE_VERB_GATE_MODE).toBe('report')
  })

  it('returns no failures in report mode even when it found something', () => {
    const text = 'Three deckchairs and a parasol by the back wall.'
    expect(findVerblessSentences(text)).toHaveLength(1)
    expect(checkFiniteVerbs(text, CONTEXT)).toEqual([])
  })

  // The blocking path is executed here and nowhere else in production. A flip that has
  // never been run is a flip nobody has tested, and the moment of flipping is the worst
  // possible time to discover it throws.
  it('returns failure strings when passed block explicitly', () => {
    const text = 'Three deckchairs and a parasol by the back wall.'
    const failures = checkFiniteVerbs(text, CONTEXT, 'block')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('no verb in it')
    expect(failures[0]).toContain(text)
  })

  it('returns nothing in block mode when the text is clean', () => {
    expect(checkFiniteVerbs('The parasol blew over in the night.', CONTEXT, 'block')).toEqual([])
  })
})

describe('RULE ZERO: the word lists carry no client or industry content', () => {
  // A word list of English verbs is inherently neutral. This test is what keeps it that
  // way: a company name, a job title or a sector term added to one of these lists would
  // almost certainly arrive capitalised, hyphenated across a space, or with a digit in it.
  it('every entry is lowercase, whitespace-free and digit-free', () => {
    for (const [listName, list] of Object.entries(FINITE_VERB_WORD_LISTS)) {
      // Guards against a vacuous pass: an empty list would satisfy every assertion below
      // without checking anything.
      expect(list.length, `${listName} is empty`).toBeGreaterThan(0)

      for (const entry of list) {
        expect(entry, `${listName} entry "${entry}" is not lowercase`).toBe(entry.toLowerCase())
        expect(/\s/.test(entry), `${listName} entry "${entry}" contains whitespace`).toBe(false)
        expect(/\d/.test(entry), `${listName} entry "${entry}" contains a digit`).toBe(false)
      }
    }
  })

  // CHECKS THE REGISTRY AGAINST THE FILE, NOT AGAINST ITSELF. FINITE_VERB_WORD_LISTS is a
  // second list that has to stay in step with the module's exports by hand, which is the
  // parallel-array shape. Without this, a new word list could be added and silently never
  // reach the Rule Zero assertions above, and the suite would stay green.
  it('every exported word list appears in FINITE_VERB_WORD_LISTS', () => {
    const exportedLists = Object.entries(finiteVerbModule)
      .filter(([, value]) => Array.isArray(value))
      .map(([name]) => name)

    expect(exportedLists.length).toBeGreaterThan(0)
    for (const name of exportedLists) {
      expect(FINITE_VERB_WORD_LISTS, `${name} is exported but not registered`).toHaveProperty(name)
    }
  })
})
