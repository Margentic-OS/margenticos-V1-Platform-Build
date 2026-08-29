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

const START = '// ─── Research query builder ─'
const END = '// ─── Prompt construction ─'

// Both document agents build their own research queries and both get proved the same way.
//
// EACH TARGET PINS ITS OWN REF, and that is the whole reason this is a table rather than a
// constant. "Before" means the commit before THAT agent's fix, not whatever main happens to
// be today. Pointing both at origin/main would silently make the ICP before-column equal to
// its after-column the moment the ICP fix merged, and the proof table would show a change
// that changed nothing while looking exactly as green as a real one.
const TARGETS = [
  {
    // ef20336 is the merge immediately before the ICP research-query fix (ADR-044).
    ref: 'ef20336',
    src: 'src/agents/icp-generation-agent.ts',
    out: 'scripts/__before__research-queries.ts',
    from: 'buildResearchQueries',
    to: 'buildResearchQueriesBefore',
  },
  {
    // c7d42c1 is main immediately before the positioning port. The positioning builder is
    // untouched from the start of the project up to that commit.
    ref: 'c7d42c1',
    src: 'src/agents/positioning-generation-agent.ts',
    out: 'scripts/__before__positioning-research-queries.ts',
    from: 'buildResearchQueries',
    to: 'buildPositioningQueriesBefore',
  },
] as const

for (const target of TARGETS) {
  const sha = execFileSync('git', ['rev-parse', '--short', target.ref], { encoding: 'utf8' }).trim()
  const shipped = execFileSync('git', ['show', `${target.ref}:${target.src}`], { encoding: 'utf8' })

  const lines = shipped.split('\n')
  const startIdx = lines.findIndex(l => l.startsWith(START))
  const endIdx = lines.findIndex(l => l.startsWith(END))
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`Could not locate the research-query block in ${target.ref}:${target.src}`)
  }

  const block = lines.slice(startIdx + 1, endIdx).join('\n').trim()

  // The block must actually contain the entry point, or the slice silently captured the
  // wrong region and the proof table would compare nothing against something.
  if (!block.includes(`export function ${target.from}`)) {
    throw new Error(
      `Extracted block from ${target.src} does not contain ${target.from} — refusing to write`)
  }

  const renamed = block
    .replace(new RegExp(`export function ${target.from}\\b`), `export function ${target.to}`)
    // Only the entry point is exported; the helpers would collide with the live module's
    // names if anything ever imported both from one file.
    .replace(new RegExp(`^export (function|const|type|interface) (?!${target.to})`, 'gm'), '$1 ')

  const header = `// AUTO-EXTRACTED from ${target.ref} (${sha}) by scripts/regen-before-research-queries.ts.
// DO NOT EDIT. Regenerate with:
//   npx tsx scripts/regen-before-research-queries.ts
//
// This is ${target.src} as it SHIPPED at ${target.ref}, the commit immediately before the
// fix this proves. Sliced out of that commit rather than retyped, so the "before" column
// of the proof table is evidence and not a recollection.

export interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

`

  writeFileSync(join(process.cwd(), target.out), header + renamed + '\n')
  console.log(`Wrote ${target.out} from ${target.ref} (${sha}), ${renamed.split('\n').length} lines`)
}
