// The monitor registry for /api/cron/monitor-sweep.
//
// SEPARATE MODULE because a Next.js route file may only export route handlers and a
// fixed set of config names. Exporting the registry from route.ts fails the type check,
// and the registry has to be importable so its tests can read it.

/**
 * Every monitor this sweep reads, as CODE-TO-VIEW PAIRS.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THIS WAS TWO PARALLEL ARRAYS, AND THEY DRIFTED. TWICE.
 *
 * checkCodes held 16 entries and viewNames held 17, and the loop was bounded by
 * `i < checkCodes.length`. So viewNames[16], 'mon_019', WAS NEVER READ.
 *
 * That is the exact defect commit 89ac57b set out to fix. It added 'mon_019' to viewNames
 * and did not add 'MON-019' to checkCodes, so the fix silently did nothing and the message
 * "so something actually reads the verification sweep's heartbeat" was wrong. Verified live
 * 2026-08-25: the sweep had written 8 heartbeats, the mon_019 view returned OK, and
 * monitor_events held ZERO rows for MON-019.
 *
 * A monitor whose view is never queried is worse than no monitor. The operator dashboard
 * shows a check that exists and is silent, which reads as healthy.
 *
 * Pairs make the drift impossible to express: there is no way to add a view without also
 * naming its code, and no index arithmetic to get wrong. monitor-sweep-pairs.test.ts
 * asserts every pair is well formed and that no mon_NNN view is orphaned.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export const MONITORS: ReadonlyArray<readonly [checkCode: string, viewName: string]> = [
  ['MON-001', 'mon_001'],
  ['MON-002', 'mon_002'],
  ['MON-003', 'mon_003'],
  ['MON-004', 'mon_004'],
  ['MON-005', 'mon_005'],
  ['MON-006', 'mon_006'],
  // MON-007 REMOVED 2026-09-03. It watched the strategy-doc-auto-approve cron, which is
  // unscheduled because client approval on strategy documents is gone (ADR-047). A
  // monitor whose subject no longer exists reports PROBLEM for ever and teaches the
  // operator to ignore the board. The view and its monitor_checks row are dropped in
  // 20260903100500_retire_strategy_doc_auto_approve.sql, in this same commit.
  //
  // The pair-list test below cannot catch a mistake here: it fails when a mon_NNN view
  // CREATED BY A MIGRATION is missing from this list, and mon_007 was created in the
  // baseline. Keeping both halves in one commit is what protects this.
  ['MON-010', 'mon_010'],
  ['MON-011', 'mon_011'],
  ['MON-012', 'mon_012'],
  ['MON-013', 'mon_013'],
  ['MON-014', 'mon_014'],
  ['MON-015', 'mon_015'],
  ['MON-016', 'mon_016'],
  ['MON-017', 'mon_017'],
  ['MON-018', 'mon_018'],
  ['MON-019', 'mon_019'],
  ['MON-020', 'mon_020'],
  // The batch research path, added 2026-08-26.
  //   MON-021 operational: is the sweep running, are batches moving, are entries failing
  //   MON-022 structural:  do the guarantees the path depends on still exist in the catalog
  // Two monitors rather than one because the remedies differ. MON-021 red means check
  // Anthropic and the sweep; MON-022 red means a migration removed a safety guarantee and
  // nothing has broken yet.
  ['MON-021', 'mon_021'],
  ['MON-022', 'mon_022'],
  // Per-domain sending health, added 2026-08-27. Unlike every monitor above it, mon_023
  // does NOT compute its own thresholds: it reads a verdict written by the instantly-poll
  // cron and checks that verdict is still fresh. The thresholds live in
  // src/lib/sending-health/ so vitest can reach them without a database, which no view
  // can offer. MON-016 already reads a stored verdict, so the sweep needs no special case.
  ['MON-023', 'mon_023'],
  // Privilege audit, added 2026-08-27. Structural like MON-022, and for the same reason:
  // the check it replaces lived in CLAUDE.md and ran only when someone remembered it,
  // which is how a writable client-facing view passed review twice. It reads all eight
  // table privileges for anon and authenticated across tables, views and matviews.
  ['MON-024', 'mon_024'],
] as const
