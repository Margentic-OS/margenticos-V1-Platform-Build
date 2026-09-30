// TWO FUNCTIONS BUILD A COMPLETE EMAIL 1, AND THEY MUST AGREE ON THE TAIL.
//
// composeSequence builds what is sent. composeEmail1WithOpening builds what the research
// judge, the follow-up fingerprint and every offline read see. The second exists so a
// reader sees the real artifact rather than an approximation of it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-30 MEASUREMENT. The trademark strip was added to composeSequence on
// 2026-09-25 and not to composeEmail1WithOpening, although that function's own comment
// asks the next person to keep the two in step. Five days later one prospect's Email 1 in
// a blind operator read carried a trademark symbol three times, in the observation, the
// bridge and the closing question, and was failed on it. The email that would have SHIPPED
// was clean.
//
// That split is worse than the symbol. The reviewer distrusts copy the pipeline would have
// fixed, the pipeline reports nothing wrong because nothing is wrong on its own path, and
// no test fails because no fixture anywhere carries a symbol. This file is that fixture.
//
// WHAT THE THIRD CALLER TAUGHT US. There were three footer call sites, not two. The third
// takes the Email 1 fingerprint the follow-up gate compares against the one research
// recorded. Had only the two reading paths been fixed, both sides of that comparison would
// have hashed different strings for every symbol-carrying prospect, and those prospects
// would have silently shipped approved template follow-ups with the right word counts and
// no error. So the guard here is not "does each path strip". It is "is there exactly one
// tail", which is the only form that survives a fourth path being added.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeEmail1WithOpening } from '../compose-sequence'
import type { MessagingContent } from '../compose-sequence'

// An invented framework name, symbol attached, as a prospect's own site would carry it.
const FRAMEWORK = 'Sightline Cadence™'
const OBSERVATION = `You published a full guide to ${FRAMEWORK} in April.`
const BRIDGE = `Buyers who have not come across ${FRAMEWORK} have no reason to ask for it.`
const QUESTION = `Is reaching buyers who have not met ${FRAMEWORK} yet a current priority?`

const DOC: MessagingContent = {
  variants: {
    A: {
      variant_id: 'A',
      emails: [
        {
          sequence_position: 1,
          subject_line: 'pipeline after referrals',
          body: [
            '{{first_name}}',
            'THE APPROVED OPENER GOES HERE.',
            'We fill the diary with qualified meetings.',
            'Worth a look to see if it fits where you are?',
            'Merrin\nNorthwind Labs',
          ].join('\n\n'),
          word_count: 0,
        },
      ],
    },
  },
} as unknown as MessagingContent

// Every symbol the shared strip removes. Listed by codepoint so the file itself stays
// readable and so a reviewer can see the set is the whole set.
const SYMBOLS = ['™', '®', '©', '℠']

describe('the reading path strips trademark symbols, exactly as the sending path does', () => {
  it('removes the symbol from the observation, the bridge and the written question', () => {
    const email = composeEmail1WithOpening(
      DOC,
      'A',
      `${OBSERVATION}\n\n${BRIDGE}`,
      QUESTION,
      'Ines',
    )

    // The positive control FIRST: prove the fixture really carries what we claim, so a
    // green assertion below cannot mean the symbol was never there.
    expect(OBSERVATION).toContain('™')
    expect(BRIDGE).toContain('™')
    expect(QUESTION).toContain('™')

    for (const symbol of SYMBOLS) {
      expect(email.body).not.toContain(symbol)
    }
    // And the NAME survives, minus the symbol. A strip that removed the framework would
    // pass the assertion above and destroy the personalisation.
    expect(email.body).toContain('Sightline Cadence')
  })

  it('removes the symbol from a written subject line', () => {
    const email = composeEmail1WithOpening(
      DOC,
      'A',
      `${OBSERVATION}\n\n${BRIDGE}`,
      QUESTION,
      'Ines',
      `${FRAMEWORK} and referrals`,
    )
    expect(email.subject_line).toBe('Sightline Cadence and referrals')
  })

  it('removes a symbol carried by the approved template itself', () => {
    const doc = JSON.parse(JSON.stringify(DOC)) as MessagingContent
    const email1 = doc.variants!.A.emails[0]
    email1.body = email1.body.replace('Northwind Labs', 'Northwind Labs®')

    const composed = composeEmail1WithOpening(doc, 'A', 'A plain opening.', null, 'Ines')
    expect(composed.body).not.toContain('®')
    expect(composed.body).toContain('Northwind Labs')
  })
})

describe('there is exactly one tail, so a new path cannot take the footer without the strip', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/lib/composition/compose-sequence.ts'),
    'utf8',
  )

  it('calls appendOptOutFooter from exactly one place, and that place also strips', () => {
    // GUARD THE GUARD. A scan that finds nothing passes vacuously, and this scan would
    // find nothing if the file moved or the function were renamed.
    const definition = /function appendOptOutFooter\(/.exec(source)
    expect(definition, 'appendOptOutFooter is gone or renamed: update this test').not.toBeNull()

    // Calls, not the definition: the definition is `function appendOptOutFooter(`, a call
    // is the bare name followed by `(`.
    const calls = [...source.matchAll(/(?<!function )\bappendOptOutFooter\(/g)]
    expect(calls).toHaveLength(1)

    // The one call is inside finaliseForReading, and finaliseForReading strips. Read the
    // function's text rather than asserting on line numbers, which move.
    const tail = /function finaliseForReading\([\s\S]*?\n}/.exec(source)
    expect(tail, 'finaliseForReading is gone or renamed: update this test').not.toBeNull()
    expect(tail![0]).toContain('appendOptOutFooter(')
    expect(tail![0]).toContain('stripSymbols(e.body)')
    expect(tail![0]).toContain('stripSymbols(e.subject_line)')
  })
})
