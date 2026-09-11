// Reads the writer prompt's worked examples OUT OF buildWriterPrompt() at runtime.
//
// WHY THIS EXISTS. Six tests held their own copies of the prompt's examples and checked the
// copies. The prompt was edited and the copies were not, so by 2026-09-10 fourteen of the
// strings those tests checked existed nowhere in the prompt, and all six still passed. A
// test that checks its own literal is green whatever the prompt says. Reading the examples
// from the prompt means an edit to the prompt is an edit to what these tests check.
//
// FAILS LOUD, NEVER QUIET. A missing marker throws, and every caller asserts how many
// specimens it expected, because the failure this replaces is a check that stopped
// checking and stayed green. writer-prompt-no-back-reference.test.ts reads its specimens
// from the same prompt for the same reason.

import { buildWriterPrompt } from '../write-opening'

/** The prompt text from `from` up to the next `to`. Throws if either marker is missing. */
export function promptSection(from: string, to: string): string {
  const p = buildWriterPrompt()
  const start = p.indexOf(from)
  if (start === -1) throw new Error(`writer prompt section start not found: "${from}"`)
  const end = p.indexOf(to, start + from.length)
  if (end === -1) throw new Error(`writer prompt section end not found after its start: "${to}"`)
  return p.slice(start, end)
}

/** Every quoted specimen in `text` that directly follows `label`, whitespace-flattened. */
export function specimensAfter(text: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...text.matchAll(new RegExp(`${escaped}\\s*"([^"]+)"`, 'g'))]
    .map(m => m[1].replace(/\s+/g, ' ').trim())
}

function exactlyOne(found: string[], what: string): string {
  if (found.length !== 1) throw new Error(`expected exactly one ${what} in the writer prompt, found ${found.length}`)
  return found[0]
}

export const SHAPE_MODEL_LABELS = [
  'A dentist:', 'A commercial builder:', 'A freight broker:', 'A wedding photographer:',
] as const

/** The four bridge-shape models, in prompt order. A label that lost its specimen drops out. */
export function shapeModels(): string[] {
  const section = promptSection('EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY', 'There are more shapes than these four')
  return SHAPE_MODEL_LABELS.flatMap(label => specimensAfter(section, label))
}

/** The CONCRETE rewrites under the concrete-nouns rule. */
export function concreteRewrites(): string[] {
  return specimensAfter(promptSection('NO METAPHORS.', 'THE CAMERA TEST.'), 'CONCRETE, same idea:')
}

/** The PLAIN rewrites under the camera test. */
export function plainRewrites(): string[] {
  return specimensAfter(promptSection('FINISH ON A CONCRETE THING', 'POINT EVERY SENTENCE AT THE PERSON.'), 'PLAIN:')
}

/** The corrected print-shop bridge under the pattern-not-verdict rule. */
export function printShopBridge(): string {
  const section = promptSection('PATTERN, corrected, and deliberately about a PRINT SHOP:', 'Nothing here claims')
  return exactlyOne(specimensAfter(section, 'bridge:'), 'print-shop bridge')
}

/**
 * What the camera test calls filmable. It used to be a sentence, "Delivery has a deadline",
 * which was deleted after it was lifted verbatim into a real bridge. The slot is now a
 * description, and this returns it.
 */
export function filmableDescription(): string {
  const marker = 'Nobody can photograph an hour shrinking.'
  const text = promptSection(marker, 'Every noun is concrete now').slice(marker.length).replace(/\s+/g, ' ').trim()
  if (text.length < 20) throw new Error('the camera test lost its filmable description')
  return text
}
