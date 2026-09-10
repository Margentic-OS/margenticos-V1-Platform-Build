// THE OUTPUT CONTRACT AND THE REPLY LIMIT ARE TWO THINGS KEPT IN STEP BY HAND.
//
// ─── THE FAILURE THIS EXISTS FOR, WHICH ALREADY HAPPENED ─────────────────────
//
// The buyer-criterion prompt's JSON contract grew from six keys to eleven when the
// whole-document derivation landed, the last being a complete proposed search with a reason
// on every element. max_tokens stayed at 2,048.
//
// MEASURED 2026-09-09 on live clients: two of three runs failed with truncated JSON at
// roughly 7,300 characters, which is where 2,048 tokens runs out. The error said
//
//     Expected ',' or ']' after array element in JSON at position 7269
//
// and named a column number. Nothing named the cause. The derivation reported itself as
// having failed, which was true and useless: the model had answered correctly and the reply
// was cut off in transit.
//
// Nothing anywhere connected the two numbers. Adding a key to a prompt is an edit to a
// string; raising a cap is an edit to a constant; and the compiler, the type system and
// every existing test are equally blind to the relationship between them.
//
// ─── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
//
// It does NOT try to predict the exact size of a model's reply, which is not knowable. It
// asks a weaker and checkable question: given how many things the contract asks for, is the
// cap still in the range that was measured to work?
//
// The estimate is anchored on a real measurement rather than on a guess. An eleven-key
// contract produced a reply that ran past 7,300 characters, so the per-key cost is taken as
// that measured length divided by those keys, rounded up, and a safety factor applied
// because a reply is not the same size every time.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/**
 * Prompts whose reply size is bounded by a cap, paired with the file that declares the cap.
 *
 * ONE LIST OF PAIRS. There is no way to register a prompt without naming where its limit
 * lives, which is the whole shape of the defect: two facts in two files with nothing joining
 * them.
 */
const CONTRACTS = [
  {
    file: 'src/agents/buyer-criterion-agent.ts',
    promptSymbol: 'BUYER_CRITERION_PROMPT',
    limitSymbol: 'MAX_TOKENS',
    note: 'the single whole-document derivation call',
  },
] as const

/** Characters per token, conservative. Prose runs nearer 4; JSON with quoting runs lower. */
const CHARS_PER_TOKEN = 3.2

/**
 * Measured cost of one contract key, in characters.
 *
 * From the incident: an eleven-key contract produced a reply exceeding 7,300 characters
 * before it was cut off, so it had not finished. 7,300 / 11 is roughly 664, and the true
 * figure is higher because the reply was still going. Rounded to 700.
 */
const MEASURED_CHARS_PER_KEY = 700

/** A reply is not the same size twice. The cap must clear the estimate with room to spare. */
const SAFETY_FACTOR = 1.3

/** Top-level keys in the prompt's declared JSON contract. */
export function countContractKeys(promptText: string): number {
  // The contract is the last JSON object in the prompt, introduced by the OUTPUT section.
  const outputAt = promptText.lastIndexOf('OUTPUT')
  const region = outputAt === -1 ? promptText : promptText.slice(outputAt)
  const open = region.indexOf('{')
  if (open === -1) return 0

  // Walk to the matching close, so nested objects are not mistaken for the end.
  let depth = 0
  let close = -1
  for (let i = open; i < region.length; i++) {
    if (region[i] === '{') depth++
    else if (region[i] === '}') { depth--; if (depth === 0) { close = i; break } }
  }
  if (close === -1) return 0

  const body = region.slice(open + 1, close)
  // Top-level keys only: a key at nesting depth zero within the body.
  let d = 0
  let keys = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '[') d++
    else if (c === '}' || c === ']') d--
    else if (c === '"' && d === 0) {
      // A quoted run at depth zero followed by a colon is a key.
      const end = body.indexOf('"', i + 1)
      if (end === -1) break
      const after = body.slice(end + 1).match(/^\s*:/)
      if (after) keys++
      i = end
    }
  }
  return keys
}

function readSymbolNumber(source: string, symbol: string): number | null {
  const m = source.match(new RegExp(`${symbol}\\s*=\\s*([0-9_]+)`))
  return m ? Number(m[1].replace(/_/g, '')) : null
}

function readTemplate(source: string, symbol: string): string {
  const at = source.indexOf(symbol)
  if (at === -1) return ''
  const open = source.indexOf('`', at)
  if (open === -1) return ''
  const close = source.indexOf('`', open + 1)
  return close === -1 ? '' : source.slice(open + 1, close)
}

describe('a prompt may not ask for more than its reply limit can carry', () => {
  for (const contract of CONTRACTS) {
    it(`${contract.note}: the cap clears the contract`, () => {
      const source = readFileSync(join(ROOT, contract.file), 'utf-8')
      const prompt = readTemplate(source, contract.promptSymbol)
      const limit = readSymbolNumber(source, contract.limitSymbol)

      // Positive control on the instrument: if either read comes back empty the assertion
      // below would pass vacuously, which is exactly how this class of check goes quiet.
      expect(prompt.length, `${contract.promptSymbol} did not read`).toBeGreaterThan(500)
      expect(limit, `${contract.limitSymbol} did not read`).not.toBeNull()

      const keys = countContractKeys(prompt)
      expect(keys, 'no contract keys found; the extractor is broken, not the contract').toBeGreaterThan(3)

      const neededChars = keys * MEASURED_CHARS_PER_KEY * SAFETY_FACTOR
      const neededTokens = Math.ceil(neededChars / CHARS_PER_TOKEN)

      expect(
        limit!,
        `The contract asks for ${keys} keys, which needs about ${neededTokens} tokens at the ` +
        `measured ${MEASURED_CHARS_PER_KEY} characters a key, and ${contract.limitSymbol} is ` +
        `${limit}. This is the shape that truncated two live runs: the reply was cut off at ` +
        `roughly 7,300 characters and the parse error named a column number rather than a cause. ` +
        `Raise ${contract.limitSymbol}, or ask for less.`,
      ).toBeGreaterThanOrEqual(neededTokens)
    })
  }
})

describe('the extractor measures the contract rather than the prompt', () => {
  it('counts top-level keys and ignores nested ones', () => {
    const prompt = 'blah\n\nOUTPUT\n\n{\n "a": 1,\n "b": { "nested": 2, "also": 3 },\n "c": [{ "deep": 4 }]\n}'
    // Three keys, not six: the nested ones are part of one key's value.
    expect(countContractKeys(prompt)).toBe(3)
  })

  it('reads the LAST object, so prose earlier in the prompt cannot inflate it', () => {
    const prompt = '{ "not": "the contract", "at": "all" }\n\nOUTPUT\n\n{ "only": 1 }'
    expect(countContractKeys(prompt)).toBe(1)
  })

  it('returns zero on a prompt with no contract, so the guard fails rather than passes', () => {
    expect(countContractKeys('a prompt that asks for prose')).toBe(0)
  })
})
