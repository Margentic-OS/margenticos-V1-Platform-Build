# sourcing-specification-gates.md
# The two checks that ask whether sourcing is returning what the client asked for.
# Built 2026-08-27. Neither fixes anything. Both make an existing silence audible.

## What problem these solve

The Apollo search query is hardcoded (see adapter-apollo.ts, and ADR-032). Every client
sourced through that handler gets the same NAICS 5416 consulting filter, whatever their ICP
says. That is a conscious trade-off while MargenticOS runs as client zero, and it is not
what these gates change.

What they change is that the trade-off used to be **invisible at run time**. A client whose
ICP named schools would have been handed management consultancies with no error, no warning,
and a run recorded in `agent_runs` as `completed`. The orchestrator's manifest check (step 4)
did not catch it, because it asks whether the handler SUPPORTS a filter field, not whether
the query it actually sends has anything to do with what the client asked for.

## The two gates, and why there are two

They answer different questions and neither substitutes for the other.

| | Pre-search gate | Returned-industry assertion |
|---|---|---|
| Where | `orchestrator.ts`, step 4.5 | `tiering-trigger.ts`, step 6.5 |
| When | Before the handler is called | After enrichment, during tiering |
| Asks | Does the query ASK FOR anything this ICP wants? | Did the rows that CAME BACK match? |
| Reads | `spec.industries` vs `handler.targeted_industries` | `prospects.company_industry` mapped to canonical, vs `spec.industries` |
| Cost when it fires | None. Apollo is never called. | Enrichment has already been paid for. |

**Why the pre-search one is not enough.** It proves what we asked for, not what arrived.
Apollo silently ignores a parameter it does not recognise, so a filter that reads correctly
and passes this gate can still return an unfiltered result: a parameter that stopped being
honoured looks exactly like one that never existed. That failure is only visible in the rows.

**Why the post-enrichment one cannot move earlier.** Sourcing candidates carry no industry.
Apollo's free `mixed_people/api_search` response carries `has_industry` as a boolean and
never the value (verified against the live API 2026-08-23, see BACKLOG), and the orchestrator
writes `company_industry` as NULL with a comment saying enrichment will fill it. The value
first exists after `people/match` at enrichment time. There is nothing to check before that.

## What each one does when it fires

**Pre-search gate.** Throws. `runSourcing` never throws to its caller, so the refusal comes
back as `result.error` and is written to `agent_runs` as `failed`. The message names the
industries the ICP asked for, the industries the handler targets, and the fact that the query
is hardcoded so editing the ICP will not fix it.

It does NOT fire on partial coverage: if even one spec industry is targeted, the run
proceeds, and the unreachable ones are logged at `warn` by name. It does NOT fire when
`spec.industries` is empty, because an empty list is the spec declining to constrain industry
rather than disagreeing with the query. That case logs a `warn` too.

**Returned-industry assertion.** Throws after the prospects have been written with their
tiers, so there is no partial state: the rows keep their `sourced_tier` and `tiering_reason`,
and the run is marked failed with a message naming what the ICP asked for and what the batch
actually came back as, counted by industry.

There is deliberately **no minimum batch size**. A batch of one off-specification prospect
fails the run. A threshold would be a number nobody has measured, and a check that stays
quiet below an invented floor is the shape this work exists to remove.

## Where the handler's targeting is declared

`APOLLO_TARGETED_INDUSTRIES` in `adapter-apollo.ts`, exported, and copied onto the handler
object as `targeted_industries`. The orchestrator READS it rather than keeping a second copy:
two lists that must be kept in step by hand is the parallel-array shape CLAUDE.md warns about.

It is typed `readonly CanonicalIndustry[]`, so a name outside the canonical taxonomy is a
compile error rather than a silently empty intersection at run time.

`SourcingHandler.targeted_industries` is REQUIRED, not optional. Optional would let a new
handler skip the gate by omission, which is the silent default this field exists to close.

## What to check if it breaks

- **Sourcing suddenly refuses for a client that used to work.** Compare the two lists in the
  error message. Either the ICP gained an industry outside NAICS 5416, or `APOLLO_FILTER`
  changed and `APOLLO_TARGETED_INDUSTRIES` was not updated with it. They live in the same
  file, next to each other, for exactly this reason.
- **Tiering suddenly fails with "nothing on specification".** Read `returned_industries` in
  the error log line. If it is full of `(unmapped) <tag>` entries, the problem is
  `APOLLO_TO_SPEC` in `industry-mapping.ts` not knowing a tag, not the sourcing query. If it
  is full of genuinely off-target industries, a search parameter has stopped being honoured.
- **Neither ever fires and you expect one to.** Both gates skip when `spec.industries` is
  empty. Check the stored `icp_filter_spec` first.

## Related

- `docs/dashboard.md`, "Operator quality review", for the removal counts on screen.
- `docs/BACKLOG.md`, "Silent sourcing defaults are now loud", for what was found and left.
- ADR-032 (sourcing filter hardcoded in the handler), ADR-036 (the 5-20 headcount band).
