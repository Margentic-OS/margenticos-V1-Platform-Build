// Fails the build when the shipped server output does not contain the patched retry.
//
// WHY THIS EXISTS, and why check-postgrest-patch.ts was not enough.
//
// On 2026-09-11 the 504 read retry merged, deployed, and did not run in production. The
// install-time check passed on that very deploy: patch-package applied the patch and
// scripts/check-postgrest-patch.ts read the patched files in node_modules and reported ok.
// What shipped did not contain them. Vercel restored the build cache from the previous
// deployment, and webpack's filesystem cache treats node_modules as managed paths that it
// validates by PACKAGE VERSION rather than by file contents. patch-package rewrites files
// inside a package whose version never changes, so the cache handed back the pre-patch
// compiled module.
//
// THE LESSON: an install-time check proves the file on disk, not the artifact that ships.
// This one reads the build output.
//
// Runs as `postbuild`, so a deploy whose bundle lost the patch fails instead of going live
// and quietly not retrying.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_DIR = join(process.cwd(), '.next', 'server')

// Any one of these is the patch: the comment survives an unminified build, the jitter
// expression survives a minified one in either argument order.
const PATCH_SIGNATURES = [
  'retry-504-on-reads',
  '250 + Math.floor',
  'Math.floor(500*Math.random())',
  'Math.floor(Math.random()*500)',
]

// The library itself. Without this, "no signature" could mean "the library is not in the
// output at all", and the check above would be passing over nothing.
const LIBRARY_MARKER = 'X-Retry-Count'

function jsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...jsFiles(path))
    else if (entry.endsWith('.js')) out.push(path)
  }
  return out
}

let files: string[]
try {
  files = jsFiles(SERVER_DIR)
} catch {
  console.error(`check-patch-in-build: FAILED — no build output at ${SERVER_DIR}`)
  process.exit(1)
}

let withLibrary = 0
let withPatch = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  if (source.includes(LIBRARY_MARKER)) withLibrary++
  if (PATCH_SIGNATURES.some(signature => source.includes(signature))) withPatch++
}

if (withLibrary === 0) {
  console.error(
    'check-patch-in-build: FAILED — the database client library is not in the server output ' +
    `(${files.length} files scanned). Either the bundling changed, or this check is now ` +
    'looking in the wrong place. Do not weaken it: a signature check over output that does ' +
    'not contain the library would pass forever.',
  )
  process.exit(1)
}

if (withPatch === 0) {
  console.error(
    'check-patch-in-build: FAILED — the library is in the server output but the 504 retry ' +
    `patch is not (${withLibrary} file(s) carry the library, ${files.length} scanned).\n` +
    '  Most likely a stale webpack cache: it validates node_modules by package version, and ' +
    'patch-package does not change the version.\n' +
    '  Fix: delete .next/cache (locally), or on Vercel redeploy without the build cache. The ' +
    'cache version in next.config.ts is keyed to patches/ to prevent this.',
  )
  process.exit(1)
}

console.log(
  `check-patch-in-build: ok (${withPatch} of ${files.length} server files carry the 504 retry patch, ` +
  `${withLibrary} carry the library)`,
)
