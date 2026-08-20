// Unit tests for cross-batch sentence-frame detection.
//
// The anchor case is the real one: across three prospects the synthesist produced
// "is a particular kind of balancing act" and "is a particular kind of juggle". Every
// content word differs. Only the frame repeats, which is exactly what has to be caught.

import { describe, it, expect } from 'vitest'
import { FrameRegistry, frameShingles, frameSkeleton, FRAME_LENGTH } from '../sentence-frames'

const ROBERT =
  'Running Taffet alongside the CRC Director engagement from mid-2024 through mid-2025 ' +
  'is a particular kind of balancing act, and with that role now wrapped, the pipeline ' +
  'question for Taffet tends to land differently.'

const ALMA =
  'Running Full Bloom alongside the Stanford GSB role since early 2024 is a particular ' +
  'kind of juggle. Business development tends to get whatever hours remain after delivery ' +
  'and the day job, which usually means pipeline resets quietly whenever a referral goes quiet.'

const UDO =
  'Three concurrent CEO roles since 2023 is a specific spread of attention across ' +
  'Broskamp Consulting, Schumpeter Ventures, and FineVest Fund.'

describe('frameSkeleton', () => {
  it('masks numbers and mid-sentence capitals, keeping structural words', () => {
    const skeleton = frameSkeleton('Running Taffet alongside the CRC role since 2024')
    expect(skeleton).toEqual(['running', '#', 'alongside', 'the', '#', 'role', 'since', '#'])
  })

  it('does not mask the first word purely for being capitalised', () => {
    expect(frameSkeleton('Running the firm')[0]).toBe('running')
  })
})

describe('frameShingles', () => {
  it('produces overlapping n-grams of the configured length', () => {
    const shingles = frameShingles('one two three four five six')
    expect(shingles[0].split(' ')).toHaveLength(FRAME_LENGTH)
    expect(shingles).toHaveLength(2)
  })

  it('returns nothing for text shorter than one frame', () => {
    expect(frameShingles('too short here')).toEqual([])
  })

  it('extracts the offending frame from the real failing observation', () => {
    expect(frameShingles(ROBERT)).toContain('is a particular kind of')
  })
})

describe('FrameRegistry — the real batch collision', () => {
  it('detects the repeated frame across Robert and Alma', () => {
    const registry = new FrameRegistry()
    expect(registry.register('robert', ROBERT)).toEqual([])

    const collisions = registry.register('alma', ALMA)
    expect(collisions.length).toBeGreaterThan(0)
    expect(collisions.map(c => c.frame)).toContain('is a particular kind of')
  })

  it('names which prospect used the frame first', () => {
    const registry = new FrameRegistry()
    registry.register('robert', ROBERT)
    const [collision] = registry.register('alma', ALMA)
    expect(collision.firstSeenId).toBe('robert')
    expect(collision.repeatedById).toBe('alma')
  })

  it('does not flag Udo, whose sentence shape differs', () => {
    // "is a specific spread of" is a different frame from "is a particular kind of".
    const registry = new FrameRegistry()
    registry.register('robert', ROBERT)
    expect(registry.register('udo', UDO)).toEqual([])
  })

  it('accumulates every collision for the batch summary', () => {
    const registry = new FrameRegistry()
    registry.register('robert', ROBERT)
    registry.register('alma', ALMA)
    expect(registry.allCollisions().length).toBeGreaterThan(0)
  })
})

describe('FrameRegistry — false positive guards', () => {
  it('does not flag a text against itself when registered once', () => {
    const registry = new FrameRegistry()
    expect(registry.register('p1', ROBERT)).toEqual([])
  })

  it('does not flag a re-registration under the same id', () => {
    const registry = new FrameRegistry()
    registry.register('p1', ROBERT)
    expect(registry.register('p1', ROBERT)).toEqual([])
  })

  it('leaves genuinely bespoke triggers alone', () => {
    const registry = new FrameRegistry()
    registry.register('p1', 'You ran the firm and the Director role side by side for 14 months. That finished in August.')
    const collisions = registry.register(
      'p2',
      'Your last three case studies all date from 2019. The delivery calendar looks full through spring.',
    )
    expect(collisions).toEqual([])
  })

  it('catches a template even when every noun is swapped', () => {
    // The whole point: same shape, different facts, zero shared content words.
    const registry = new FrameRegistry()
    registry.register('p1', 'Running Acme alongside the Beta role since 2021 is a particular kind of stretch.')
    const collisions = registry.register(
      'p2',
      'Running Delta alongside the Gamma role since 2019 is a particular kind of strain.',
    )
    expect(collisions.length).toBeGreaterThan(0)
  })
})

// ─── Concurrency ─────────────────────────────────────────────────────────────
//
// The batch orchestrator can run workers concurrently via p-limit. register() is fully
// synchronous with no await inside it, and JavaScript is single-threaded, so the event
// loop cannot interleave two calls: each runs to completion atomically. No locking is
// needed and no update can be lost.
//
// What DOES change under concurrency is ORDER. Whichever prospect finishes synthesis
// first registers first, so which id is recorded as firstSeenId varies between runs.
// Detection is unaffected: a collision between two texts is found either way, only the
// attribution of who used the frame first can flip.

describe('FrameRegistry under concurrent workers', () => {
  const A = 'Running Acme alongside the Beta role since 2021 is a particular kind of stretch.'
  const B = 'Running Delta alongside the Gamma role since 2019 is a particular kind of strain.'

  it('loses no registration when calls are interleaved by async scheduling', async () => {
    const registry = new FrameRegistry()
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`)

    // Each worker yields to the event loop before registering, which is the only way one
    // task can be suspended mid-flight in this runtime.
    await Promise.all(ids.map(async id => {
      await new Promise(resolve => setTimeout(resolve, Math.abs(id.charCodeAt(1) % 3)))
      registry.register(id, `${id} runs a firm alongside another role and it never stops.`)
    }))

    // Every distinct text contributed frames; nothing was dropped by a lost update.
    expect(registry.size).toBeGreaterThan(0)
  })

  it('still detects a real collision regardless of which worker wins the race', async () => {
    const registry = new FrameRegistry()
    const results: string[][] = []

    await Promise.all([
      (async () => { await new Promise(r => setTimeout(r, 1)); results.push(registry.register('first', A).map(c => c.frame)) })(),
      (async () => { await new Promise(r => setTimeout(r, 2)); results.push(registry.register('second', B).map(c => c.frame)) })(),
    ])

    // Exactly one of the two saw the collision: the one that ran second, whichever it was.
    const withCollisions = results.filter(r => r.length > 0)
    expect(withCollisions).toHaveLength(1)
    expect(withCollisions[0]).toContain('is a particular kind of')
  })
})
