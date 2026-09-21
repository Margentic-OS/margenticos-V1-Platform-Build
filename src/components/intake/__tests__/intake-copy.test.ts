// WHAT THIS GUARDS, AND WHAT IT CANNOT.
//
// The sibling IntakeForm.test.tsx asserts against COPIES of the intake strings pasted into
// the test. That passes whatever the components actually render, which is the shape
// CLAUDE.md calls a fake that cannot test the thing it names. These tests read the REAL
// source files instead.
//
// THE LIMIT, STATED SO THE NEXT READER DOES NOT OVER-TRUST IT: this reads source text, not
// a rendered tree. It proves the literal in the file, not what a browser shows. A default
// moved into a prop, or copy relocated to another module, would pass here while changing
// the screen. The control test below is what stops the whole file passing vacuously.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const INTAKE_COPY_FILES = [
  'src/components/intake/IntakeForm.tsx',
  'src/components/intake/FileUploadSection.tsx',
  'src/components/intake/BuyerProfileSection.tsx',
  'src/lib/intake/questions.ts',
  'src/lib/intake/buyer-profile.ts',
] as const

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

/**
 * Strips comments so a note to a developer is not judged as client-facing copy.
 * Block comments first (this also removes the JSX `{ / * ... * / }` form), then
 * line comments, skipping `://` so a URL inside a string survives.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

describe('intake copy, read from the real files', () => {
  // THE CONTROL. Every other test here is an assertion of ABSENCE, and an absence proves
  // nothing if the read silently returned nothing. This establishes the instrument can see
  // a positive before the negatives below are believed.
  it('actually reads the intake source files', () => {
    for (const file of INTAKE_COPY_FILES) {
      const source = read(file)
      expect(source.length, `${file} read back empty`).toBeGreaterThan(200)
    }
    // A string every one of these files genuinely contains.
    expect(read('src/lib/intake/buyer-profile.ts')).toContain('disqualifiers')
    expect(read('src/components/intake/IntakeForm.tsx')).toContain('voiceTab')
  })

  it('the voice step opens on typing, not on the file picker', () => {
    const source = read('src/components/intake/IntakeForm.tsx')
    // The paragraph above the tabs asks the client to paste writing they already have.
    // Opening on 'upload' asks for a larger action than the copy requests.
    expect(source).toMatch(/useState<'upload' \| 'type'>\('type'\)/)
    expect(source).not.toMatch(/useState<'upload' \| 'type'>\('upload'\)/)
  })

  it('no em dash, en dash or double hyphen in client-facing intake copy', () => {
    for (const file of INTAKE_COPY_FILES) {
      const copy = withoutComments(read(file))
      expect(copy, `em dash in ${file}`).not.toContain('—')
      expect(copy, `en dash in ${file}`).not.toContain('–')
    }
  })

  it('the disqualifier help text promises only what the system does', () => {
    const source = read('src/lib/intake/buyer-profile.ts')
    // It may say what shapes targeting and what gets filtered. It may NOT promise that
    // every answer becomes a rule applied before contact: the most honest answers, about
    // spend or scope, are not knowable until someone replies.
    expect(source).not.toContain('before a name ever reaches you')
    expect(source).toContain('we cannot confirm until someone replies')
  })
})
