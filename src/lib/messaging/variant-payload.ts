// Splicing ONE variant into a stored messaging payload, and proving nothing else moved.
//
// WHY THIS EXISTS. A messaging run can ship three of four variants when a slot runs out of
// call budget, and the repair for that writes the missing slot back into a suggestion an
// operator is already looking at. The other three variants in that row are copy that has
// been read, and may have been read and accepted; rewriting one of them by accident is a
// silent content change under an operator who has no reason to re-read.
//
// A read-modify-write of a JSON blob makes that failure easy and invisible. Re-serialising
// a parsed object can reorder keys, reformat a number, or carry a mutation made anywhere
// between the read and the write, and the row still looks like a normal payload afterwards.
// Nothing downstream can tell.
//
// So the write is GATED ON A COMPARISON, not on care. assertOnlyVariantAdded reads the
// bytes that came out of the database and the bytes about to go in, and refuses any
// difference outside the one key being added. The caller runs it before writing AND again
// against a read-back after writing, because the first proves what was sent and only the
// second proves what landed.
//
// PURE and free of any database dependency, so the failing direction is testable: a
// payload whose untouched variant changed must throw, not merely be unlikely.

import { createHash } from 'node:crypto'

/** The stored shape: { variants: { A: {...}, B: {...} } }. */
export interface VariantPayload {
  variants: Record<string, unknown>
}

export class VariantPayloadWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VariantPayloadWriteError'
  }
}

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * Key ORDER is not meaning, so comparing raw JSON.stringify output would fail on a
 * reserialisation that changed nothing. Sorting removes that false positive while keeping
 * every real one: a changed value, a dropped field, an added field.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'
}

/** Parses a stored payload, refusing anything that is not the variants shape. */
export function parseVariantPayload(raw: string | null): VariantPayload {
  if (!raw) throw new VariantPayloadWriteError('Variant payload is empty.')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new VariantPayloadWriteError(`Variant payload is not valid JSON: ${String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VariantPayloadWriteError('Variant payload is not a JSON object.')
  }

  const variants = (parsed as { variants?: unknown }).variants
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) {
    throw new VariantPayloadWriteError('Variant payload has no `variants` object.')
  }

  return { variants: variants as Record<string, unknown> }
}

/**
 * sha256 of each variant's canonical form, keyed by variant key.
 *
 * This is the fingerprint the positive control is stated in. It is taken from a payload
 * STRING rather than from an in-memory object on purpose: hashing the object the caller is
 * holding would only prove the caller did not mutate its own variable, which is not the
 * claim. The claim is about what the database held and what it holds now.
 */
export function variantFingerprints(raw: string | null): Map<string, string> {
  const { variants } = parseVariantPayload(raw)
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(variants)) {
    out.set(key, createHash('sha256').update(canonicalJson(value)).digest('hex'))
  }
  return out
}

/**
 * Throws unless `after` is `before` plus exactly one new variant under `addedKey`.
 *
 * Checks all three ways this can go wrong, because checking only the added key is the
 * version that passes while the damage is elsewhere:
 *   1. addedKey was absent before and is present now
 *   2. the key SET is otherwise identical, so nothing was dropped and nothing else appeared
 *   3. every pre-existing variant fingerprints identically
 */
export function assertOnlyVariantAdded(
  before: string | null,
  after: string | null,
  addedKey: string,
  context: string,
): void {
  const beforePrints = variantFingerprints(before)
  const afterPrints = variantFingerprints(after)

  if (beforePrints.has(addedKey)) {
    throw new VariantPayloadWriteError(
      `${context}: variant ${addedKey} already existed before the write. A repair adds a ` +
      'missing variant and never replaces one that is present.'
    )
  }
  if (!afterPrints.has(addedKey)) {
    throw new VariantPayloadWriteError(
      `${context}: variant ${addedKey} is absent after the write.`
    )
  }

  const expected = [...beforePrints.keys(), addedKey].sort()
  const actual = [...afterPrints.keys()].sort()
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new VariantPayloadWriteError(
      `${context}: variant key set changed beyond the addition. Expected ` +
      `${expected.join(', ')} and found ${actual.join(', ')}.`
    )
  }

  const moved: string[] = []
  for (const [key, print] of beforePrints) {
    if (afterPrints.get(key) !== print) moved.push(key)
  }
  if (moved.length > 0) {
    throw new VariantPayloadWriteError(
      `${context}: variant ${moved.join(', ')} changed during a repair that may only add ` +
      `${addedKey}. Refusing the write. This copy may already have been read by an operator.`
    )
  }
}

/**
 * `before` with one variant added under `addedKey`, as a JSON string, guarded.
 *
 * The guard runs on this function's OWN output, so a caller cannot get an unchecked
 * payload out of it even by mistake. What the caller still has to do separately is run the
 * same guard against a read-back, because this proves only what was built.
 */
export function spliceVariant(
  before: string | null,
  addedKey: string,
  variant: unknown,
  context: string,
): string {
  const { variants } = parseVariantPayload(before)

  // Rebuilt from the parsed survivors rather than mutated in place, so the input object is
  // never the thing that gets written and a shared reference cannot leak an edit in.
  const next: VariantPayload = { variants: { ...variants, [addedKey]: variant } }
  const encoded = JSON.stringify(next)

  assertOnlyVariantAdded(before, encoded, addedKey, context)
  return encoded
}
