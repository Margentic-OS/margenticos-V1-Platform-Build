// Regenerates scripts/__before__research-queries.ts by EXTRACTING the shipped builder
// from origin/main, rather than by anyone retyping it.
//
//   npx tsx scripts/regen-before-research-queries.ts
//
// The "before" column of the proof table is only evidence if it is the code that actually
// shipped. Retyping it makes the table a claim about what someone remembered.
//
// It slices the research-query section out of the origin/main file between its two banner
// comments, renames the entry point, and prepends the IntakeRow shape the block needs.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REF = 'origin/main'
const SRC = 'src/agents/icp-generation-agent.ts'
const START = '// ─── Research query builder ─'
const END = '// ─── Prompt construction ─'

const shipped = execFileSync('git', ['show', `${REF}:${SRC}`], { encoding: 'utf8' })
const sha = execFileSync('git', ['rev-parse', '--short', REF], { encoding: 'utf8' }).trim()

const lines = shipped.split('\n')
const startIdx = lines.findIndex(l => l.startsWith(START))
const endIdx = lines.findIndex(l => l.startsWith(END))
if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  throw new Error(`Could not locate the research-query block in ${REF}:${SRC}`)
}

const block = lines.slice(startIdx + 1, endIdx).join('\n').trim()

// The block must actually contain the entry point, or the slice silently captured
// the wrong region and the proof table would compare nothing against something.
if (!block.includes('export function buildResearchQueries')) {
  throw new Error('Extracted block does not contain buildResearchQueries — refusing to write')
}

const renamed = block
  .replace(/export function buildResearchQueries\b/, 'export function buildResearchQueriesBefore')
  // Only the entry point is exported; the helpers would collide with the live module's
  // names if anything ever imported both from one file.
  .replace(/^export (function|const) (?!buildResearchQueriesBefore)/gm, '$1 ')

const header = `// AUTO-EXTRACTED from ${REF} (${sha}) by scripts/regen-before-research-queries.ts.
// DO NOT EDIT. Regenerate with:
//   npx tsx scripts/regen-before-research-queries.ts
//
// This is the builder as it SHIPPED, sliced out of the origin/main file rather than
// retyped, so the "before" column of the proof table is evidence and not a recollection.

export interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

`

writeFileSync(join(process.cwd(), 'scripts/__before__research-queries.ts'), header + renamed + '\n')
console.log(`Wrote scripts/__before__research-queries.ts from ${REF} (${sha}), ${renamed.split('\n').length} lines`)
