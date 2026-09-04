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
  // Cron schedule drift, added 2026-09-03. Structural, like MON-022 and MON-024.
  //
  // Nothing in this platform read cron.job.schedule until now. A job moved by hand with
  // cron.alter_job keeps running and keeps its heartbeat fresh, so MON-002 stays green
  // while the job runs at a fraction of its intended rate, and a later replay of its
  // migration silently reverts it. Measured on verify-catch-all, 2026-09-01 to 2026-09-03.
  //
  // Its declared side lives in cron_schedule_registry, which is itself held to the
  // migration files by cron-schedule-registry.test.ts. Removing either half leaves the
  // other unable to see its class of drift.
  ['MON-025', 'mon_025'],
  // Suppression reaching the provider, added 2026-09-04. Unlike every monitor above it,
  // mon_026's subject is OUTSIDE this database: whether the sending tool has actually
  // stopped. A view cannot make an HTTP call, so the sweep computes the verdict and the
  // view checks it is fresh and green, which is MON-023's shape.
  //
  // It is deliberately not derived from prospects.outbound_suppression_status. The failure
  // it was built for was a hand-written UPDATE, which leaves that column NULL, and auditing
  // our own writes with our own columns is how a check goes green over the thing it was
  // written to find.
  ['MON-026', 'mon_026'],
  // The reply poller's own state, added 2026-09-04. polling_cursors.error_count and
  // last_error were written by the poller and read by NOTHING for the life of the system:
  // zero of the 23 mon_* views touched that table, and the only reader in src/ was the
  // poller's own getCursor, which reads last_cursor alone.
  //
  // It ships in the same commit as the cursor-hold change in pollInstantlyReplies, and that
  // is not a coincidence. Holding the cursor turns a silent lost reply into a visible stall,
  // which is only an improvement if something can see the stall. This is that something.
  ['MON-027', 'mon_027'],
  // A reply draft nobody has actioned, added 2026-09-04. MON-014 and MON-015 both look
  // adjacent and both watch a FAILURE; a draft waiting on a person has not failed, so both
  // stayed green while one sat at manual_required for two days. Its threshold lives in
  // reply_draft_ageing_config, one default row plus per-client overrides, and the view
  // reports UNKNOWN if the default row is missing rather than passing vacuously.
  ['MON-028', 'mon_028'],
  // Replies reconciled against the provider, added 2026-09-04. The only check here that
  // catches a lost reply POSITIVELY rather than inferring it from an error flag the next
  // run overwrites. MON-023's stored-verdict shape, because the comparison needs an HTTP
  // call and a view cannot make one.
  ['MON-029', 'mon_029'],
] as const
