// WHAT THE WRITER MAY BE SHOWN OF A CLIENT'S VOICE: their own sentences, and nothing the
// document generator wrote for them.
//
// EVERY SENTENCE IN THIS FILE IS INVENTED. No client's sample text appears in the repository,
// in code or in a fixture: the samples are read from that client's own document at runtime.

import { describe, it, expect } from 'vitest'
import { extractVoiceSamples } from '../voice-samples'
import { buildWriterAssignment, buildWriterPrompt } from '../write-opening'

const doc = {
  voice_characteristics: [
    { characteristic: 'x', description: 'y', evidence: '"The first three weeks were quiet, then everything landed at once."' },
    { characteristic: 'x', description: 'y', evidence: '"You\'re running the whole thing yourself, and it\'s been that way since spring."' },
  ],
  what_this_voice_never_does: [
    { rule: 'r', evidence: 'Both notes end the same way: "We will sort this out before Friday." and nothing else follows.' },
    { rule: 'r', evidence: 'No exclamation mark appears anywhere in the two messages.' },
  ],
  sentence_mechanics: {
    opening_move_pattern: 'Verbatim openers: "Good to catch up this morning, thanks for the detail."',
    punctuation_patterns: 'Short spans like "so it goes" sit below the floor.',
  },
  writing_rules: [{ rule: 'r', why: 'w', example_correct: '"This generated line must never be passed to the writer."', example_violation: '"Nor this one."' }],
  do_dont_list: { do: ['"This generated line must never be passed either."'], dont: ['"Nor this."'] },
  before_after_examples: [{ context: 'c', before: '"A generated before line that must not be passed."', after: '"A generated after line that must not be passed."' }],
  vocabulary: { words_they_use: ['engine', 'stuck'], words_they_avoid: ['leverage'] },
}

describe('extractVoiceSamples', () => {
  it('takes the quoted evidence from the three sections that quote the client', () => {
    expect(extractVoiceSamples(doc)).toEqual([
      'The first three weeks were quiet, then everything landed at once.',
      "You're running the whole thing yourself, and it's been that way since spring.",
      'We will sort this out before Friday.',
      'Good to catch up this morning, thanks for the detail.',
    ])
  })

  it('takes nothing the document generator wrote', () => {
    const out = extractVoiceSamples(doc).join(' | ')
    for (const generated of ['must never be passed', 'must not be passed', 'Nor this']) {
      expect(out).not.toContain(generated)
    }
  })

  it('keeps a contraction whole, because an apostrophe is not a quote mark', () => {
    expect(extractVoiceSamples(doc)).toContain("You're running the whole thing yourself, and it's been that way since spring.")
  })

  it('drops a span shorter than the floor, and a field with no quote at all', () => {
    const out = extractVoiceSamples(doc)
    expect(out).not.toContain('so it goes')
    expect(out.some(s => s.includes('exclamation'))).toBe(false)
  })

  it('keeps the longest form when the same sentence is quoted twice', () => {
    const twice = {
      voice_characteristics: [{ evidence: '"The week filled up and the calls stopped, which is the whole problem."' }],
      sentence_mechanics: { dominant_sentence_length: 'For example "the calls stopped, which is the whole problem."' },
    }
    expect(extractVoiceSamples(twice)).toEqual(['The week filled up and the calls stopped, which is the whole problem.'])
  })

  it('returns an empty array for a document with no quoted evidence, and for nothing at all', () => {
    expect(extractVoiceSamples({ writing_rules: [{ example_correct: '"Generated only."' }] })).toEqual([])
    expect(extractVoiceSamples(null)).toEqual([])
    expect(extractVoiceSamples(undefined)).toEqual([])
    expect(extractVoiceSamples('a string')).toEqual([])
  })
})

describe('the assignment block, which is where samples reach the writer', () => {
  const assignment = (voiceSamples?: string[]) =>
    buildWriterAssignment({ clientName: 'A Client', buyer: 'Founder', p3: 'The offer line.', cta: 'Is that useful?', voiceSamples })

  it('shows the samples under one heading, in the user message and not the prompt', () => {
    const out = assignment(['The first three weeks were quiet.', 'We will sort this out before Friday.'])
    expect(out).toContain('## How the sender writes')
    expect(out).toContain('"The first three weeks were quiet."')
    expect(out).toContain('"We will sort this out before Friday."')
  })

  it('omits the block entirely for a client with no samples', () => {
    for (const none of [undefined, [], ['   ']]) {
      expect(assignment(none)).not.toContain('How the sender writes')
    }
  })

  it('frames them once in the system prompt, which stays the same for every client', () => {
    const prompt = buildWriterPrompt()
    expect(prompt).toContain('under "How the sender writes"')
    expect(prompt).toContain('neither sentences to reuse nor facts about your prospect')
    // The prompt is a constant: no client value can reach it.
    expect(buildWriterPrompt()).toBe(prompt)
  })
})
