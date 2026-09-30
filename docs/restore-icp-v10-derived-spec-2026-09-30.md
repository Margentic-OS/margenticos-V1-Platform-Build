# Restore: ICP v10's derived search settings replaced with v9's (2026-09-30)

A one-off production data fix, done by hand. No code changed. This file exists so the
next person who finds v10 carrying a spec derived on 2026-09-24 knows why.

## What happened

Organisation `0ed34697-0fa9-4f08-ac15-d3504ac45caf` approved ICP v10
(`4dcfc841-d7ba-4d43-aef5-78ccecd51749`) at 17:59 UTC, replacing v9
(`36a360cd-25a0-42bc-a5fa-fd4464b0b40e`).

The edit changed two tier 1 trigger reasons and nothing else. Measured by a path-by-path
diff of the two `content` bodies: 215 leaves, 2 differ, both `tier_1.triggers[n].reason`.

Approval re-derives the whole filter spec anyway (`persistIcpFilterSpec`), and the
re-derivation is a model call, so it came back different from unchanged inputs:

| Field | v9 | v10 as derived |
|---|---|---|
| `job_titles` (sent as `person_titles`) | 13 | 14, adds `co-founder` |
| `seniority_levels` (sent as `person_seniorities`) | 7 | 8, adds `senior` |
| `job_titles_excluded` (post-filter, not sent) | includes `office of the`, `assistant director` | swaps them for `office of the ceo`, `director of operations` |
| `buyer_criterion.accept` | 13 fragments | 14, adds `co-founder` (primary) |
| `buyer_criterion.reject` | as excluded titles above | as excluded titles above |
| `buyer_criterion.status` | `derived` (gates) | `out_of_band`, 197 of 206 sampled titles accepted (95.6%), so it did NOT gate |
| `fit_dimensions` | key `consulting_industry` | key renamed `b2b_consulting_industry`; one statement reworded |
| `notes`, `omission_reasons` | prose | prose reworded |

Industries, keywords, company and person countries, headcount and the omitted revenue
band were identical.

## What was done, 2026-09-30, about 19:50 UTC

1. The v10 spec, as it stood, was saved byte-exact (12,940 bytes) as an attachment on the
   Notion Backlog row "ICP approval re-derives the Apollo filter spec even when no
   targeting field changed". Writing it back onto the v10 row reverses step 2.
2. `strategy_documents.icp_filter_spec` on v10 was set to v9's, as one guarded UPDATE
   that applied only if v10 was still active, still had 14 titles and was still
   `out_of_band`. v10's `content` was not touched.
3. `sourcing_cursors` for the organisation was re-keyed from v9 to v10 with
   `record_offset` kept at 500, guarded on the old document id and offset. The search is
   now identical to v9's, so the position is still valid. Without this, the next run
   would have reset to 0.

Read back afterwards: v10 spec equals v9 spec (jsonb equality), 13 titles, no `senior`, no
`co-founder`, criterion `derived`; v9 unchanged and archived; v10 content differs from
v9's as before; one active ICP; cursor `4dcfc841… @ 500`. No sourcing run or job had
happened between the approval and the restore.

## The 62 prospects removed at 18:04 (not undone by the restore)

At 18:04 UTC, before the restore, a tiering pass ran against v10's spec and removed 62
prospects with `tiering_reason = 'no_buyer_criterion'`, because v10's criterion was
out of band. The approval had first re-queued them (ADR-037). A tiering verdict is frozen
on the row, so restoring the spec does not bring them back. Re-tiering them against the
restored spec means clearing `tiering_reason` on exactly those rows.

Note the timing. The approval re-queued removed prospects, and the scheduled
`verify-pending` pass, which tiers before verifying and runs every 10 minutes, tiered them
against the drifted spec about five minutes later. So a drifted re-derivation acts on
prospects already in the database, not only on future searches.

## Re-tier, 2026-09-30 (operator decision)

Recorded in the Notion Decisions Log as a correction of a system fault, not a reversal of
a deliberate removal: ADR-037 freezes a verdict so that a deliberate removal stands until
the rule changes, and these 62 were removed by a spec nobody chose.

`tiering_reason` was cleared on exactly those 62 rows, in one block that aborted unless the
restored spec was live and exactly 62 rows matched (reason `no_buyer_criterion`, no tier,
enriched, updated 18:04:03 to 18:04:06 UTC). No other prospect in the organisation was
waiting for tiering, so the next scheduled pass (20:24 UTC) touched only these.

| Outcome against the restored spec | Count |
|---|---|
| Passed (given a tier) | 0 |
| Failed: `industry_off_target` | 47 |
| Failed: `not_decision_maker` | 14 |
| Failed: `company_too_large` | 1 |
| Changed tier | 0 (untiered before and after) |

Tiering makes no model calls, and none of the 62 went on to verification, so the
correction cost nothing beyond the pass itself. The fault did not lose any prospect who
would have passed. What it did was replace their real removal reasons with the wrong one.

## Stopgap

This is the stopgap until the Backlog row above is decided: re-derive only when a
targeting field changed, and show the operator a diff of the search settings before an
approval takes effect. Until then, any ICP approval can do this again.
