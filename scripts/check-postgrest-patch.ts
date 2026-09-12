// Fails the build when the local postgrest-js patch is not in place.
//
// patches/@supabase+postgrest-js+2.103.2.patch adds one retry on a 504 for reads. It is
// applied by `patch-package` in postinstall. Two ways it could be silently missing:
//
//   the install ran with scripts disabled   postinstall never ran, nothing says so
//   the library version changed             patch-package refuses loudly, but only if
//                                           postinstall runs at all
//
// A retry that is silently absent reads exactly like a retry that is present and never
// needed, so this checks the installed files directly, in both builds the package ships.
// Wired into `prebuild`, so a deploy without the patch fails instead of shipping.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_DIR = join(process.cwd(), 'node_modules', '@supabase', 'postgrest-js')
const EXPECTED_VERSION = '2.103.2'
const MARKER = 'LOCAL PATCH: retry-504-on-reads'
const POLICY = 'const GATEWAY_TIMEOUT_MAX_RETRIES = 1;'
const BUILDS = ['dist/index.cjs', 'dist/index.mjs']

const problems: string[] = []

const version = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version
if (version !== EXPECTED_VERSION) {
  problems.push(
    `installed @supabase/postgrest-js is ${version}, the patch is written for ${EXPECTED_VERSION}. ` +
    'Read the retry code in the new version before regenerating the patch (see CLAUDE.md).',
  )
}

for (const build of BUILDS) {
  const source = readFileSync(join(PACKAGE_DIR, build), 'utf8')
  if (!source.includes(MARKER) || !source.includes(POLICY)) {
    problems.push(`${build} does not carry the 504 retry patch. Run \`npx patch-package\`.`)
  }
}

if (problems.length > 0) {
  console.error('check-postgrest-patch: FAILED')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`check-postgrest-patch: ok (postgrest-js ${version}, patch present in ${BUILDS.length} builds)`)
