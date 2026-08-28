import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkRestoreInvariants } from '../restore-baseline-test'

// The committed baseline must satisfy the four properties that the 2026-08-27 restore test
// established, and it must keep satisfying them after every regeneration. This is the half
// of that test which needs no database, so it is the half that actually keeps running.
//
// It CANNOT prove the file restores. Only scripts/restore-baseline-test.ts against a real
// project does that. It CAN prove a regeneration has not undone one of the fixes, which is
// the failure mode this project keeps having: a fix that lives only in a comment.

const baseline = readFileSync(join(process.cwd(), 'supabase', 'baseline', 'schema.sql'), 'utf8')

// A minimum viable file that passes every check, so each mutation below changes exactly
// one thing. Built from the shape of the real file, not from its contents.
function wellFormed(): string {
  const tables = Array.from({ length: 12 }, (_, i) => `CREATE TABLE public.t${i} (id int);`)
  const funcs = Array.from({ length: 12 }, (_, i) => `CREATE OR REPLACE FUNCTION public.f${i}() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;`)
  return [
    'CREATE SEQUENCE public.s_id_seq;',
    ...tables,
    'ALTER SEQUENCE public.s_id_seq OWNED BY public.t0.id;',
    'SET check_function_bodies = off;',
    ...funcs,
    'RESET check_function_bodies;',
    'CREATE TRIGGER t_set_updated_at BEFORE UPDATE ON public.t0 FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
    'DO $baseline$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'supabase_functions') THEN",
    '    EXECUTE $trigger$CREATE TRIGGER "w" AFTER INSERT ON public.t0 FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request($trigger$;',
    '  END IF;',
    'END',
    '$baseline$;',
  ].join('\n')
}

describe('restore invariants', () => {
  it('the committed baseline passes all four', () => {
    expect(checkRestoreInvariants(baseline)).toEqual([])
  })

  it('the fixture itself passes, so each mutation below isolates one property', () => {
    expect(checkRestoreInvariants(wellFormed())).toEqual([])
  })

  // ── one mutation per fix, each of which was a real restore failure ──

  it('catches sequence ownership emitted before the tables (42P01)', () => {
    const sql = wellFormed()
      .replace('ALTER SEQUENCE public.s_id_seq OWNED BY public.t0.id;\n', '')
      .replace('CREATE SEQUENCE public.s_id_seq;', 'CREATE SEQUENCE public.s_id_seq;\nALTER SEQUENCE public.s_id_seq OWNED BY public.t0.id;')
    expect(checkRestoreInvariants(sql).join(' ')).toMatch(/42P01/)
  })

  it('catches the functions section losing its check_function_bodies bracket (42883)', () => {
    const sql = wellFormed().replace('SET check_function_bodies = off;\n', '')
    expect(checkRestoreInvariants(sql).join(' ')).toMatch(/42883/)
  })

  it('catches an unguarded supabase_functions trigger (3F000)', () => {
    const sql = wellFormed().replace(
      /DO \$baseline\$[\s\S]*\$baseline\$;/,
      'CREATE TRIGGER "w" AFTER INSERT ON public.t0 FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request();'
    )
    expect(checkRestoreInvariants(sql).join(' ')).toMatch(/3F000/)
  })

  it('catches a secret', () => {
    const sql = wellFormed() + "\n-- token: " + 'a'.repeat(64) + "\n"
    expect(checkRestoreInvariants(sql).join(' ')).toMatch(/hex/)
  })

  // The guard on the guard. Three of the four checks are "every X comes after Y", which
  // pass over a file containing no X. An empty baseline must therefore FAIL, not pass.
  it('fails on an empty or truncated file rather than passing vacuously', () => {
    expect(checkRestoreInvariants('').join(' ')).toMatch(/empty or truncated/)
    expect(checkRestoreInvariants('CREATE TABLE public.t0 (id int);').join(' ')).toMatch(/empty or truncated/)
  })
})
