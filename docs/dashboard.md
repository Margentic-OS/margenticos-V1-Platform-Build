# dashboard.md — Dashboard Reference
# Partial. Update as each view is built.
# Cover: all views, what each shows, why, what to check if a view breaks.
# The spec is in /prd/sections/12-dashboard.md. Design tokens in /docs/design.md.

## Views built

This section is incomplete. It records only the views documented so far, not every view that
exists.

### Operator pipeline review — /dashboard/operator/sourcing-review

What it shows: one card per active organisation with the prospect counts at each pipeline
stage, and the controls that move a client through it. Archived organisations are not
listed.

Controls on each card, in pipeline order:

| Control | What it does | Cost |
|---|---|---|
| Source prospects | Runs the sourcing orchestrator for that organisation. Batch size is typed in, capped at 500. | Apollo credits |
| Research N prospects | Researches prospects that have never been researched. Reuses findings already on file where they exist. | Anthropic API, plus four data sources for any prospect with nothing on file |
| Review pending | Links to the approval queue | none |
| Enrich and tier batch | Existing control, unchanged | Apollo credits |
| Review quality | Links to the tiered review | none |

Both new controls block on a single request and show the result when it finishes. There is
no progress bar, which matches the send path: the operator sees a working state, then one
structured result. A batch too large to finish in time is refused up front with an error
naming the real limit, so nothing is ever silently truncated.

The research control only ever offers the `unresearched` scope. Re-running a prospect that
already has a personalisation trigger rewrites that copy, or clears it when the judge holds,
so there is deliberately no dashboard control that asks for it. See agents.md, "The guard on
finished copy".

What to check if it breaks:
- The counts come from one query per organisation in `page.tsx`. `unresearched_count` counts
  prospects with `current_research_result_id` null and `suppressed` false, which is exactly
  what the research entry point selects. If the button count and the run disagree, those two
  definitions have drifted.
- A refusal renders as a red message under the button. It is the entry point's own error
  text and says why.
- `PipelineOverview` is a client component. It must not import from
  `src/lib/operator/sourcing-entry.ts`, which would pull the orchestrator, the Apollo
  handler and the service-role client into the browser bundle. The batch-size cap is passed
  down as a prop from the server page for that reason.

## View inventory (to be built)
- Empty state view (months 1–2 default)
- Client pipeline view (post-unlock)
- Operator view
- Strategy document view
- Approvals view

## Phased unlock reminder
Pipeline view locked until: 2 months elapsed OR 5 meetings booked (whichever first).
Controlled by organisations.pipeline_unlocked field.
