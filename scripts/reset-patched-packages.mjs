// Removes every package that patches/ targets, so npm re-extracts it and the
// patch-package run in postinstall always meets a PRISTINE package.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// patch-package applies a diff to files in node_modules. It can apply a patch to a
// pristine package, and it can recognise its OWN patch already applied and skip.
// What it cannot do is apply a patch to a package carrying a DIFFERENT patch: the
// context lines match neither forwards nor in reverse, so it fails the install with
// "Failed to apply patch ... Try removing node_modules and trying again."
//
// That is not a hypothetical. Vercel restores node_modules from the previous
// deployment's cache, and the cache key does not include patches/. So any branch
// that CHANGES a patch gets a node_modules already patched with the old one, and
// the install dies. Reproduced exactly on 2026-09-14 on this branch: install the
// old patch, swap in the new one, run patch-package, and it fails with that
// message. The patch file itself is sound; only the order of events is wrong.
//
// Deleting the package before npm resolves the tree fixes it at the root, because
// npm reinstalls anything missing from node_modules. Verified on 2026-09-14: with
// the package removed, `npm install` restored it with neither patch's markers
// present, which is the pristine file.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY IT IS NOT A MARKER FILE
//
// The obvious alternative is to record which patch was applied, and reverse it
// before applying the new one. It does not work for the build that matters: the
// FIRST deploy carrying such a scheme meets a cache written before it existed, so
// there is no marker to read and nothing to reverse. A fix that cannot repair the
// state it inherits is not a fix. Removing the package needs to know nothing about
// what was done to it.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT AN npm LIFECYCLE SCRIPT. MEASURED, NOT ASSUMED.
//
// The obvious home for this is `preinstall`, and it DOES NOT WORK. npm loads the
// installed tree from disk when it starts, which is before it runs the root
// package's preinstall script, so a package deleted during preinstall is still
// present in the tree npm has already decided to reify. npm therefore reinstalls
// nothing, and postinstall's patch-package fails a different way:
//
//   [reset-patched-packages] @supabase/postgrest-js: removed, ...
//   Error: Patch file found for package postgrest-js which is not present at
//     node_modules/@supabase/postgrest-js
//
// Measured on 2026-09-14. The same deletion performed BEFORE npm starts does work:
// npm finds the package missing on disk and reinstalls it pristine. So this runs as
// the install command, ahead of npm, and never as a hook npm owns.
//
// That is also why it may not import anything: on a cold build it runs before
// node_modules exists. Node built-ins only, no tsx, no TypeScript, no dependency.
//
// The package list is DERIVED from the filenames in patches/ rather than written
// out here. Two lists that have to agree by hand is the drift shape CLAUDE.md
// warns about: add a patch, forget the list, and the next patch change breaks an
// install again with nothing to say why.

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const patchesDir = join(projectRoot, 'patches')
const nodeModulesDir = join(projectRoot, 'node_modules')

/**
 * Recovers the package name from a patch-package filename.
 *
 * patch-package encodes a package as `name+version.patch`, a scope as a leading
 * `@scope+`, and allows optional trailing `+NNN+description` sequence parts. So the
 * name is the first segment, or the first two when the first begins with `@`.
 */
function packageNameFromPatchFile(fileName) {
  const segments = fileName.replace(/\.patch$/, '').split('+')
  if (segments.length < 2) return null
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]
}

if (!existsSync(patchesDir)) {
  console.log('[reset-patched-packages] no patches/ directory, nothing to do')
  process.exit(0)
}

const patchFiles = readdirSync(patchesDir).filter((name) => name.endsWith('.patch'))

if (patchFiles.length === 0) {
  console.log('[reset-patched-packages] patches/ holds no .patch files, nothing to do')
  process.exit(0)
}

let removed = 0

for (const patchFile of patchFiles) {
  const packageName = packageNameFromPatchFile(patchFile)

  if (!packageName) {
    throw new Error(
      `[reset-patched-packages] could not read a package name out of patches/${patchFile}. ` +
        `Expected patch-package's "name+version.patch" or "@scope+name+version.patch".`,
    )
  }

  const packageDir = join(nodeModulesDir, packageName)

  // Never step outside node_modules, whatever a filename says.
  if (!resolve(packageDir).startsWith(nodeModulesDir + '/')) {
    throw new Error(
      `[reset-patched-packages] patches/${patchFile} resolves to ${packageDir}, which is ` +
        `outside node_modules. Refusing to remove it.`,
    )
  }

  if (!existsSync(packageDir)) {
    console.log(`[reset-patched-packages] ${packageName}: not installed yet, nothing to remove`)
    continue
  }

  rmSync(packageDir, { recursive: true, force: true })
  removed += 1
  console.log(`[reset-patched-packages] ${packageName}: removed, npm will reinstall it pristine`)
}

console.log(
  `[reset-patched-packages] ${patchFiles.length} patch file(s), ${removed} package(s) removed`,
)
