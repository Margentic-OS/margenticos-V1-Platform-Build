import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// client_prospects_view is the client's READ surface for their own prospects. On 2026-08-27
// the write grants on it were revoked from authenticated, under ADR-039: a read-only view
// gets SELECT and nothing else.
//
// TWO SESSIONS DISAGREED ABOUT THAT VIEW ON THE SAME DAY, one holding that the write grants
// were intentional because of the clients_update_own_prospect_review policy on the prospects
// TABLE. The revoke was verified before shipping, five ways: every client approve and reject
// path writes to the prospects table; the view name appears in exactly one .from() call in
// the repo and it is a SELECT in a test; the compiled browser bundle contains no write to
// any relation; the live catalog has no rules, no INSTEAD OF triggers and no function or
// cron command naming the view; and as a real authenticated client, in a rolled-back
// transaction with the old grant restored, an UPDATE through the view wrote ZERO rows,
// because security_invoker means the caller's RLS applies and the client cannot see the row.
//
// THIS TEST GUARDS THE THING THAT IS STILL EASY TO GET WRONG. Supabase generates Insert and
// Update types for an auto-updatable view, so `.from('client_prospects_view').update(...)`
// TYPE-CHECKS CLEANLY and would fail only at runtime, in production, as a permission error.
// No type, no lint rule and no other test would catch it. This one does.

const VIEW = 'client_prospects_view'
const WRITE_OPS = ['update', 'insert', 'upsert', 'delete']

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full)
  }
  return acc
}

const files = sourceFiles(join(process.cwd(), 'src'))

describe('no code writes through client_prospects_view', () => {
  // THE GUARD ON THE GUARD. A scan that finds no files, or a repo where the view is never
  // mentioned at all, would pass this suite while proving nothing. Both are asserted first.
  it('is actually scanning something', () => {
    expect(files.length).toBeGreaterThan(200)
    const mentions = files.filter(f => readFileSync(f, 'utf8').includes(VIEW))
    expect(mentions.length).toBeGreaterThan(0)
  })

  it('never chains a write onto a .from(client_prospects_view)', () => {
    const offenders: string[] = []

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(VIEW)) continue

      // COMMENTS ARE NOT CODE. The first version of this scan failed on ITS OWN header,
      // which explains the hazard by quoting `.from('client_prospects_view').update(...)`.
      // Blanking comment lines while KEEPING their positions means line numbers in the
      // offender list still point at the real file. Same fix, and the same mistake, as the
      // baseline restore checker made this morning with supabase_functions.
      const lines = text.split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
      lines.forEach((line, i) => {
        if (!new RegExp(`\\.from\\(\\s*['"\`]${VIEW}['"\`]`).test(line)) return
        // A supabase chain can span lines, so look at this line and the few after it, which
        // is how the chained .update( / .insert( would be written in this codebase.
        const window = lines.slice(i, i + 8).join('\n')
        for (const op of WRITE_OPS) {
          if (new RegExp(`\\.${op}\\s*\\(`).test(window)) {
            offenders.push(`${file.replace(process.cwd() + '/', '')}:${i + 1} chains .${op}()`)
          }
        }
      })
    }

    expect(
      offenders,
      'A write through client_prospects_view type-checks but is denied at runtime: ' +
      'authenticated holds SELECT on that view and nothing else. Write to the prospects ' +
      'table instead, which is what every existing client approve and reject path does.',
    ).toEqual([])
  })
})
