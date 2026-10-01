// The targeting fields (ADR-061): which edits to an ICP may change who is sourced.
//
// ─── WHAT THESE TESTS ARE FOR ────────────────────────────────────────────────
//
// On 2026-09-30 an edit to two trigger reasons rebuilt a client's search. The module under
// test exists so that cannot happen: a prose edit must compare as "no change". Three kinds
// of test hold that, and each guards against a different way of being wrong.
//
//   PINNED    the projection is asserted as a literal. Adding or dropping a targeting
//             field fails here first, so the list never changes by accident.
//   PLANTED   an edit is planted on EVERY leaf of a full document, one at a time, and the
//             comparison must report a change exactly when the leaf is a targeting field.
//             A test that only edits fields somebody thought of proves nothing about the
//             field nobody thought of.
//   RECORDED  the derivation is run against a document that records every field it reads,
//             and every read must be a targeting field. This checks the WORLD, not the type:
//             a cast can get past the compiler and cannot get past this.
//
// ─── NOTHING HERE NAMES A REAL INDUSTRY, ROLE OR COUNTRY ─────────────────────
//
// Industries are taken from the canonical list by position, bands and countries from the
// shared fixtures, and every other value is a placeholder. A fixture naming one market is
// how that market's vocabulary ends up in the next test, and then in a default.

import { describe, it, expect } from 'vitest'
import {
  compareTargetingInputs,
  readStoredTargetingInputs,
  targetingInputs,
  usableHeadcountPair,
  type TargetingDocument,
} from '@/lib/sourcing/targeting-inputs'
import { CANONICAL_INDUSTRIES, deriveFilterSpec } from '@/lib/agents/icp-filter-spec'
import { collectTargetingGeographyStatements } from '@/agents/icp-geography-agent'
import { aGeography } from '@/test-utils/geography-fixture'
import { seniorityFixture } from '@/test-utils/seniority-fixture'

// ── A document with every part a real ICP has, in placeholder words ───────────

function tier(name: string, industryAt: number, headcount: string) {
  return {
    label: `placeholder label ${name}`,
    description: `placeholder description ${name}`,
    company_profile: {
      industries: [CANONICAL_INDUSTRIES[industryAt], CANONICAL_INDUSTRIES[industryAt + 30]],
      headcount,
      revenue_range: `placeholder revenue phrase ${name}`,
      geography: `placeholder geography phrase ${name}`,
      stage: `placeholder stage ${name}`,
      business_model: `placeholder business model ${name}`,
      unmatched_industries: [`placeholder unmatched ${name}`],
    },
    buyer_profile: {
      title: `placeholder buyer title ${name}`,
      seniority: `placeholder buyer level ${name}`,
      day_to_day: `placeholder day ${name}`,
      identity: `placeholder identity ${name}`,
    },
    disqualifiers: [`placeholder rule a ${name}`, `placeholder rule b ${name}`],
    triggers: Array.from({ length: 7 }, (_, n) => ({
      event: `placeholder event ${name} ${n}`,
      reason: `placeholder reason ${name} ${n}`,
    })),
    four_forces: {
      push: `placeholder push ${name}`,
      pull: `placeholder pull ${name}`,
      anxiety: `placeholder anxiety ${name}`,
      habit: `placeholder habit ${name}`,
    },
    switching_costs: `placeholder switching cost ${name}`,
  }
}

function fullDocument() {
  return {
    summary: 'A placeholder summary of who this client sells to.',
    jtbd_statement: 'A placeholder statement of the job the buyer wants done.',
    unresolved_fields: ['placeholder unresolved field'],
    client_pricing: { note: 'placeholder pricing note' },
    tier_1: tier('one', 0, '10 to 40 people'),
    tier_2: tier('two', 1, '41 to 90 people'),
    tier_3: {
      label: 'placeholder label three',
      company_profile: {
        industries: [CANONICAL_INDUSTRIES[2]],
        headcount: '1 person',
        revenue_range: 'placeholder revenue phrase three',
        geography: 'placeholder geography phrase three',
        stage: 'placeholder stage three',
        business_model: 'placeholder business model three',
      },
      disqualifiers: ['placeholder rule three'],
    },
  }
}

// THE PINNED LIST. Paths are relative to the document. Changing this is changing what
// counts as a targeting edit, which is an ADR-061 decision and not a refactor.
const TARGETING_LEAVES = ['tier_1', 'tier_2'].flatMap(t => [
  `${t}.company_profile.industries`,
  `${t}.company_profile.headcount`,
  `${t}.company_profile.revenue_range`,
  `${t}.company_profile.geography`,
  `${t}.buyer_profile.title`,
  `${t}.buyer_profile.seniority`,
  `${t}.disqualifiers`,
])

const isTargetingLeaf = (path: string) =>
  TARGETING_LEAVES.some(leaf => path === leaf || path.startsWith(`${leaf}[`))

/** Every leaf of a value, with a setter that plants an edit on exactly that leaf. */
function everyLeaf(root: unknown): { path: string; plant: () => void }[] {
  const out: { path: string; plant: () => void }[] = []
  const walk = (value: unknown, path: string, set: (next: unknown) => void) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, next => { value[i] = next }))
    } else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        walk(record[key], path ? `${path}.${key}` : key, next => { record[key] = next })
      }
    } else {
      out.push({
        path,
        plant: () => set(typeof value === 'number' ? value + 1 : `${String(value)} (edited)`),
      })
    }
  }
  walk(root, '', () => undefined)
  return out
}

const OUTSIDE = { statedHeadcount: { min: 12, max: 60 }, revenueFilterEnabled: false }

describe('targetingInputs: the projection is exactly the targeting fields', () => {
  it('copies the pinned fields verbatim and nothing else', () => {
    const doc = fullDocument()
    expect(targetingInputs(doc, OUTSIDE)).toEqual({
      document: {
        tier_1: {
          company_profile: {
            industries: doc.tier_1.company_profile.industries,
            headcount: '10 to 40 people',
            revenue_range: 'placeholder revenue phrase one',
            geography: 'placeholder geography phrase one',
          },
          buyer_profile: {
            title: 'placeholder buyer title one',
            seniority: 'placeholder buyer level one',
          },
          disqualifiers: ['placeholder rule a one', 'placeholder rule b one'],
        },
        tier_2: {
          company_profile: {
            industries: doc.tier_2.company_profile.industries,
            headcount: '41 to 90 people',
            revenue_range: 'placeholder revenue phrase two',
            geography: 'placeholder geography phrase two',
          },
          buyer_profile: {
            title: 'placeholder buyer title two',
            seniority: 'placeholder buyer level two',
          },
          disqualifiers: ['placeholder rule a two', 'placeholder rule b two'],
        },
      },
      stated_headcount: { min: 12, max: 60 },
      revenue_filter_enabled: false,
    })
  })

  it('is total: a document of any shape still projects, with empty tiers', () => {
    for (const odd of [null, undefined, 'a string', 42, [], {}, { tier_1: 'not a tier' }]) {
      const inputs = targetingInputs(odd)
      expect(inputs.document.tier_1.company_profile.industries).toEqual([])
      expect(inputs.document.tier_2.disqualifiers).toEqual([])
      expect(inputs.stated_headcount).toBeNull()
      expect(inputs.revenue_filter_enabled).toBe(false)
    }
  })

  it('stores a headcount pair only when the derivation would use it', () => {
    // The same rule decides both, so they cannot disagree. Each of these is a pair the
    // derivation ignores, and storing one would make an ignored answer look like a change.
    for (const pair of [{ min: 0, max: 5 }, { min: 9, max: 3 }, { min: 1.5, max: 4 }]) {
      expect(usableHeadcountPair(pair)).toBeNull()
      expect(targetingInputs(fullDocument(), { statedHeadcount: pair }).stated_headcount).toBeNull()
    }
    expect(usableHeadcountPair({ min: 3, max: 3 })).toEqual({ min: 3, max: 3 })
  })
})

describe('compareTargetingInputs: a prose edit is never a targeting change', () => {
  it('PLANTED: an edit to every leaf of a full document, one at a time', () => {
    const before = targetingInputs(fullDocument(), OUTSIDE)
    const leaves = everyLeaf(fullDocument())
    let changed = 0
    let unchanged = 0

    for (const { path } of leaves) {
      const doc = fullDocument()
      const target = everyLeaf(doc).find(leaf => leaf.path === path)
      if (!target) throw new Error(`leaf vanished between two builds of the fixture: ${path}`)
      target.plant()
      const change = compareTargetingInputs(before, targetingInputs(doc, OUTSIDE))
      expect(change.changed, `an edit to ${path}`).toBe(isTargetingLeaf(path))
      if (change.changed) changed++
      else unchanged++
    }

    // SELF-GUARDING. Every assertion above passes vacuously over an empty walk, and a walk
    // that found only one kind of leaf has not tested the boundary between them.
    expect(leaves.length).toBeGreaterThan(80)
    expect(changed).toBe(18) // 9 targeting leaves a tier: two industries, two rules, five strings
    expect(unchanged).toBe(leaves.length - 18)
  })

  it('the 2026-09-30 shape: two trigger reasons change and nothing else does', () => {
    const before = fullDocument()
    const after = fullDocument()
    after.tier_1.triggers[5].reason = 'a rewritten reason for the sixth trigger'
    after.tier_1.triggers[6].reason = 'a rewritten reason for the seventh trigger'

    const change = compareTargetingInputs(
      targetingInputs(before, OUTSIDE),
      targetingInputs(after, OUTSIDE),
    )
    expect(change).toEqual({
      changed: false, paths: [], geography: false, buyer: false, document: false,
      outside: false, unknown_before: false,
    })

    // POSITIVE CONTROL. The same comparison on the same documents must be able to say yes,
    // or the "no" above is an instrument that cannot detect anything.
    after.tier_1.company_profile.headcount = '10 to 45 people'
    const control = compareTargetingInputs(
      targetingInputs(before, OUTSIDE),
      targetingInputs(after, OUTSIDE),
    )
    expect(control.changed).toBe(true)
    expect(control.paths).toEqual(['document.tier_1.company_profile.headcount'])
  })

  it('says which parts each kind of edit obliges the caller to rebuild', () => {
    const before = targetingInputs(fullDocument(), OUTSIDE)
    const edit = (
      mutate: (doc: ReturnType<typeof fullDocument>) => void,
      outside = OUTSIDE,
    ) => {
      const doc = fullDocument()
      mutate(doc)
      const { geography, buyer, document, outside: outsideChanged } =
        compareTargetingInputs(before, targetingInputs(doc, outside))
      return { geography, buyer, document, outside: outsideChanged }
    }

    expect(edit(d => { d.tier_2.company_profile.geography += ' and more' }))
      .toEqual({ geography: true, buyer: false, document: true, outside: false })
    expect(edit(d => { d.tier_1.buyer_profile.title += ' or similar' }))
      .toEqual({ geography: false, buyer: true, document: true, outside: false })
    expect(edit(d => { d.tier_1.buyer_profile.seniority += ' or similar' }))
      .toEqual({ geography: false, buyer: true, document: true, outside: false })
    expect(edit(d => { d.tier_2.disqualifiers.push('a new placeholder rule') }))
      .toEqual({ geography: false, buyer: true, document: true, outside: false })
    expect(edit(d => { d.tier_1.disqualifiers.pop() }))
      .toEqual({ geography: false, buyer: true, document: true, outside: false })
    expect(edit(d => { d.tier_1.company_profile.industries.push(CANONICAL_INDUSTRIES[9]) }))
      .toEqual({ geography: false, buyer: false, document: true, outside: false })
    expect(edit(d => { d.tier_1.company_profile.headcount = '10 to 45 people' }))
      .toEqual({ geography: false, buyer: false, document: true, outside: false })
    expect(edit(d => { d.tier_2.company_profile.revenue_range += ' or so' }))
      .toEqual({ geography: false, buyer: false, document: true, outside: false })

    // The two inputs that live outside the document.
    expect(edit(() => undefined, { ...OUTSIDE, statedHeadcount: { min: 12, max: 61 } }))
      .toEqual({ geography: false, buyer: false, document: false, outside: true })
    expect(edit(() => undefined, { ...OUTSIDE, revenueFilterEnabled: true }))
      .toEqual({ geography: false, buyer: false, document: false, outside: true })
    expect(edit(() => undefined, { revenueFilterEnabled: false, statedHeadcount: null as never }))
      .toEqual({ geography: false, buyer: false, document: false, outside: true })
  })

  it('counts a whitespace-only edit and a reordered list as changes, deliberately', () => {
    // Verbatim comparison errs toward a proposal nobody needed. Normalising would err
    // toward swallowing an edit somebody meant, and that direction is silent.
    const before = targetingInputs(fullDocument(), OUTSIDE)
    const spaced = fullDocument()
    spaced.tier_1.company_profile.geography += ' '
    expect(compareTargetingInputs(before, targetingInputs(spaced, OUTSIDE)).changed).toBe(true)

    const reordered = fullDocument()
    reordered.tier_1.disqualifiers.reverse()
    expect(compareTargetingInputs(before, targetingInputs(reordered, OUTSIDE)).changed).toBe(true)
  })
})

describe('a stored snapshot: "cannot tell" must never read as unchanged', () => {
  it('survives the round trip through a jsonb column', () => {
    const inputs = targetingInputs(fullDocument(), OUTSIDE)
    const stored = readStoredTargetingInputs(JSON.parse(JSON.stringify(inputs)))
    expect(stored).toEqual(inputs)
    expect(compareTargetingInputs(stored, inputs).changed).toBe(false)

    // And with no headcount answer, which is the commonest stored shape.
    const bare = targetingInputs(fullDocument(), {})
    expect(readStoredTargetingInputs(JSON.parse(JSON.stringify(bare)))).toEqual(bare)
  })

  it('returns null for anything that is not a snapshot', () => {
    const good = JSON.parse(JSON.stringify(targetingInputs(fullDocument(), OUTSIDE)))
    const broken: unknown[] = [
      undefined,
      null,
      'a string',
      [],
      {},
      { ...good, document: null },
      { ...good, document: { tier_1: good.document.tier_1 } },
      { ...good, revenue_filter_enabled: 'false' },
      { ...good, stated_headcount: { min: 9, max: 3 } },
      { ...good, stated_headcount: 'a pair' },
      (() => { const { stated_headcount: _dropped, ...rest } = good; return rest })(),
    ]
    for (const value of broken) {
      expect(readStoredTargetingInputs(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('reports an absent snapshot as changed, with every rebuild flag set', () => {
    const now = targetingInputs(fullDocument(), OUTSIDE)
    for (const before of [null, undefined]) {
      expect(compareTargetingInputs(before, now)).toEqual({
        changed: true, paths: [], geography: true, buyer: true, document: true,
        outside: true, unknown_before: true,
      })
    }
  })
})

// ── The derivation reads the targeting fields and nothing else ───────────────

/** Wrap a value so that every property path read from it is recorded. */
function recording<T extends object>(target: T, path: string, seen: Set<string>): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver)
      if (typeof key === 'symbol') return value
      // An array is one leaf: reading its length or an element is reading the list.
      const here = Array.isArray(obj) ? path : path ? `${path}.${key}` : key
      if (!Array.isArray(obj)) seen.add(here)
      return typeof value === 'object' && value !== null ? recording(value, here, seen) : value
    },
  })
}

const withinTargeting = (path: string) =>
  TARGETING_LEAVES.some(leaf => leaf === path || leaf.startsWith(`${path}.`))

describe('RECORDED: what the derivation actually reads', () => {
  it('deriveFilterSpec and the geography reader touch only targeting fields', () => {
    const seen = new Set<string>()
    const doc = recording(fullDocument(), '', seen) as unknown as TargetingDocument

    deriveFilterSpec(doc, null, aGeography(), seniorityFixture())
    collectTargetingGeographyStatements(doc)

    const outside = [...seen].filter(path => !withinTargeting(path))
    expect(outside).toEqual([])
    // Guards the assertion above against an instrument that recorded nothing.
    expect(seen.has('tier_1.company_profile.headcount')).toBe(true)
    expect(seen.has('tier_2.company_profile.geography')).toBe(true)
    expect(seen.has('tier_1.disqualifiers')).toBe(true)
  })

  it('POSITIVE CONTROL: the recorder does catch a read outside the targeting fields', () => {
    const seen = new Set<string>()
    const doc = recording(fullDocument(), '', seen)
    void doc.summary
    void doc.tier_1.triggers[0].reason
    void doc.tier_1.company_profile.stage
    expect([...seen].filter(path => !withinTargeting(path)).sort()).toEqual([
      'summary',
      'tier_1.company_profile.stage',
      'tier_1.triggers',
      'tier_1.triggers.reason',
    ])
  })

  it('derives the same settings from the projection as from the whole document', () => {
    const doc = fullDocument()
    const fromDocument = deriveFilterSpec(doc, null, aGeography(), seniorityFixture(), {
      statedHeadcount: OUTSIDE.statedHeadcount,
    })
    const fromProjection = deriveFilterSpec(
      targetingInputs(doc, OUTSIDE).document, null, aGeography(), seniorityFixture(),
      { statedHeadcount: OUTSIDE.statedHeadcount },
    )
    expect(fromProjection).toEqual(fromDocument)
    expect(collectTargetingGeographyStatements(targetingInputs(doc, OUTSIDE).document))
      .toEqual(collectTargetingGeographyStatements(doc))
  })
})
