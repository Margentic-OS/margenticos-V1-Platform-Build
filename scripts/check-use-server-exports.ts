#!/usr/bin/env npx tsx
/**
 * Scans every "use server" file and fails if any export is not an async function
 * or a TypeScript type/interface (which are erased at runtime and are safe).
 *
 * Next.js throws at module load time — not at build — when a "use server" file
 * exports a non-async-function value (object, constant, class, etc.).
 * This script catches violations before they reach production.
 *
 * Usage:
 *   npx tsx scripts/check-use-server-exports.ts
 *
 * Add to CI: run after `tsc --noEmit`, fail build on non-zero exit.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

// TypeScript-only export keywords — erased at runtime, safe in "use server" files.
const SAFE_PATTERNS = [
  /^export\s+type\s+/,
  /^export\s+interface\s+/,
  /^export\s+declare\s+/,
]

// Runtime exports that are always safe.
const SAFE_RUNTIME_PATTERNS = [
  /^export\s+async\s+function\s+/,
]

function walk(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const e of entries) {
    if (e === 'node_modules' || e === '.next' || e.startsWith('.')) continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full)
  }
  return files
}

let violations = 0

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf-8')
  const lines = src.split('\n')

  // Only process files with the "use server" directive at the top.
  const first = lines.slice(0, 3).join('\n')
  if (!first.includes("'use server'") && !first.includes('"use server"')) continue

  const relPath = relative(ROOT, file)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('export')) continue
    // Skip blank or comment lines that happen to start 'export' after trimming (shouldn't happen, but guard)
    if (!line.match(/^export\b/)) continue

    // Safe: type-only export (erased at runtime)
    if (SAFE_PATTERNS.some(p => p.test(line))) continue
    // Safe: async function
    if (SAFE_RUNTIME_PATTERNS.some(p => p.test(line))) continue
    // Might be a multi-line function declaration
    if (line.match(/^export\s+async\s+/)) continue

    // Violations: export { ... }, export const, export class, export function (non-async), export default
    console.error(`❌  ${relPath}:${i + 1}  non-async-function export: ${line.slice(0, 80)}`)
    violations++
  }
}

if (violations === 0) {
  console.log('✓  All "use server" files export only async functions (or type-only exports).')
  process.exit(0)
} else {
  console.error(`\n${violations} violation(s) found. "use server" files may only export async functions.`)
  console.error('See https://nextjs.org/docs/messages/invalid-use-server-value')
  process.exit(1)
}
