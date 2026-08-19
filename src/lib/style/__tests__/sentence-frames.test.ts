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
